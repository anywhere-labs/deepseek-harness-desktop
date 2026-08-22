# Managed WSL Host

[中文](wsl-host.zh.md)

DSH Desktop for Windows can run the complete DeepSeek Harness Host inside one selected WSL 2 distribution while keeping the Electron window and operating-system integrations native to Windows. This is a runtime location choice, not a Linux GUI build and not a second remote-control product.

## The idea in plain language

DSH has two broad halves:

- The **Host** is the working engine. It loads the Cordis plugin tree, profiles, agents, tools, workspaces, terminal providers, HTTP server, and WebSocket server.
- The **desktop shell** is the Windows-facing part. It owns the Electron window, tray, native dialogs, notifications, installer updates, and application shutdown.

With the Local Host, both halves run in the Windows Electron process. With a WSL Host, the working engine moves into Linux and the desktop shell remains on Windows:

```text
Windows                                      WSL 2 distribution
┌──────────────────────────────┐             ┌──────────────────────────────┐
│ Electron desktop shell       │   stdio RPC │ Complete DSH Host            │
│ window / tray / dialogs      │◄───────────►│ Cordis / profiles / plugins  │
│ notifications / updater      │             │ agents / tools / workspaces  │
└──────────────┬───────────────┘             └──────────────┬───────────────┘
               │ BrowserWindow                              │ 127.0.0.1
               └────────────── HTTP + WebSocket ────────────┘
```

The browser page is still the ordinary DSH Web application. WSL exposes the Host's loopback endpoint to Windows through WSL localhost forwarding, and Electron loads that exact origin. Plugins stay in the normal DSH/Cordis composition; there is no separate Electron plugin list.

## Terms used in this design

| Term | Meaning here |
| --- | --- |
| Host | The Node.js process that runs the complete DSH backend and plugin tree. |
| Cordis | The lifecycle and dependency-composition framework used by DSH. It starts plugins in dependency order and releases their effects as one generation. |
| Profile | A named DSH configuration and dependency set, such as `desktop` or `web`. Local and WSL Hosts have separate profile stores. |
| Renderer | Chromium's isolated page process inside the Electron window. It displays the DSH Web UI but receives no raw Node.js or Electron API. |
| Control channel | A private, versioned JSON-lines RPC stream carried over the owned WSL child process's stdin/stdout. It is not a listening network port. |
| Health gate | The point at which the Host, Web page, and native window have all started successfully. Only then is a pending profile/target committed as known-good. |
| Distribution | One installed WSL Linux environment, for example `Ubuntu-24.04`. |
| ext4 storage | WSL's native Linux filesystem. It preserves Linux paths, permissions, links, and file-watching behavior better than `/mnt/c`. |
| Runtime bundle | A Windows-packaged directory containing the exact Desktop, Market, patched first-party archives, npm lockfile, and SHA-256 manifest used to provision WSL. |

## Requirements

The managed WSL Host is available only from a native Windows DSH Desktop launch. The selected distribution must be WSL 2 and must provide all of the following to a non-interactive `wsl.exe --exec` command:

- Linux Node.js `^22.19.0` or `>=24.0.0`;
- npm;
- GNU Bash;
- a writable Linux home directory;
- network access to the configured npm registry on first provisioning.

Check a distribution from PowerShell before selecting it:

```powershell
wsl -d Ubuntu-24.04 -- node --version
wsl -d Ubuntu-24.04 -- npm --version
wsl -d Ubuntu-24.04 -- bash --version
```

All three commands must work without first sourcing an interactive shell file. Version managers such as `nvm` often add Node only from `.bashrc`; that is insufficient for `wsl.exe --exec node`. Expose a stable Linux `node` and `npm` on the distribution's non-interactive PATH, or install them using the distribution's normal administrator-managed method.

## Selecting a Host location

