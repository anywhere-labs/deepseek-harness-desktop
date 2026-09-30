# DSH NEXT

English | [中文](README.zh.md)

A separate experimental package based on DeepSeek Harness **0.1.6-alpha.2**. The main window loads the official published `@deepseek-ai/dsh-web-frontend`, sharing the official Web application, plugin manager, and basic Desktop presentation. Next adds the system tray, desktop preferences and tools, Profiles, recovery, Agents Anywhere remote control, Community Market, and dshmarket.

## Development and verification

Run from the outer repository root with Node.js `^22.19.0` or `>=24.0.0` and Corepack's Yarn 4.18.0:

```sh
git submodule update --init --recursive
corepack yarn install --immutable
corepack yarn check:next
corepack yarn dev:next
```

`check:next` builds Market and Next, runs typechecks, unit tests, official-frontend and sandboxed-preload checks, and a real Host smoke in a temporary home. It never opens a graphical application. The smoke uses an offline local fixture plugin to exercise pnpm, Market removal and restart requests, authentication, profile switching, and recovery boot, then cleans up its processes and files. An additional real-runtime smoke exercises the native-only HTTP/WebSocket gate, browser access changes, corrupt manifests, isolated safe mode, global-patch repair, and process teardown.

`dev:next` explicitly launches the graphical application. Use `corepack yarn start:next` with an existing build. An uncached Electron binary is downloaded on first use. To additionally exercise the real Electron executable in Node mode, build first and run:

```sh
corepack yarn workspace dsh-desktop-next verify:host:electron
```

This check opens no Electron window. Window presentation, native dialogs, and a real phone connection still require manual acceptance.

CI also runs `xvfb-run --auto-servernum corepack yarn workspace dsh-desktop-next verify:protocol --no-sandbox` on Linux. This separate test uses a real Electron renderer and custom protocol with a temporary Host, exercises Market source changes with ordinary browser access disabled, and rejects requests from a different page origin. It is not part of the portable `check:next` command. The sandbox flag applies only to the isolated CI process.

On the same Linux/Xvfb runner, `verify:sidebar-browser --no-sandbox` checks real lease-gated guest pages against a local fixture with both `frame-ancestors 'none'` and `X-Frame-Options: DENY`. It verifies blocked iframe embedding, successful native loading, the guest's own security settings, app-cookie and preload isolation, native history, refusal of a forged lease, workspace partition separation and cleanup on release. The portable `verify:window-controls` check exercises the official toolbar, pane resizing, modal overlap, tab switching and closure with a simulated native bridge, and checks the iframe fallback in a regular Web client.

The macOS sidebar and titlebar regression runs the official frontend's Desktop boot branch in headless Chromium with a temporary home. It serves the same entry document as Next, supplies real Host injections through a simulated preload contract, and asserts that Desktop transport is active. It checks the shared official header before Workspace selection and after a real blank Session is created, sidebar reopening on the homepage and plugin list/detail pages, the fixed transparent drag region while the original plugin title scrolls, and clickable actions even when scrolled into that region. It also opens the Desktop settings section inside the official Settings dialog, verifies preference and Profile commands, and renders the exact standalone recovery artifact with no Host dependency. Native IPC is simulated for these browser checks. After building, install the test browser once and run:

```sh
corepack yarn workspace dsh-desktop-next exec playwright install chromium
corepack yarn workspace dsh-desktop-next verify:window-controls
corepack yarn workspace dsh-desktop-next verify:onboarding
```

Set `DSH_NEXT_TEST_BROWSER_CHANNEL=chrome` to use an installed Google Chrome instead. Screenshots are saved under `dsh-desktop-next/.desktop-next/verification/`. Native macOS window movement still needs manual verification. Version-scoped package patches share the official conversation header frame and sidebar controls with the empty homepage. On plugin list and detail pages, the collapsed-sidebar toggle reuses the official control and stays fixed beside the macOS traffic lights, independently of content width and scrolling. It does not add the conversation's New Session action. The plugin page keeps its original title, toolbar, layout, and scrolling behavior. An invisible 52px drag region belongs to the stable main column and reaches the top and side gutters without taking layout space or painting over content. Buttons, links, inputs, and other interactive controls opt out of native dragging, including when they scroll into this region.

