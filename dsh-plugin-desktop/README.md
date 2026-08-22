# DSH Desktop

English | [中文](README.zh.md)

`dsh-plugin-desktop` runs DSH in Electron while remaining part of the ordinary Cordis composition. The installed application is named **DSH Desktop**. The package provides the `dsh-plugin-desktop` executable and the `dsh-desktop` alias; the registered npm package name is the reliable `npx` entry.

## Architecture

The Electron executable is minimal bootstrap code. It acquires the single-instance lock, resolves the selected Host target, and provides the native runtime capability. The default Local Host boots the Cordis root in the Electron main process. On Windows, an optional managed WSL target instead supervises the complete Host in one selected WSL 2 distribution and exposes native capabilities through an owned control channel. The `desktop-shell` Host plugin owns the logical window, navigation policy, settings namespace, and close-versus-quit lifecycle through Cordis effects. The Windows or macOS runtime owns the physical Electron objects and tray, while `desktop-shell`, `desktop-profiles`, `desktop-terminal`, and `desktop-updates` contribute effect-scoped commands through its ordered item registry.

Both presentation modes reuse the existing loopback Web carrier. The profile mounts the ordinary `dsh-base` and `dsh-web-app` bundles, the Host binds its HTTP and WebSocket surface to `127.0.0.1` on an ephemeral port, and Electron loads that same-origin page in a sandboxed renderer. There is no Electron-owned plugin roster, preload bridge, or raw Electron API in the renderer.

The desktop package has normal Host and Web Client faces. Its Client face validates the Host-supplied mode and platform markers in both modes. Compatibility then returns without registering services, slots, styles, or presentation; advanced mode installs the desktop layout service and root presentation described below. Third-party Web clients continue to use the ordinary DSH module graph in both modes.

See [Managed WSL Host](docs/wsl-host.md) for prerequisites, plain-language terminology, storage, lifecycle, security boundaries, development setup, and recovery behavior.

The tray profile selector lists existing profiles and the lazily available `desktop` and `web` defaults. A selectable profile directly composes `dsh-base` before `dsh-web-app`; headless, malformed, or already desktop-embedded profiles remain visible but disabled. `desktop` is the only launcher-managed profile: its installation-owned prefix is repaired while third-party bundle order is preserved. Every other selected profile keeps its manifest, user patch, and dependencies unchanged. The launcher inserts its own desktop layer after `dsh-web-app` for the active generation and never persists that layer in the selected bundle list.

Profile selection is desktop-owned state under the active Host target's state root, not another field inside a selected profile. The Local Host uses Electron user data; the managed WSL Host uses its private Linux state directory. A switch is recorded as pending and takes effect through an orderly restart. The new profile becomes last-known-good only after the Cordis tree and native window mount successfully; the tray is created after the Web surface loads, and that state commit completes synchronously before tray commands can run. A failed pending generation is rolled back and relaunched once. Profiles within one Host target use the same DSH home for sessions, settings, and storage by default, so profile switching does not copy or migrate records. Local and WSL Host targets intentionally use separate DSH homes. A custom profile patch may deliberately redirect one of those persistence roots.

Before Loader entries mount, the launcher registers the generation-scoped `ctx.desktopProfiles` service. Its immutable `current` value contains the active profile's `name` and absolute `dir`; `list()` performs read-only discovery, while `select(name)` serializes persistence-before-restart switching without changing the live generation in place. The service is a Desktop Host capability, not a renderer bridge or an active-profile API supplied by current upstream DSH.

Bare Cordis plugin imports resolve from the persistent profile. A narrow Node resolve hook applies only to imports issued by `@deepseek-ai/cordis-plugin-loader`, so profile-local third-party packages and the healed launcher fallback use the same resolution path even when packaged Electron does not expose Node's internal ESM loader.

