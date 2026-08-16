# DSH Desktop Windows packaging guide

This document describes how to build a complete Windows x64 NSIS installer from the
`deepseek-harness-desktop` repository (v2 desktop line). The flow was verified end to end
on a native Windows host (Node 22.22.2 / Corepack / Yarn 4.18.0): **a single
`corepack yarn dist:win` command produces an installable unsigned installer**, and the
whole pipeline — build, tests, packaging, verification — is headless-safe (never launches
a GUI).

> Chinese version: [packaging-windows.zh.md](packaging-windows.zh.md).

---

## 1. Target artifacts

| Artifact | Path (relative to repo root) | Notes |
| --- | --- | --- |
| NSIS installer | `dsh-plugin-desktop/dist/DSH-Desktop-<version>-x64-Setup.exe` | ~140 MB, assisted installer (custom directory, Start Menu/desktop shortcuts), **unsigned** |
| Unpacked app | `dsh-plugin-desktop/dist/win-unpacked/DSH Desktop.exe` | Smoke-test entry point, not produced by the installer |
| Update metadata | `dsh-plugin-desktop/dist/DSH-Desktop-<version>-x64-Setup.exe.blockmap`, `dist/latest.yml` | Consumed by the in-app update channel (sha512/size/version) |

`<version>` is taken from `version` in `dsh-plugin-desktop/package.json` (currently `2.0.0`).

---

## 2. Prerequisites

- **Native Windows x64 host**. `dist:win` refuses non-Windows / non-x64 hosts up front
  (`scripts/package-win.ts` host checks).
- **Node.js 22.19+ or 24.x** (official distributions bundle Corepack). CI and the README
  recommend `22.23.2`.
- **Git** (for a checkout that includes the submodule).
- **Network**: the npm registry must be reachable. The Electron 43.4.0 zip and NSIS build
  tools are served from local caches first
  (`%LOCALAPPDATA%\electron\Cache`, `%LOCALAPPDATA%\electron-builder\Cache`, the Yarn
  cache); with a warm cache the packaging also works when GitHub itself is unreachable
  (verified locally).
- **No** Python or Visual Studio C++ Build Tools: the Windows build uses node-pty's
  bundled x64 Node-API binaries and Electron Builder runs with `npmRebuild=false`.

---

## 3. Packaging steps (fresh checkout)

```powershell
# 1) Checkout (with submodules; deepseek-harness is a pinned upstream and is not built)
git clone --recurse-submodules <repo-url>
cd deepseek-harness-desktop

# 2) Install workspace dependencies (dsh-plugin-desktop is the only Yarn workspace)
corepack yarn install

# 3) Package (all gates + electron-builder + artifact verification)
corepack yarn dist:win
```

`dist:win` runs three stages in order (implemented in `scripts/package-win.ts`):

1. **Gate** `corepack yarn workspace dsh-plugin-desktop check:win-package`
   - `build`: generate icons → clean → tsdown bundles `lib/**` → declaration emit for two
     tsconfigs.
   - `typecheck`: four tsconfigs (main / client / tests / client tests) with `--noEmit`.
   - Windows-focused vitest: `package`, `package-win`, `update-checker`,
     `update-download`, `verify-win-installer`, `verify-packaged-runtime`,
     `windows-pwsh-sandbox`, `window-options` — 8 files (verified run: 101 passed /
     1 skipped), all mocked / loopback, no external network.
   - `verify:closure`: runtime closure check (verified run: 197 first-party nodes form a
     closed reachable graph).
2. **electron-builder** `--win nsis --x64 --publish never --config.win.signExecutable=false --config.npmRebuild=false`
   - The `afterPack` hook `scripts/verify-packaged-runtime.ts` verifies the required
     `app.asar` entries (`lib/main.js`, the `@deepseek-ai/dsh` CLI bootstrap,
     `dsh-web-frontend/dist/index.html`, the bundled `pnpm`, …) and the physical
     `app.asar.unpacked` entries (including
     `node_modules/node-pty/prebuilds/win32-x64/*` and `pnpm/bin/pnpm.mjs`).
   - Applies `@electron/fuses` and writes the asar integrity resource.
3. **Artifact verification** `scripts/verify-win-installer.ts`: checks the Windows PE
   header (MZ magic + PE signature) of the installer and the unpacked executable, then
   prints `Windows installer verification passed: ...`.

Any failing stage aborts the run with a non-zero exit code.

---

## 4. Common issues and pitfalls

### 4.1 electron postinstall skipped (stale install state)
Symptom: `yarn install` succeeds but
`dsh-plugin-desktop/node_modules/electron/dist/electron.exe` is missing (no `path.txt`),
and `electron-builder` re-downloads or fails later.