## App icon resources

`build/app-icon.icon` is the editable Icon Composer project with the final NEXT badge layout and System Dark background. On macOS with Xcode 27 and Icon Composer, run `corepack yarn icons:export --channel next` from the repository root to refresh `build/app-icon.png`, the Windows `build/app-icon.ico`, native compiler output `build/app-icon.icns`, and the development Dock image `build/app-icon-mac.png`. Commit these files and `build/app-icon.resources.json` together; `corepack yarn icons:check` verifies them headlessly on any OS.

Next macOS packaging consumes the layered `.icon` source and compiles `Assets.car`, as Stable and Beta do. The raster Dock image is used only during unpackaged development; Windows and Linux windows use their ICO and PNG exports respectively.

## Usage

Use **Settings → Desktop settings** in the official frontend. A notice at the top links to the **Plugins** page for plugin-market and remote-control settings; it closes Settings and opens Plugins in the same main window. The tray’s **Settings…** entry and `CmdOrCtrl+,` reveal the main window and open the same official Settings dialog; there is no separate settings window. Recovery and Profile tools retain their existing windows. If the Host fails, the settings shortcut opens the recovery assistant. Switching Profiles saves the selection and fully relaunches the application after the old Host stops. Port changes restart only the Host; both interrupt active tasks. Browser and LAN access toggles apply immediately without restarting.

- **Tray and background operation:** retain the original Desktop ordering: open the main window, reload the interface, open DSH Terminal, export diagnostics, enter/exit safe mode, then select or create a Profile. Desktop settings and the recovery assistant remain directly accessible. Native menus follow the in-app language. Closing the main window keeps the Host and remote connection running when background operation is enabled and a tray is available. Explicit Quit and application relaunch first hide the existing windows, then wait for the HTTPS edge and Host to stop before exiting or relaunching. Restarting only the Host retains the main window. Without a usable tray, closing the main window quits rather than leaving an inaccessible process.
- **Sidebar browser:** the desktop app reuses the official Browser toolbar and supplies isolated Electron `WebContentsView` pages. GitHub and other sites with anti-framing policies can load as top-level pages without removing CSP or `X-Frame-Options`. Native history and observed URLs drive Back, Forward and the address bar. Views follow pane bounds and zoom, leave resize handles accessible, hide beneath modals or overlapping panes, and close with their tab or renderer. Each tab uses an in-memory session without the app preload, app cookies, Node access, downloads or automatic permission grants. Ordinary Web clients retain the official iframe carrier.
- **Desktop preferences:** background operation, macOS transparency, local/LAN access, log level, and separate notifications for completed/failed user turns. Background jobs never send notifications. The page reuses the existing Desktop grouped cards, Profile choices and notification toggles. Toggles and materials save immediately. The official Settings header provides terminal and restart shortcuts, including reload, application restart and restart into recovery. As in the existing Desktop, Windows has no material choice and always uses an opaque window; old Acrylic or Mica preferences are read as off. The OS must also allow notifications. Notifications only appear while the main window is unfocused. Successful turns use the current user message as the title and the final visible assistant reply as the body, with bounded text previews. Failed turns use a generic status; subagents and automated turns do not notify.
- **Profiles:** fresh installations and isolated safe mode use `desktop` by default. A saved selection is retained, including an older Profile named `default`; existing Profile directories are not renamed or overwritten. Create, switch, open, or remove an inactive Profile. New Profile from the tray focuses the name and offers creation followed by switching. Malformed manifests and Profiles missing the Next bundle are marked unavailable; selecting the already-active Profile does not restart it. Removed Profiles move into recovery backups; the active Profile and `desktop` cannot be removed. Profiles have separate plugin dependencies, activation lists and patches. Sessions, settings and credentials follow upstream rules and are shared within one Next home; Profiles do not isolate accounts or data.
- **First-run setup:** Desktop setup runs first when its own per-Profile completion record or explicit reopen request requires it. When it is not required, completed, or skipped, the official rc.2 account onboarding independently evaluates its account, API-key, and saved-progress conditions. Neither flow completes or resets the other. The original five-page Next onboarding component is embedded in the official surface and theme: welcome, plugin market, remote control, Computer Use (including the existing permission dialog), and recovery guidance. Its original text, artwork, navigation, and choices are retained. There is no separate pre-Host welcome window. Back retains draft choices; Finish saves the Profile features and Computer Use provider, records completion last, and restarts the Host. Skip preserves existing choices. Interrupted flows resume, completed Profiles do not repeat automatically, and safe/recovery modes bypass Desktop setup. Desktop settings → Desktop tools → Setup wizard can reopen it with current choices through a confirmed restart. The compatibility patch adds a continuation slot because rc.2 does not publish a third-party onboarding extension API.
- **Markets:** plugin markets are off by default for new Profiles. The switch at the top of the official **Plugins** page enables or disables the last selected market (or `dsh-community-market` if none was selected in this view); choose `dsh-community-market` or `dshmarket` there. The choices reuse the original Desktop names, descriptions and repository links. Choosing one disables the other in a single official plugin-manager operation and retains installed plugins. Community Market keeps its sidebar entry; dshmarket keeps **Settings → Plugin Market**. Community Market retains discovery, sources, installation previews, confirmation and removal. Package operations use the bundled pnpm. Completed operations can request a restart; the terminal action is available on macOS and Windows.
- **Remote control:** the separate switch at the top of **Plugins** enables `@agents-anywhere/dsh-bridge-next` (off by default). The gear to its left opens the existing phone connection dialog, also available from the sidebar. The gear becomes available after enablement. AA uses its default state directory (`~/.agents-anywhere/dsh-bridge-next`), sharing login, device binding and Connector settings with Stable/Beta and other Next Profiles. Enablement remains per Profile; switching Profiles stops the previous Host and its remote connection. Existing Next-generated per-Profile state overrides are removed on the next Host start. Old state directories are retained without merging credentials; users who only signed in to the former isolated store may need to sign in again. AA's shared-state ownership checks still apply when multiple editions run concurrently.
- **Desktop tools:** open the data/Profile/log directories, reload the interface, open developer tools, export diagnostics, and open a macOS/Windows terminal with this installation’s `dsh`, `pnpm` and Electron-backed `node`. The terminal selects the original Profile even while the main app is in safe mode.

