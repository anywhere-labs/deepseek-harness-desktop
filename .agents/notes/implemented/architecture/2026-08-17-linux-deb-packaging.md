# Agent Note: Linux amd64 deb packaging

Status: implemented

English | [中文](2026-08-17-linux-deb-packaging.zh.md)

## Problem

Windows ships a one-click NSIS installer (`dist:win`) and macOS a DMG (`dist:mac-smoke` / `dist:mac`), but Linux only had an unpacked `dir` target and `docs/faq.md` stated that no Linux installer existed. Users on Debian/Ubuntu had no one-click installation path even though the desktop already runs on Linux in compatibility mode.

## Decision

Add an unsigned amd64 deb target that follows the same native-host packaging pattern as Windows and macOS. `dsh-plugin-desktop/scripts/package-linux.ts` (`packageLinuxDeb`) runs the complete product gate, then invokes Electron Builder with `--linux deb --x64 --publish never --config.npmRebuild=false` into a dedicated `dist/linux/` output, then runs `scripts/verify-linux-package.ts` (`verifyLinuxPackage`) to confirm the deb archive header and the unpacked ELF executable. The root `dist:linux` script wires the Market build before the Desktop package, mirroring `dist:win` and `dist:mac-smoke`.

The `build.linux` block switches from `target: ["dir"]` to `target: ["deb"]` with a fixed `executableName: "dsh-desktop"` (so verification and the desktop entry are deterministic), a stable `artifactName` (`DSH-Desktop-${version}-${arch}.${ext}` → `DSH-Desktop-<version>-amd64.deb`), and explicit deb metadata (`maintainer`, `synopsis`, `description`, `category: Development`). Linux supports compatibility mode only, and the existing login-shell `PATH` recovery and layered launch-environment snapshot already cover packaged Linux launches, so no runtime change is needed.

The runtime closure gate `scripts/verify-packaged-runtime.ts` already handled the `linux` platform for its generic entries; it now additionally requires the source-built node-pty binary `node_modules/node-pty/build/Release/pty.node`. Unlike Windows and macOS, node-pty ships no `linux-x64` prebuild and its loader checks `build/Release/pty.node` first, so a Linux package must carry the binary built during `yarn install` (`node-pty` is `built: true` in the root `dependenciesMeta`). `spawn-helper` is built only on macOS and is not required on Linux.

Electron Builder copies `node_modules` through a dedicated matcher that applies only `!` exclude patterns, so a positive `files` pattern cannot restore an excluded file. The global `files` list therefore no longer excludes `node_modules/node-pty/build/**`; that `!` exclusion moved into the `mac.files` and `win.files` platform blocks. Windows and macOS keep their exact prior behavior (they load node-pty prebuilds, and host-architecture build output stays out of the universal macOS gate), while Linux ships the source-built binary its loader requires. koffi, sharp, and node-addon-require-builtin ship their own linux-x64 optional dependencies and are resolved by the ordinary install; they are not added to the closure list to avoid guessing package-layout paths.

The package also sets a top-level `desktopName` (`DSH Desktop`) and `build.linux.syncDesktopName: true` so Electron's WM_CLASS matches the `.desktop` entry's `StartupWMClass`, letting desktop environments dock running windows to the launcher icon. This resolves Electron Builder's `desktopName` warning for the deb target.

## Alternatives considered

**Ship an AppImage instead of a deb.** AppImage needs no install step but is less native for Debian/Ubuntu users and adds a second artifact and gate. The user scoped this change to deb only; AppImage, rpm, and snap remain out of scope.

**Rely on `yarn package:dir` alone.** The unpacked directory is a valid run method and stays documented, but it is not a one-click install and gives users no desktop entry or package-manager integration.

**Sign the deb.** Electron Builder deb signing (debsigs) would require release-only credentials; like the Windows installer and macOS smoke, the deb is unsigned and documented as such.

## Consequences

Debian/Ubuntu users can install with `sudo dpkg -i DSH-Desktop-<version>-amd64.deb` and launch `dsh-desktop` from the app menu; the unpacked `dist/linux/linux-unpacked/dsh-desktop` path remains as a no-install run method. `package-linux.spec.ts` and `verify-linux-package.spec.ts` assert the exact command sequence and artifact verification, and the CI `desktop-linux` job builds the deb on the main ubuntu runner so packaging regressions fail before release. The artifact is amd64 only, matching the Windows x64 installer; arm64 and other packaging formats are follow-ups.