Cause: a stale `.yarn/install-state.gz` (in the repo's `.yarn` directory) records
electron/esbuild as already built, so Yarn skips their postinstall scripts (while
node-pty, koffi, … are rebuilt).

Fix (either):
```powershell
# Option A: remove the stale state and reinstall
Remove-Item .yarn\install-state.gz -Force
corepack yarn install

# Option B: run electron's install script manually (zip is already cached locally)
& node "dsh-plugin-desktop\node_modules\electron\install.js"
# Verify
Test-Path "dsh-plugin-desktop\node_modules\electron\dist\electron.exe"
```
A fresh checkout (no leftover `.yarn` state) does not hit this.

### 4.2 Artifacts are unsigned (by design)
`dist:win` strips `CSC_*` / `WIN_CSC_*` certificate variables and sets
`signExecutable=false`. The installer installs and runs normally, but Windows may show an
"Unknown publisher" / SmartScreen warning. **Authenticode signing, SmartScreen
reputation, upgrade/uninstall testing, and native UI/sandbox smoke tests are release
gates, not part of the local packaging flow.**

### 4.3 Version number
The artifact name and the `version` in `latest.yml` come from `version` in
`dsh-plugin-desktop/package.json`. Bump it before each release. Note:
- The package version is independent of the in-app update check
  (`deepseek-harness-desktop:release:version`);
- To publish an update, upload both Windows and macOS artifacts first, then set
  `deepseek-harness-desktop:release:version` to the canonical stable version in Upstash
  Redis so clients are prompted.

### 4.4 PowerShell redirection and exit codes
`corepack yarn dist:win 2>&1 | Out-String` wraps native stderr into error records and can
make a successful run look like exit code 1. Judge success by:
```powershell
corepack yarn dist:win *> "$env:TEMP\dsh-dist-win.log"; $LASTEXITCODE
# expected: 0
```
Trust `$LASTEXITCODE` and the artifact files, not the wrapped pipeline exit code.

### 4.5 Submodule vs. packaging
`deepseek-harness/` is a pinned upstream submodule and is **not built during packaging**;
all `@deepseek-ai/*` dependencies come from the npm registry (`0.1.0-rc.6` family). Only
upstream development (`upstream:install` / `upstream:build`) enters that submodule and
uses its own pnpm workspace.

### 4.6 Upgrade detection: can a newer installer recognize and update an existing install? — Yes
**As long as `build.appId` never changes, installers of any later version recognize an
installed DSH Desktop and upgrade it in place, keeping the installation directory and user
data.** This is deterministic electron-builder NSIS behavior, verified below against this
repo's build and the local registry:

1. **Deterministic GUID**: the installer GUID is `UUID.v5(appId, "50e065bc-3134-11e6-9bab-38c9862bdaf3")`
   — independent of version. With `appId = ai.deepseek.dsh.desktop` the GUID is always
   `85820364-4c28-594e-b046-8896b3669248` (recomputed with Node and confirmed).
2. **Where the old install records itself**: on install, electron-builder writes
   `InstallLocation`/`ShortcutName` to `HKCU\Software\<APP_GUID>` (per-user) or the HKLM
   counterpart, plus a standard uninstall entry under
   `HKCU/HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall\<GUID>`. On this machine
   the installed 2.0.0 lives at `HKCU:\Software\85820364-4c28-594e-b046-8896b3669248`
   (`InstallLocation = D:\DeepseekharnessDesktop\DSH Desktop`).
3. **What a new installer does**: `assistedInstaller.nsh` reads `InstallLocation` under the
   same GUID key and preselects the old directory; `installUtil.nsh` reads the old
   `UninstallString` and runs the previous uninstaller first; then the new files are
   written in place. `DisplayVersion` and shortcuts are updated.
4. **In-app update handoff**: `src/electron-runtime.ts` launches the downloaded installer
   with `--updated --force-run` (the generated NSIS script defines the matching
   `isUpdated`/`isForceRun` parameter macros built into the NSIS template); the app asks
   for orderly teardown and exits before the installer takes over.
5. **User data untouched**: user data lives in `%APPDATA%\DSH Desktop`, not the install
   directory; neither upgrade nor uninstall touches it (the README states uninstall
   preserves user data; `%APPDATA%\DSH Desktop` exists on this machine).

**Red lines (must never change, or upgrades break)**:
- `build.appId` must stay constant (electron-builder explicitly warns that changing the
  appId breaks silent upgrades of existing installs);
- keep `productName = "DSH Desktop"` and `shortcutName` stable;
- bump `version` monotonically for releases (the in-app updater only accepts canonical,
  strictly newer stable versions).

---

## 5. Repackaging SOP after code changes (for follow-up agents)

1. **Sync code**
   ```powershell
   git pull
   git submodule update --init --recursive   # if the submodule pin changed
   ```
2. **Sync dependencies** (use `--immutable` when the lockfile is unchanged)
   ```powershell
   corepack yarn install --immutable   # drop --immutable if the lockfile must update
   ```
   If this fails or the electron binary is missing, follow §4.1.
3. **Confirm / bump the version** (release scenarios)
   Edit `version` in `dsh-plugin-desktop/package.json`; keep changelog/release notes in
   sync.
4. **Package**
   ```powershell
   corepack yarn dist:win
   ```
   Wait for all three stages (gate → electron-builder → artifact verification).
5. **Verify artifacts**
   - `dsh-plugin-desktop/dist/DSH-Desktop-<version>-x64-Setup.exe` exists, ~140 MB;
   - `dist/win-unpacked/DSH Desktop.exe` exists;
   - `dist/latest.yml` `version` and `size` match this build;
   - the pipeline ends with `Windows installer verification passed`.
6. **(Release stage, not local)** Sign → upload Windows/macOS artifacts and download
   redirects → set `deepseek-harness-desktop:release:version` → smoke-test
   install/upgrade/uninstall and native UI/sandbox on real hardware.

> Constraint reminder: build, test, and packaging must stay headless-safe (never launch a
> GUI); GUI smoke tests must be explicit and run in a separate, human-controlled step.