Before profile preparation and Cordis boot, a packaged local macOS or Linux launch runs the configured account shell in interactive login mode and recovers its exported `PATH`. This repairs the minimal `PATH` commonly supplied by Finder, LaunchServices, and other graphical launchers. It also fills only missing locale, toolchain, package-manager, and virtual-environment exports from a fixed allowlist; `PATH` alone always uses the shell value. Recovery supports absolute `zsh`, `bash`, and `fish` paths. Bash follows its standard login behavior, so `.bashrc` contributes only when a login profile sources it. Windows, WSL Host, and unpackaged or development launches skip recovery. An unavailable or unsupported shell, timeout, capture failure, or missing `PATH` silently retains the inherited process environment.

The capture starts from `@deepseek-ai/dsh-subprocess`'s `scrubbedParentEnv()`, and captured names pass the same `SENSITIVE_ENV_PATTERN` and `DSH_ENV_PREFIX` checks before the fixed allowlist is applied. Credentials, `DSH_*` values, proxy and SSH-agent settings, and process startup hooks learned only from shell rc files are therefore not imported into Electron. This recovery does not erase values already present in Electron's explicit launch environment. Ordinary DSH subprocesses apply the official scrub again; an explicit child environment may still deliberately add a value.

After login-shell recovery, the launcher creates the layered launch-environment snapshot. It then prepends a private command directory containing only the pinned bundled `pnpm` command to the current Electron main process `PATH`. Host and third-party plugins can therefore discover that package manager from startup, including through ordinary DSH subprocess providers, without requiring a system Node.js installation. This ambient path is a compatibility surface, not the formal plugin-management contract.

The `desktop-pnpm` Host row provides `ctx.desktopPnpm` for managed package operations against the immutable active profile. `run(args, signal?)` executes packaged pnpm directly in the active profile directory; it is a low-level operation and does not promise DSH profile initialization, caller-relative source anchoring, or bundle reconciliation. `runPlugin(args, invokingDir, signal?)` starts packaged `dsh plugin --profile <active>` for remove, update, and dependency repair, but rejects `add`. Plugin installation uses `installPlugin(request)`, which binds one exact `name@version` target to a receipt, snapshots the profile before spawning, and seals or restores the snapshot before completion. The upstream CLI remains authoritative for pnpm profile working-directory and bundle-reconciliation semantics.

Both methods return live stdout and stderr streams, a `done` promise that settles after the complete process tree exits, and `cancel()`. One operation may run per generation. The service uses the ordinary DSH subprocess provider, exact packaged JavaScript entries, shell-free argv, and child-scoped DSH home, CI, and native-module ABI values. The Local Host uses Electron-backed Node; the WSL Host uses the verified native Linux Node runtime. The public runtime path still does not expose `node` or `dsh`; its private helpers and npm ABI variables exist only inside package-manager subprocess trees. The launcher does not modify the system `PATH`, shell startup files, profile configuration, or `.env` documents.

Plugin authors should use the supported contract imports, lifecycle rules, and adaptation patterns in the [Desktop plugin service architecture](docs/plugin-services.md).

## Mode setting and restart boundary

The `dsh-desktop.mode` field in the DSH home `settings.yaml` document is the single source of truth:

```yaml
dsh-desktop:
  mode: compatibility # or advanced
```

The launcher reads the same file resolved by the active `@deepseek-ai/dsh-settings-file` row before composing a generation. The Host registers the `dsh-desktop` namespace with the standard settings service. There is no parallel mode value in the profile manifest.

Users can select the other mode from the tray or edit the DSH home `settings.yaml` document by hand. The tray updates the registered `dsh-desktop` settings namespace, while a manual edit changes the same file observed by the settings provider. A committed change requests one orderly restart: the current Cordis tree disposes first, then Electron relaunches only after a successful zero-code shutdown. The application never hot-swaps root slots, native window materials, or Loader rows inside a live renderer generation.

Linux supports compatibility mode only. Its tray mode command is disabled, and an advanced value is rejected rather than silently falling back.

