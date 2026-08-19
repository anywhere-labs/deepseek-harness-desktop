# Agent Note: Linux packages install the `dsh` command

Status: implemented

English | [中文](2026-08-19-linux-deb-dsh-command.zh.md)

## Problem

After installing the deb (or rpm), the desktop launches from
`/opt/DSH Desktop/dsh-desktop` and the `.desktop` entry, but a terminal `dsh` fails
with "command not found" — the shell even suggests the unrelated Debian `dsh`
(dancer's-shell) package. The Desktop already publishes a canonical `dsh` command on
Windows (`desktop-runtime-environment.ts` → `windowsDshShim`) and inside the DSH
Terminal (`desktop-terminal.ts`), but the Linux system package exposed no equivalent.

## Decision

The deb and rpm (which share the same fpm scripts) now install a system-wide
`/usr/bin/dsh` command. It is a symlink to a self-locating shim shipped inside the
app directory at `/opt/DSH Desktop/dsh`, and it dispatches the bundled DeepSeek
Harness CLI (`@deepseek-ai/dsh/lib/bin.js`) through the packaged Electron binary in
Node mode — the same RunAsNode contract the Windows shim and DSH Terminal use:

```sh
ELECTRON_RUN_AS_NODE=1 /opt/DSH\ Desktop/dsh-desktop \
  --expose-internals /opt/DSH\ Desktop/resources/app.asar/lib/desktop-cli.js "$@"
```

`desktop-cli.js` (`src/desktop-cli.ts`) clears `ELECTRON_RUN_AS_NODE` before importing
the upstream CLI, applies the terminal-owned default profile only when the caller
supplies `DSH_DESKTOP_DEFAULT_PROFILE`, and otherwise preserves ordinary `dsh`
behavior (`--version`, `plugin`, `web`, ...). `scripts/verify-cli-runtime.mjs`
already exercises this dispatch against the dev tree.

### Wiring

- `build/linux/dsh` — a POSIX shim that resolves its own directory with
  `readlink -f "$0"`, so it works regardless of the install prefix and needs no
  build-time path interpolation. It prepends the app-local `bin/` directory to
  `PATH`, then dispatches the bundled DeepSeek Harness CLI through the packaged
  Electron runtime in Node mode.
- `build/linux/bin/pnpm` / `build/linux/bin/node` / `build/linux/bin/clear-env.mjs`
  — self-locating POSIX shims (plus the RunAsNode-clearing preloader) that make the
  bundled pnpm and Node available to the `dsh` process tree, mirroring the desktop's
  generated pnpm runtime (`desktop-runtime-environment.ts`). `dsh plugin` forwards to
  `pnpm` on `PATH`, so the packaged pnpm (`resources/app.asar.unpacked/node_modules/pnpm`)
  runs through the packaged Electron binary with Electron-native-build settings
  (`npm_config_runtime/target/disturl`, electron version resolved at runtime).
- `build/linux/after-install.tpl` / `after-remove.tpl` — copies of the pinned
  Electron Builder 26.15.7 Linux templates (launcher symlink / update-alternatives,
  chrome-sandbox perms, mime/desktop DB refresh, AppArmor profile) plus one block
  that creates/removes the `/usr/bin/dsh` symlink. Templates are rendered by
  Electron Builder's `writeConfigFile` (`${executable}`, `${sanitizedProductName}`).
- `build.linux` in `package.json` sets `afterInstall`, `afterRemove`, and
  `extraFiles` shipping `build/linux/dsh` to the app root and `build/linux/bin` to
  `/opt/DSH Desktop/bin`, so dpkg/rpm own the shim files (removed on uninstall);
  only the `/usr/bin/dsh` symlink is maintained by the maintainer scripts.
- `scripts/verify-linux-package.ts` now also verifies `linux-unpacked/dsh` (dispatches
  to `desktop-cli.js`, prepends `APP_DIR/bin`) and `linux-unpacked/bin/pnpm` (dispatches
  to the bundled `pnpm.mjs`) via `assertExecutableScript`, and
  `tests/verify-linux-package.spec.ts` covers the missing / non-executable / stale cases.

## Alternatives considered

**Package a real `/usr/bin/dsh` file via `linux.fpm` source mapping.** This would let
dpkg/rpm own the command without maintainer scripts, but the shim could no longer
self-locate from `$0` (its `dirname` would be `/usr/bin`), forcing a baked
`/opt/DSH Desktop/` path at build time. The post-install symlink approach keeps the
shim self-locating and mirrors how Electron Builder already installs `dsh-desktop`.

## Consequences

`sudo dpkg -i DSH-Desktop-<version>-amd64.deb` (or `rpm -i`) now provides `dsh` in
any shell, alongside the desktop launcher. The command is the ordinary Harness CLI:
it defaults to the caller-selected profile (no `DSH_DESKTOP_DEFAULT_PROFILE` is set
at install time), matching upstream `dsh` semantics. Plugin management
(`dsh plugin add/remove/update`) works out of the box because the bundled pnpm and
Node are exposed through the app-local `bin/` shims — no system pnpm or Node
install is required. Because the shims are placed in the app directory, they are
also present in the AppImage but only reachable from a shell once a system package
installs the `/usr/bin/dsh` symlink. Note: installing alongside the Debian `dsh`
(dancer's-shell) package would shadow its `/usr/bin/dsh`; the product owns the
`dsh` name and this is accepted. The desktop-host PATH shim
(`desktop-runtime-environment.ts`) remains Windows-only; Linux relies on the system
command.