Markets, remote control and Computer Use appear above the ordinary plugin list, aligned to its content width. Remote control and Computer Use stack vertically, with settings gears to the left of their switches. The markets and remote bundle no longer appear again as ordinary plugin cards. These controls still use the official manager and persist in the current Profile; an existing Profile with both markets active asks the user to choose one. Bundle plugins installed by either market remain in the ordinary list for enablement, disablement and removal. dshmarket’s own plugin-disable behavior is unchanged. Existing choices migrate once from `desktop-next.features.json` into `package.json`; subsequent starts respect the official manager.

Sidebar extension entries reuse the original Desktop footer layout: entries stack vertically above Settings, with bounded scrolling to preserve the workspace list.

**Automation tasks** appears in the official Plugins group with upstream artwork, its experimental badge, the native enable switch, and component details. It is optional and disabled by default. Next preserves existing Schedule choices and their legacy Profile migration; it adds no separate Scheduled Tasks card.

### Browser and LAN access

Browser access is disabled by default. Enabling local access provides an authenticated loopback login link; enabling LAN access adds an HTTPS/WSS edge while the Host stays bound to `127.0.0.1`. Ports default to `0` (automatic). Access toggles do not restart the Host. Disabling browser access also disconnects existing browser WebSockets while preserving native streams and running tasks. Port changes require a Host restart. LAN addresses are sampled at startup; restart after a network change.

The settings page displays the complete local login URL and a separate HTTPS login URL for every LAN address, including the browser `token`. Each row opens or copies that exact URL. The login links are read through sender-validated native IPC and kept out of general runtime state and diagnostics. The page can also export the installation’s public CA certificate. Trust that certificate on the other device after comparing its SHA-256 fingerprint. Login links grant access and should only be shared with trusted devices. The CA private key is sealed with OS-backed storage; if secure storage or a suitable LAN address is unavailable, LAN HTTPS stays closed and the UI shows the failure. Native renderer credentials are never copied into these links and are stripped at the LAN edge.