## Compatibility mode

`dsh-desktop.mode` defaults to `compatibility`. This mode creates a normal operating-system window with its native frame and loads the official Web surface from the active DSH profile. macOS suppresses the visible page title. Windows retains the native caption icon and displays `DeepSeek Harness Desktop`, but removes the window menu bar. The operating system owns native title-bar color and appearance.

The desktop Client module validates the mode and platform markers, then performs no presentation replacement in compatibility mode. It does not provide or replace the `layout` service, register a `root` or `sidebar` occupant, or change the conversation surface. Desktop-owned boot-health reporting and local folder drop are capability effects; compatibility mode still preserves the selected profile's own layout, sidebar, and conversation composition, so the ordinary `desktop` and `web` profiles keep the official rows unchanged.

The Cordis row registers native window values during profile activation. The launcher creates the window only after `app-boot` settles and audits the complete profile, so the first renderer manifest includes the active official, desktop, and third-party client plugins without a Loader-wide wait inside the plugin itself.

On Windows, the launcher pins the browse directory-picker backend and keeps the full in-app directory panel. The desktop build patches that panel with a small system-folder icon whose same-origin route calls Electron's `dialog.showOpenDialog`; a selected path returns to the panel's existing workspace-adoption flow, while cancellation leaves the panel open. Ordinary browser and remote launches do not receive the desktop bridge. macOS and Linux retain the upstream adaptive chooser.

On every desktop platform and in both presentation modes, one local folder can be dragged onto the left Workspace region. The isolated preload uses Electron `webUtils` only to resolve that operator-dropped `File`, after which the Client reuses the official `workspaces.create` and `startSession` flow. Ordinary files, multi-item drops, and internal Workspace or Session reordering do not trigger directory adoption; the Host remains responsible for path canonicalization, directory validation, and idempotent reuse of an existing Workspace.

The Local Windows Host keeps the upstream `pwsh-sandbox` behavior and Windows ACL confinement in both presentation modes. The launcher generation replaces only that Host provider with the `dsh-plugin-desktop/windows-pwsh-sandbox` subpath from this same package. For the exact upstream ACL-runner argv, the adapter launches the packaged Electron executable in Node mode through a private trampoline, removes the Node-mode variable before the restricted PowerShell process is created, and delegates all policy and failure handling back to the upstream runner. The desktop deploy root also pins a Yarn patch that combines `STARTF_USESHOWWINDOW` with the existing `STARTF_USESTDHANDLES` and `SW_HIDE` on both native restricted-process paths. This preserves captured stdio without suppressing console allocation and requests a hidden initial show state when Windows creates the GUI-hosted PowerShell process's first console window. It does not use the upstream-incompatible `CREATE_NO_WINDOW` or `CREATE_NEW_CONSOLE` flags. The WSL Host composes the ordinary Linux execution providers instead. Direct `danger-full-access` PowerShell, macOS, and Linux execution are unchanged; there is no automatic unrestricted fallback when Windows confinement fails.

## Advanced mode

Advanced mode is an explicitly composed desktop presentation for macOS and Windows. After all user patches have been read, the launcher disables the official `ui-layout` Loader row, keeps the official `ui-sidebar` and `ui-conversation` rows enabled, and applies the selected mode to `desktop-shell`.

The desktop Client then provides the `layout` service for its own Cordis-fiber lifetime and registers only the `root` slot occupant. Its root declares seats for the unchanged upstream sidebar, conversation, details, and overlay contributions. The official sidebar remains the `sidebar` occupant and continues to declare the workspace browser, settings shell, and additive footer-action seats. This preserves its component behavior, collapse animation, and third-party extension points while the desktop package owns only frame geometry and native material.

The advanced theme presenter projects the active upstream theme snapshot onto the document, including color scheme, resolved token values, dark-mode marker, and theme-color metadata. It subscribes to ordinary theme changes and removes only its own projected state when the generation disposes.