1. Start DSH Desktop on Windows and open **Settings**.
2. Open the **Desktop** section and find **Host location**.
3. Choose **Local Host** or one listed `WSL · <distribution>` target.
4. Confirm the change. DSH Desktop persists the entire target selection, shuts down the current generation in order, and relaunches.

The choice applies to the next complete generation. DSH Desktop never moves a live Cordis tree between operating systems.

On a source checkout, a WSL launch also requires `DSH_DESKTOP_WSL_BUNDLE_DIR` to identify a prepared runtime bundle. Packaged Windows releases carry the verified bundle under `resources/wsl-runtime` and do not depend on unpublished Desktop or Market package versions being available from npm.

## First-run provisioning and storage

DSH Desktop probes the selected distribution, verifies every bundled byte on Windows, translates the bundle location with `wslpath`, and copies it into a unique staging directory on WSL's Linux filesystem. `npm ci` installs only the sealed lockfile graph. The staged Host version and manifest fingerprint are checked before an atomic directory rename makes it active; the previous runtime remains available for rollback until the new tree passes final verification. Provisioning is repeated only when that exact fingerprint is absent or invalid.

Managed paths are below the Linux user's home directory:

```text
~/.local/share/dsh-desktop/runtime/<desktop-version>  exact Host package runtime
~/.local/share/dsh-desktop/home                       WSL DSH home and profiles
~/.local/state/dsh-desktop                            WSL launcher state
```

The application creates its real home/state directories with user-only permissions. Local-Host profiles remain in the Windows DSH home; WSL-Host profiles remain in WSL. Switching targets does not copy, merge, delete, or reinterpret either store.

Keep Linux projects in the distribution's native filesystem, for example `/home/alice/projects/example`. This gives Linux tools their expected permissions, symlinks, case behavior, watchers, and performance.

## Workspaces and terminals

The Windows folder chooser is restricted to the selected distribution's UNC share:

```text
\\wsl.localhost\Ubuntu-24.04\home\alice\projects\example
```

The selected UNC path is converted losslessly to a Linux absolute path and validated inside that same distribution before DSH accepts it. A path from another distribution, a Windows drive, a file, or a path containing traversal is rejected. Drag-and-drop follows the same Host-side validation boundary.

**Open DSH Terminal** starts Windows Terminal, or a console fallback, directly in the selected distribution. The terminal receives the active WSL profile, DSH home, managed Node runtime context, and Linux working directory. Arguments are passed as fixed argv values; user-controlled paths are not interpolated into a shell program.

## Native features across the boundary

Plugins still see the ordinary `desktopRuntime` capability. A WSL-side proxy forwards only the operations that must remain native:

- window show/hide/focus and renderer URL mounting;
- tray items and native menu actions;
- directory and confirmation dialogs;
- the isolated Profile creator, diagnostics privacy flow, and recovery dialogs;
- notifications, badges, and taskbar attention;
- theme appearance;
- update checks, downloads, and installer handoff;
- profile/Host-target restart and application quit.

The Windows side owns real Electron objects. The WSL side owns DSH, its profiles, plugin package operations, and workspace semantics. This preserves the core DSH rule that capabilities are composed as plugins, while placing operating-system adapters where the relevant OS APIs actually exist.

## Lifecycle and recovery

Startup follows a two-phase health rule:

1. Windows provisions and starts one WSL Host child.
2. The WSL Host composes its complete Cordis tree and publishes its loopback Web endpoint.
3. Electron mounts the endpoint and waits for Renderer health.
4. Windows commits both the profile generation and Host target as known-good.

If the child exits before step 4, the selection is not committed. A native recovery dialog offers to switch to the Local Host and relaunch, or quit. WSL profiles and data are preserved. After health is committed, an unexpected WSL Host exit requests an orderly Windows application shutdown instead of leaving a misleading empty shell.