### Native permissions and Computer Use

The gear beside Computer Use and **Settings → Desktop settings → Permissions** open an in-app permission dialog built with the official Modal, Button and StateDot components. It shows screen-recording, macOS Accessibility and microphone status. Opening the dialog only queries permissions. A user click requests OS consent or opens the corresponding system privacy pane. On macOS, changes made in System Settings may require restarting the application. Windows microphone restrictions link to Windows privacy settings; unsupported status APIs report `unknown`, never a fabricated grant.

Next provides the `desktopPermissions` Cordis service to native client plugins and Host plugins. Import its types from `dsh-desktop-next/permissions` and inject `desktopPermissions`. Ordinary browser clients do not receive this service. Its methods are `query(permission)`, `request(permission)` and `openSettings(permission)`, where permission is `microphone`, `screen` or `accessibility`. Results include `status`, `canRequest` and `canOpenSettings`.

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from 'dsh-desktop-next/permissions'

export const inject = ['desktopPermissions']

// Call directly from the native client plugin's Record button.
export async function record(ctx: Context) {
  const state = await ctx.desktopPermissions.request('microphone')
  if (state.status === 'denied' || state.status === 'restricted') return
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  // Pass the stream to the recorder; stop every track when recording ends.
  return stream
}
```

Client requests require an active user gesture and the owning foreground window. Host requests cannot impersonate a user gesture: they reveal the permission dialog in the main window and return the current OS state, so the plugin must recheck after the user authorizes. Native settings requests made before the client mounts are retained for delivery. Host IPC uses correlated, bounded requests and rejects pending work on teardown. Permission status is always read again from the OS.

Screen sharing uses `navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })` directly from the user's Share button. On macOS 15 and later, Electron uses the system picker; other systems use a native source-selection menu. No source is selected automatically. Per-capture system-picker consent can differ from the global screen-recording grant. The permission service does not record media, and screen sharing does not grant computer input control. Packaged Next retains its product-specific `NSMicrophoneUsageDescription` and signs the main application and Helpers directly with the pinned upstream `apps/desktop/scripts/macos-entitlements.plist`. Voice input uses Chromium/macOS recording consent through `getUserMedia`; the voice plugin has no separate permission button.

The official `@deepseek-ai/dsh-experimental-computer-use-cua-driver-native@0.1.6-alpha.2` provider is bundled and **disabled by default**. Use the Computer Use section at the top of **Plugins** to enable it and read its live loading status. This entry uses the official Plugins slot, switch and plugin manager; its Profile row ID is `computer-use-cua-driver-native`. The shared `computer-use` registry is already provided. Tools and screenshots use existing conversation tool cards and image attachments; screenshot understanding requires a model route declaring image input. The gear to the left of the switch opens the permission dialog.

The version-scoped Yarn patch at `patches/dsh-experimental-computer-use-cua-driver-native@0.1.6-alpha.2.patch` routes `check_permissions` through `desktopPermissions` when available. `prompt: true` reveals the permission dialog for missing grants, then the driver performs a read-only check with `prompt: false`. The driver remains the authority for its own actual permission status; no grant is inferred from the Desktop response. Without the Desktop service, the provider retains upstream behavior. The pinned `@trycua/cua-driver@0.28.0` binary, operation tools, image handling and shutdown ownership are unchanged. Only one provider can register, but that does not serialize concurrent Sessions operating the same desktop.

Unit tests exercise the installed patched provider with a fake native SDK. The optional native activation check requires a supported SDK platform, loads and shuts down the real provider, and sends no input or screenshots:

```sh
corepack yarn workspace dsh-desktop-next verify:host --computer-use
```

The optional `verify:window-controls --computer-use` smoke also enables and disables the real provider through the official frontend in headless Chromium, without calling its computer tools. Native OS consent and actual computer actions still need manual acceptance.

### Recovery

The independent recovery assistant shows the startup error and recent logs even if no Host is running. It offers retry, Profile switching, diagnostics, safe mode, repair, rollback and Quit. Restart in Recovery Mode from the Settings header fully stops the background service before relaunching directly into this assistant. The current Profile and plugins are not loaded until Start or retry is selected.

Recovery opened at startup follows the operating system's preferred language order, choosing the first supported Chinese or English language. It does not need a running Host to select its language. Once the main interface is available, native controls continue to follow the language selected in Settings.

- **Safe mode** starts the official interface in a separate temporary home with only shipped bundles, no original credentials, and remote control, Market and browser access disabled. Original data and configuration remain untouched. Leaving safe mode returns to the original Profile and removes the temporary home; work created in that temporary environment is not retained.
- **Profile repair** backs up the manifest, Profile patch and feature switches before restoring built-in bundles and disabling third-party activation, remote control and Market. A malformed `package.json` can be repaired. Installed plugin files, shared sessions and credentials are retained.
- **Profile rollback** restores the most recent successful Host-start configuration after backing up the current files and verifying the backup checksums. It covers `package.json`, `cordis.patch.yml` and Next feature switches, not installed plugin versions or shared data.
- **Global patch repair** separately backs up and disables the home-level `cordis.patch.yml`; this affects all Next Profiles. Profile repair never silently changes that patch.

Backups stay under `home/recovery/`. Diagnostics export a bounded JSON report with versions, state and redacted logs, without reading session or credential files. Logs can still contain local paths and plugin output; inspect the report before sharing. Local desktop logs are bounded to 128 KiB at `home/logs/desktop-next.log`. Desktop preferences live independently of Host settings in `home/desktop-preferences.json`.

Development and packaged builds default to `~/.dsh`, sharing Profiles and data with Stable; Next's selected Profile, Desktop preferences and related settings retain their own file names. The former `DSH NEXT/home` below the system application-data directory retains only the saved data-directory selection, so existing manual choices continue to work. Set `DSH_DESKTOP_NEXT_HOME` to an absolute path to choose a dedicated directory. Next does not select its home from the existing `DSH_HOME`. Factory reset still affects the entire current data directory, including data shared with Stable.

Ordinary Web Profiles do not declare `dsh-desktop-next` in `package.json`; Next supplies its capability only in its own Host startup and configuration recomposition. An older Next Profile has that historical bundle entry removed after its manifest is backed up, so Stable or the CLI will not load Next capabilities when opening the same Profile.

## Architecture and provenance

```text
Official Web frontend + official basic Desktop presentation
                        |  dsh-app://app
                 Next Electron main
                        |  authenticated HTTP / WebSocket
                 Electron Node-mode Host
                        |  upstream shared runProfile
                 Official Web bundles + Next bundle
                        |- Community Market
                        |- dshmarket
                        `- Agents Anywhere bridge
```