For an advanced generation, the Electron adapter also reads the registered `ui-theme.preference` after Host boot and mirrors its built-in `light`, `dark`, or `system` value into Electron's native appearance before constructing the window. Committed preference changes update the native material while the window is active, and disposal restores the preceding Electron appearance. Client-only third-party theme ids do not change this Host preference.

The desktop sidebar surface scopes the upstream sidebar-fill token to transparent, so the official sidebar and session-list fade reveal the native material without changing their component styles.

On macOS the advanced window uses a transparent hidden-inset title bar, positioned traffic lights, and native `sidebar` vibrancy. Its 90 CSS-pixel collapsed column centers the official 56-pixel rail below a desktop-owned traffic-light inset. The sidebar surface itself is non-draggable; a desktop-owned transparent 32 CSS-pixel strip to the right of the traffic lights supplies its window drag target. A separate caption row reserves 20 CSS pixels above the complete conversation and details surfaces while exposing another transparent 32 CSS-pixel drag target. Buttons, links, inputs, dialogs, and contributions that explicitly declare `app-region: no-drag` remain interactive; a custom pointer target placed within the top 32 pixels must declare the same exclusion. On Windows the official sidebar keeps compatibility geometry: 56 pixels collapsed, 280 pixels by default when expanded, and the same upstream transition behavior, while its transparent surface reveals Mica. The window uses a hidden title bar with native controls, transparent overlay, Mica background material, shadow, rounded corners, and a thick resizable frame. Electron exposes the system-drawn Mica material on Windows 11 22H2 and later. A desktop-owned 32 CSS-pixel caption row spans the Windows conversation and details columns; the complete upstream slot surfaces start below that row, so official and third-party header contributions keep their ordinary relative layout without element-specific caption offsets. Linux rejects advanced mode rather than silently falling back to a presentation different from the persisted setting.

## Development

This package is managed by the Yarn workspace at the repository root. The sibling `deepseek-harness/` checkout remains an independent upstream pnpm project and is not part of the Yarn workspace. Install and verify DSH Desktop from the repository root:

```sh
yarn install
yarn check
```

The check verifies that every required first-party peer in the production graph is declared by the desktop deploy root. Headless Loader smokes activate the launcher-owned desktop row and a profile-local third-party row, then boot the published Web profile and inspect its loopback root and client manifest. Unit and type tests cover both profile compositions, restart fencing, client environment validation, desktop layout state, and platform-native window options.

Start the desktop application explicitly when a graphical session is available:

```sh
yarn dev
```

`dev` builds before launching. It does not require a separate manual build.

The headless-safe launcher surfaces can be exercised without importing or starting Electron:

```sh
node lib/bin.js --help
node lib/bin.js --version
```

## Plugin workflow

Manage any profile with the ordinary DSH command:

```sh
dsh plugin --profile desktop add third-party-plugin
dsh plugin --profile desktop remove third-party-plugin
dsh plugin --profile desktop update
```

The application starts with `desktop` by default. Choose another Web-capable profile from the tray's **Profile** submenu; switching profiles restarts the application. The generated DSH terminal defaults bare commands to the currently active profile, so the shorter forms below modify that profile directly:

```sh
dsh plugin add third-party-plugin
dsh plugin remove third-party-plugin
dsh plugin update
```

An explicit `--profile <name>` remains authoritative and is useful for preparing another profile before selecting it.

`dshmarket@1.2.3` is not preinstalled and is not a dependency of DSH Desktop. That release still resolves a profile from config/argv and starts `dsh plugin` through private child-process code; it neither reads `desktopProfiles` nor uses `desktopPnpm`, and its package exports no runner injection seam. A later compatible release must detect the Desktop services dynamically and retain its existing CLI fallback under ordinary DSH. In addition, the `1.2.3` source repository and npm tarball contain no complete MIT license text or copyright notice, so that version does not pass the bundled-redistribution gate. User-directed installation of a third-party package is separate from Desktop embedding it in the application archive or installer.