At the health gate, WSL captures the same bounded Profile configuration checkpoint as the Local Host. An explicit **Restore last successful Profile** request first validates the current and last-known-good selections, sends the HTTP acceptance response, then quiesces the Cordis tree before changing files. Windows saves recovery diagnostics without uploading them; WSL restores the sealed checkpoint and runs `pnpm install --frozen-lockfile` against the Linux Node ABI before committing the selection and restarting. A failure stays on the native recovery surface and offers a safe switch back to the Local Host. Inactive WSL Profiles can also be deleted through the same selection, install-recovery, plugin-state, and checkpoint guards as Local Profiles.

Normal quit works in the opposite direction: Windows sends a bounded shutdown request, the WSL Host releases the Cordis generation, and Windows waits for `wsl.exe` to exit. A Host-initiated restart is acknowledged on the control channel before Windows begins that shutdown, avoiding a circular wait. Timeouts have explicit kill/exit fallbacks so neither side can indefinitely orphan the other.

## Security boundary

- The control protocol is versioned and limited to 1 MiB per JSON-lines frame.
- Control traffic uses only the owned child process's stdio. No new TCP control listener is opened.
- Process launches use executable-plus-argv APIs with `shell: false` or fixed scripts with positional arguments.
- The DSH HTTP/WebSocket endpoint remains loopback-only and Electron navigation remains pinned to its exact origin.
- WSL distribution names are validated and must come from current WSL 2 discovery.
- Workspace admission is confined to the selected distribution and revalidated in Linux.
- The WSL Host package version must exactly match the Windows desktop version.
- The package graph is pinned by `package-lock.json`; local and patched archives plus package metadata are sealed by a SHA-256 manifest before crossing into WSL.
- WSL stderr is mirrored into the Windows application log so startup and runtime failures appear in normal diagnostics.

The control channel is a trusted internal capability boundary between two processes launched and owned by the same desktop generation. It is not a general remote-Host API and is deliberately not exported as a public package subpath.

## Development and verification

Build and run the headless gate from the repository root:

```sh
corepack yarn workspace dsh-plugin-desktop build
corepack yarn workspace dsh-plugin-desktop typecheck
corepack yarn workspace dsh-plugin-desktop test
corepack yarn workspace dsh-plugin-desktop verify:closure
```

The package build emits the private `lib/wsl-host.js` entry. Packaging verification requires that entry and its complete runtime closure in the application archive, but `package.json` intentionally does not export `./wsl-host`.

To test a source build, build both workspaces, generate the same verified bundle used by release packaging, and point the Windows process at its Windows directory:

```powershell
corepack.cmd yarn workspace dsh-community-market build
corepack.cmd yarn workspace dsh-plugin-desktop build
node .\dsh-plugin-desktop\scripts\wsl-runtime-bundle.ts .\dsh-plugin-desktop\build\wsl-runtime
$env:DSH_DESKTOP_WSL_BUNDLE_DIR=(Resolve-Path .\dsh-plugin-desktop\build\wsl-runtime).Path
node .\dsh-plugin-desktop\lib\bin.js
```

The bundle version and every recorded hash must match the application version. This explicit variable prevents a development build from silently installing an unrelated or stale package graph.

## Troubleshooting

- **No distribution appears:** confirm `wsl --list --verbose` reports version `2`, then restart DSH Desktop.
- **Node.js prerequisite error:** run the three PowerShell checks above. A Node binary available only after `source ~/.nvm/nvm.sh` is not visible to the managed launcher.
- **Provisioning fails:** check npm registry/network access in the distribution and the Windows DSH Desktop log. External dependencies are downloaded according to the bundled lockfile; unpublished first-party packages come from the bundle. The installer error is sanitized in the UI, while detailed child stderr is logged.
- **Workspace is rejected:** choose a directory under `\\wsl.localhost\<selected-distribution>\...`, not `C:\...` or another distribution.
- **Local data seems absent:** Local and WSL Hosts intentionally use separate DSH homes. Switch the Host location back; no automatic migration is performed.
- **WSL Host exits after startup:** export normal Desktop diagnostics. WSL stderr is included in the Windows log files.