Alpha.2 replaced alpha.1's portless pipes with WebServer. This package uses the real upstream WebServer rather than simulating HTTP routes. The Host binds only to `127.0.0.1`, with an OS-assigned port by default so other editions can run concurrently. A separate optional TLS edge owns LAN ingress. Main retains Host cookies and a fresh native capability for each Host generation; ordinary HTTP and WebSocket requests are denied while browser access is off. Electron remains pinned to 44.0.0 for compatibility with the upstream native modules. Before forwarding a Host request, the main process attaches its native capability only to requests from the owned main frame at `dsh-app://app`, stripping that marker from other destinations and redirects. Native fetches may omit the HTTP `Origin` header. Market requests also require Host authentication, and mutations retain their translated loopback origin checks.

The main interface consumes official frontend artifacts without copying chat, settings, or plugin-manager pages. macOS window material, platform markers, the Windows caption menu, and native theme synchronization follow the official implementation. Next contributes its Desktop section through `settings.section` and header shortcuts through `settings.action`. The Desktop section directly reuses `dsh-plugin-desktop-beta`'s `DesktopSettingsSection`, header actions and stylesheet. Recovery and Profile windows reuse its native React pages, frame and UI components. Next supplies state and command adapters, and capability options hide unsupported features; it does not maintain a second copy of those pages. Shared component changes are mirrored to Stable while preserving both editions' defaults. Narrow sender-validated IPC exposes only named native actions. Ordinary browsers receive no native Desktop bridge.