See [Plugin services for authors](docs/plugin-services.md) for required injection, optional Desktop adaptation, TypeScript examples, cancellation, and fallback guidance.

The package can then be launched from npm with:

```sh
npx dsh-plugin-desktop
```

## Launching from the command line

The package installs two equivalent commands, `dsh-desktop` and `dsh-plugin-desktop`. Both launch the packaged Electron launcher (`lib/main.js`) when invoked without arguments.

- **Global install** — `npm install -g dsh-plugin-desktop` installs the `electron` peer automatically, and `dsh-desktop` then starts the application against the default DSH home:
  ```sh
  dsh-desktop
  ```
- **Inside a profile** — after `dsh plugin --profile <name> add dsh-plugin-desktop`, the command lives in the profile's `node_modules/.bin`. pnpm does not install the `electron` peer automatically; add it when you want the command to launch:
  ```sh
  dsh plugin --profile <name> add electron
  ```
  Native build approvals (node-pty, koffi, electron, and others) follow pnpm's usual `allowBuilds` rules.
- **Electron missing** — the command prints a short installation guide instead of failing with a module error.

Booting a profile that is composed with the desktop shell under an ordinary `dsh` invocation (without the launcher's `desktopRuntime` service) prints a reminder telling you to start it with `dsh-desktop` or from the packaged application; the shell registers nothing in that case.

A third-party Host plugin only needs its normal `dsh.bundle` patch. A plugin with browser UI also publishes the normal `dsh.client` metadata with `platform: "web"` and an exported `./client` artifact. The upstream Web client module graph discovers it in both modes; Electron does not require a separate client build or a desktop-specific registration API. Advanced-mode contributions must target services and slots that exist in that explicit composition rather than assuming the official layout or sidebar occupant owns them.

## Desktop operations

When the Desktop window is unfocused, a direct user turn that reaches `completed` raises a native completion notification; `error` and `max-tokens` endings raise a needs-attention notification. Completed and failed background jobs use the same native attention path. Aborted, blocked, interrupted, killed, plugin-initiated, continuation-only, mismatched, and subagent activity stays silent. Clicking a notification reveals and focuses the window. macOS and Linux increment the application badge, while Windows flashes the taskbar button; showing, focusing, or releasing the window clears that attention. The live `dsh-desktop-notifications` settings namespace provides independent `notifyOnTurnCompletion`, `notifyOnTurnFailure`, `notifyOnJobCompletion`, and `notifyOnJobFailure` switches, all enabled by default. Notification text is deliberately generic and never includes prompts, responses, errors, job labels, commands, paths, session IDs, model or provider names, tool data, or output.

Packaged macOS and Windows applications query `https://www.dshdesktop.cn/api/desktop/version` 60 seconds after startup and every six hours after a completed check. Each no-cache request has a 15-second deadline and shares one in-flight operation with the **Check for Updates…** tray command. The response is accepted only when it contains canonical stable Semantic Versioning. Background network, HTTP, timeout, invalid-response, equal-version, and older-version outcomes are silent. A manual check always opens a native result dialog: equal or older results report the installed version, failures ask the user to retry, and a strictly newer version uses the **Download** or **Later** prompt. Automatic update prompts are remembered per version, while the tray can retry explicitly. Development, unpackaged, and Linux launches do not download an installer.

Choosing **Download** first rechecks that the advertised version is unchanged, then opens a native save dialog. The default destination is the Downloads directory, but the user may choose another absolute path and filename; cancelling the dialog makes no download request. DSH Desktop follows the service redirect through Electron networking, streams at most 1 GiB to that selected path, records the installer location for the upgrade handoff, and rejects an incomplete DMG or Windows PE before exposing it. On macOS it opens the downloaded DMG and tells the user to replace the application in `Applications` and reopen it. On Windows it asks again after the NSIS installer is ready; **Restart and Install** launches that installer and requests orderly Cordis teardown before the current process exits. After the upgraded application starts, it offers to delete the recorded installer or keep it; either choice consumes the pending cleanup state. Download, filesystem, and installer-opening failures remain silent and leave the available-version tray action retryable.

Release operators must publish both platform artifacts before making a version discoverable. After the artifacts and download redirects are ready, set `deepseek-harness-desktop:release:version` to the canonical stable version in the Upstash Redis console, for example `SET deepseek-harness-desktop:release:version 2.0.1`. The version API changes immediately; missing, unavailable, or invalid values produce no Desktop prompt.

On macOS and Windows, **Open DSH Terminal** opens a system terminal rooted at the active profile. Its welcome text identifies the application version, active profile, profile directory, and DSH home, then lists configuration and plugin-management commands. Inside this terminal, bare `dsh`, `dsh --dump-config`, and plugin subcommands without a profile selection default to that active profile; an explicit `--profile` and the upstream `web` alias keep their original meaning. DSH Desktop generates private per-profile `dsh`, `pnpm`, and `node` shims under its user-data directory, sets `DSH_HOME`, uses the active profile as the working directory, and prepends the shim directory only to that terminal's `PATH`. A later profile switch therefore does not change commands in an already open terminal. It does not edit the global environment or shell startup files. The macOS launcher preserves the user's interactive zsh or bash setup before restoring the desktop-owned values. Windows selects PowerShell 7, Windows PowerShell, or Command Prompt in that order and opens it in a new Windows Terminal window; when `wt.exe` is unavailable, a private `cmd start` broker creates a visible console instead. Synchronous launch failures and unsuccessful broker exits are shown in a native error dialog. Linux does not compose the terminal command.

## Logs and diagnostics

DSH Desktop writes UTF-8 logs under Electron's user-data directory: `%APPDATA%\DSH Desktop\logs` on Windows and `~/Library/Application Support/DSH Desktop/logs` on macOS. Full logs use `dsh-YYYY-MM-DD.log`; warnings and errors are also written to `dsh-YYYY-MM-DD.error.log`. Files rotate at 10 MiB, files older than seven days are removed at startup, and the directory is kept below 200 MiB. The `dsh-desktop.logLevel` setting controls verbosity and defaults to `info`.

On macOS and Windows, choose **Export Diagnostics…** from the tray to create a ZIP under the sibling `diagnostics` directory and reveal it in the system file manager. Export runs outside Electron's main thread, collects recent owned logs and local Crashpad `.dmp` files under a shared 50 MiB evidence cap, includes the `crash-evidence/active-run.json` marker when present, adds `system-info.txt`, and retains the three newest ZIP files. The confirmation dialog explains the privacy boundary before any archive is created. Recognized credentials are masked, but logs can still contain local paths, workspace IDs, session IDs, prompts, tool output, or third-party plugin messages; crash dumps can contain fragments of process memory. Review the ZIP before sharing it, especially before uploading it publicly.

## Native lifecycle

Closing the window hides it while the Host Cordis tree continues running. The tray reopens the window, selects the active profile, opens the isolated DSH terminal, checks for a stable release, changes mode through the standard settings namespace, or requests an explicit quit. Profile and mode changes both dispose the current Cordis tree before Electron relaunches. Native quit, `SIGINT`, and `SIGTERM` also request disposal before exit; a five-second deadline or a repeated request forces the final exit. Navigation and redirects remain on the exact loopback origin; external HTTP, HTTPS, and mail links open in the operating system, while the renderer uses `contextIsolation`, the Chromium sandbox, and no Node integration.

## Packaging

`yarn package:dir` creates an unpacked directory for the current host platform. The packaged-runtime gate rejects an application archive that omits the desktop update and terminal modules, the DSH CLI bootstrap, the bundled pnpm entry, or the physical deployment package. Electron Builder emits the root manifest, desktop runtime, and complete dependency tree under `app.asar.unpacked`; both Host profile boot and the CLI bootstrap use this physical tree so DSH profile-fallback symlinks never target a virtual ASAR directory. `build/app-icon.png` remains the unmodified iOS Default source and the Windows/Linux application icon. The build runs `scripts/generate-mac-app-icon.mjs` to center that artwork at 824 by 824 pixels on a transparent 1024 by 1024 canvas; macOS packaging and the live Dock both use the generated `build/app-icon-mac.png`. `build/tray-icon.svg` is the brand-blue tray source: the build derives a macOS template image that the system colors automatically and fixed brand-blue Windows and Linux tray images.

### WSL Linux headless checks

WSL2 is suitable for Linux headless build, typecheck, and unit-test coverage from a Windows workstation. Use a Linux Node.js installation inside WSL, not the Windows Node.js or Corepack shims that WSL can inherit through the mounted Windows `PATH`. When using `nvm`, start each shell with `source ~/.nvm/nvm.sh` before running Corepack commands:

```bash
source ~/.nvm/nvm.sh
git submodule update --init --recursive
corepack yarn install --immutable
corepack yarn workspace dsh-plugin-desktop typecheck
corepack yarn workspace dsh-plugin-desktop test
corepack yarn build
```

Commands run from `/mnt/<drive>` are valid but slower than a checkout stored on WSL's native ext4 filesystem. WSL does not replace a real Linux desktop session for tray, window-manager, `.desktop` integration, or installed-package smoke tests.

### Local Windows x64 installer

Use a native Windows x64 machine with Git and x64 Node `22.23.2` (the same release used by CI). The packaging command accepts Node `22.19+` and Node `24.x`, whose official distributions include the required Corepack command. From PowerShell in a fresh `v2` checkout, run:

```powershell
git submodule update --init --recursive
corepack.cmd yarn install --immutable
corepack.cmd yarn dist:win
```

Python and Visual Studio C++ Build Tools are not required. The Windows command uses `node-pty`'s bundled x64 Node-API binaries instead of asking Electron Builder to rebuild them from source, and the packaged-runtime gate rejects an installer staging tree that omits those binaries.

`dist:win` refuses non-Windows and non-x64 hosts, runs a Windows-safe gate containing the build, all TypeScript compiler faces, packaging and native-shell focused tests, and the runtime-closure verifier, then builds an assisted NSIS installer and verifies both generated PE files. The full cross-platform suite remains CI-owned because some POSIX execution tests are not Windows programs. The installer allows a per-user or elevated all-users installation, permits changing the installation directory, creates Start Menu and desktop shortcuts, and preserves DSH user data when the application is uninstalled. Version `2.0.1` is written to `dsh-plugin-desktop\dist\DSH-Desktop-2.0.1-x64-Setup.exe`; the unpacked application remains at `dsh-plugin-desktop\dist\win-unpacked\DSH Desktop.exe` for smoke testing.

This local command deliberately strips Windows certificate variables and sets `signExecutable=false`. Its output is installable for testing but has no Authenticode publisher, so Windows can display an Unknown publisher or SmartScreen warning. A signed Windows release, certificate verification, installer upgrade/uninstall testing, and native UI/sandbox smoke remain separate release gates.

### Windows x64 portable ZIP

Use `yarn dist:win-portable` on a native Windows x64 machine to create an unsigned portable ZIP:

```powershell
corepack.cmd yarn dist:win-portable
```

The output is `dsh-plugin-desktop\\dist\\DSH-Desktop-2.0.1-x64-Portable.zip`. Extract it to any writable directory and launch `DSH Desktop.exe` without an installer, administrator access, Start Menu registration, or uninstall step. The application still keeps its profiles, logs, and caches in the normal Windows user-data directory, so this is portable distribution rather than a self-contained data sandbox. Portable archives are not handed to the NSIS updater and must be replaced manually when a new version is released. Local builds are unsigned and may trigger an Unknown publisher or SmartScreen warning; signed portable artifacts remain a release gate.

### macOS DMG smoke

`yarn dist:mac-smoke` builds one unsigned universal DMG on a native macOS host. The same package runs natively on Intel and Apple Silicon Macs. The command refuses non-macOS hosts and runs the complete product gate before packaging: repository layout and community-contract checks, the Market build and check, then the Desktop build, every TypeScript compiler face, the full unit-test suite, runtime-closure verification, CLI/Loader/profile headless smokes, and the license audit. This includes the real login-shell tests for each supported shell installed on the macOS runner. It then packages without code-signing material, mounts the DMG, and verifies the property list, executable bit, both `x86_64` and `arm64` slices, and `app.asar`. It mirrors `dist:win`'s secret discipline by stripping every Electron Builder macOS signing and notarization variable, sets `CSC_IDENTITY_AUTO_DISCOVERY=false`, disables notarization, and never publishes. The artifact has no Developer ID signature, so Gatekeeper will block it on other machines; it exists so packaging regressions fail in CI before a manual release. The signed and notarized universal release remains `yarn dist:mac` on a credentialed macOS machine and writes its artifact to `dsh-plugin-desktop/dist/mac-release/`.

## Model Experience

None. The desktop package changes application composition and native presentation; it does not add model-visible instructions, tools, events, or request fields.

#### KV Cache effect

None. The same DSH Host and client feature plugins assemble model requests.

## Known Limitations and Deferred Work

- Adding or removing a profile bundle requires restarting DSH Desktop; the launcher does not watch profile manifests. Selecting another profile from the tray performs that restart automatically.
- Switching compatibility/advanced mode always restarts the application by design; a live generation never hot-swaps Loader rows, slot ownership, or native materials.
- Advanced mode is unavailable on Linux. Linux continues to use the compatibility presentation.
- The macOS and Windows tray terminal exposes private `dsh`, `pnpm`, and `node` shims. Separately, the Host runtime exposes the bundled `pnpm` command on the current Electron process `PATH` for ambient compatibility and provides the managed `desktopPnpm` service; none of these commands are added to the system `PATH`, and Linux currently has no desktop terminal command.
- On Windows, the ambient `pnpm` command and lifecycle Node helper are `.cmd` shims. `desktopPnpm.run()`, `runPlugin()`, and `installPlugin()` avoid shell lookup for the manager process by launching exact packaged entries, while upstream `dsh plugin`, PowerShell, and Command Prompt can resolve the ambient shim through a command interpreter. A third-party plugin that calls Node `spawn('pnpm', { shell: false })`, or a lifecycle script that directly executes its `.cmd` `npm_node_execpath` with `shell: false`, remains non-portable and should use the managed service or a shell-aware launch path.
- `dshmarket@1.2.3` remains an optional user-installed third-party package, not a bundled marketplace. Preinstallation is deferred until an audited release consumes the optional Desktop services while preserving ordinary DSH fallback and includes the complete license notice required for redistribution.
- The update handoff validates the download container, not publisher identity. macOS still requires the user to replace the application from the opened DMG; Windows runs the downloaded NSIS installer but the local `dist:win` artifact is unsigned. Signed artifacts, Authenticode/publisher verification, SmartScreen reputation, and native upgrade testing remain release gates.
- The shared carrier is loopback HTTP and WebSocket, not Electron IPC. Replacing it requires transport extension points in upstream DSH and is outside this standalone package.
- This project pins both the published DSH `0.1.1-rc.2` family and the corresponding official `deepseek-harness/` release source. Product builds still resolve published package interfaces rather than linking the source checkout.
- `package:dir` is an unpacked smoke artifact. `dist:win` adds an unsigned NSIS test installer but does not establish Authenticode identity or SmartScreen reputation. Installation and upgrade behavior, native notifications and terminals, the Windows ACL sandbox, and native-material appearance remain target-platform verification boundaries.