Next contributes an application-owned profile layer at runtime; its recomposition hook keeps the layer active through shared plugin-manager operations and HMR without adding it to the shared Profile manifest. Version-scoped patches read `dsh.optionalBundles` and `dsh.exclusiveBundles` from the installation manifest and add `plugins.overview` and `plugins.bundle.hidden` slots to the published plugin-manager UI. Next uses these slots for the top controls and to omit duplicate bundle cards; installations without an exclusive group keep the original manager behavior. The dshmarket package runner uses the official `runPluginCommand` operation with Next’s Profile, installation anchor and bundled pnpm; it does not require pnpm on the system PATH. Development startup creates one managed link for Next itself under `home/profiles/node_modules`; alpha.2 runtime resolution owns all other dependency fallbacks. All upstream runtime dependencies come from published packages, without source links into or edits to `deepseek-harness/`.

[upstream-reference.json](upstream-reference.json) records the reference commit and original hashes of copied files; [LICENSE.upstream](LICENSE.upstream) retains the original license.

## Current limits

Packaging entry points and the Next update client are implemented. Releases still require producing and validating platform artifacts and configuring the online Next channel. Stable/Beta data migration is not provided. The official distribution's offline Python/Office runtime and skill payloads are not yet integrated. Our enhanced/extended window modes remain deferred. An unpublished Next update channel is reported as unavailable; Next never installs a Stable/Beta package. Enhanced window modes remain hidden. Headless Node/Electron checks do not qualify cross-platform installers or visual behavior.

## Packaging and updates

The product version is `2.0.14-next`. Run from the repository root:

```sh
corepack yarn package:dir:next
corepack yarn dist:mac-smoke:next
corepack yarn dist:mac:next
corepack yarn dist:win:next
```

Packaging reuses Beta's directory builds, universal macOS DMGs, signing/notarization preflight and Windows x64 NSIS flow, including its unsigned Windows build policy. Runtime layout remains `asar: false`, with `RunAsNode`, a complete dependency closure and both macOS native architectures. Next does not require the legacy shell's fs-ext lock binding. These commands build artifacts without publishing or opening a GUI; release gates still require the latest AA preparation and repository checks.

Settings and the tray expose update checks. Packaged builds check shortly after startup and every six hours; downloads start only on a user click. The tray displays bytes or a percentage, then Install and restart. Installation hides windows and stops the Host before handing off. macOS verifies Next identity, version and signing team, packages the application from the downloaded DMG into a local ZIP, and hands it to Electron's Squirrel.Mac for signature validation and replacement, without implementing our own application replacement or weakening signing. Windows verifies the Next installer identity/version and hands off to NSIS for a silent update and relaunch. Development runs can check but cannot replace the source tree or development Electron runtime.

The AA landingpage contract is `GET https://www.dshdesktop.cn/api/desktop/version`, with `X-DSH-Desktop-Channel: next` and the installed version; installation identity is sent only to this endpoint. Downloads use `/api/downloads/mac` or `/api/downloads/windows` with a pinned `X-DSH-Desktop-Target-Version`. Storage redirects receive none of these headers. Only Next versions are accepted; SHA-256 is enforced when supplied. Failures, unpublished channels and older servers never appear as up to date. The service must deploy Next support and configure real artifacts whose embedded version matches the response (`x.y.z-next` or `x.y.z-next.N`).

Installer bytes travel over Chromium `net.request` rather than `net.fetch`: with `redirect: 'manual'` Electron's fetch rejects a redirect (`Redirect was cancelled`) instead of returning the 3xx response, so the release service's `302` to its storage path could never be followed. The transport issues one request per hop, validates every hop with the same HTTPS-and-default-port rule, drops the release selectors after the first hop, and keeps installer traffic on a non-persistent session partition so it carries no application cookies. The macOS and Windows download endpoints redirect to storage; a client that can only accept a direct `200` cannot update.
