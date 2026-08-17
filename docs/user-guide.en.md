# DSH Desktop User Guide

## Installation and first launch

Download the macOS or Windows installer from the product download page. DSH Desktop includes Electron, Node, and its pinned DSH dependencies, so normal users do not need to install Node.js or pnpm separately.

On first launch, the application prepares the default profile and starts the official DSH Web surface locally. Closing the window normally hides it; use **Quit** from the tray when you want to stop the application and Host process.

## Profiles

A profile is a composition of DSH bundles, dependencies, and patches. The tray **Profile** menu lists existing profiles and the lazy `desktop` and `web` defaults.

Selecting a profile performs an orderly restart. The new profile becomes the last-known-good choice only after the Host, window, and browser client all start successfully; a failed startup returns to the previous working choice. Official profiles normally use the same DSH home, so sessions, settings, and storage do not need to be migrated. A custom configuration (patch) can deliberately redirect a persistence root, in which case that profile's configuration wins.

Switching profiles does not silently copy plugins from the old profile into the new one. Use an explicit profile in the terminal when preparing another profile, or use the default commands after switching.

## Compatibility and advanced modes

- **Compatibility mode** uses the upstream Web client and the selected profile's own layout/sidebar/conversation composition. It is the closest presentation to ordinary Harness.
- **Advanced mode** keeps the same upstream Web carrier while adding Desktop-owned framing, layout, Mica/vibrancy, and native drag regions. It is intended for a fuller desktop presentation.

Changing mode restarts the application; it does not hot-swap root slots or native materials in a live renderer. Linux provides compatibility mode only.

## Plugin management

Plugins are extensions that add capabilities to DSH, such as models, tools, interfaces, and workflows. DSH Desktop uses the same plugin system as official Harness, so official plugins install and work directly; multiple plugins follow the same conventions and can be installed and used together.

Ordinary DSH plugins use the upstream CLI semantics:

```sh
dsh plugin --profile desktop add <plugin>
dsh plugin --profile desktop remove <plugin>
dsh plugin --profile desktop update
```

In the terminal opened from the DSH Desktop tray, bare `dsh` and plugin commands without `--profile` default to the active profile:

```sh
dsh plugin add <plugin>
dsh plugin remove <plugin>
dsh plugin update
```

An explicit `--profile <name>` always wins. Restart DSH Desktop after plugin changes so the new bundle enters the Loader composition.

## Opening the terminal

Choose **Open DSH Terminal** from the tray. macOS opens Terminal; Windows prefers Windows Terminal and falls back to PowerShell or Command Prompt when it is unavailable.

The welcome text shows the application version, active profile, profile directory, and DSH home. Desktop creates private `dsh`, `pnpm`, and `node` shims in its user-data directory and prepends that directory only for the new terminal process. It does not modify the system PATH or the user's shell files.

## Updates

Packaged macOS and Windows applications check `https://www.dshdesktop.cn/api/desktop/version` in the background. Startup is not blocked; network errors, non-200 responses, invalid versions, and a server version that is not newer remain silent in the background.

**Check for Updates…** in the tray is a manual check. It shows a result even when the installed version is current, and reports a retry message when the check fails. Only a server version strictly newer than the local version produces a download confirmation. Cancelling never requests the counted download endpoint.

After confirmation, the app requests the fixed platform download URL. macOS opens the DMG for the user to replace the application in Applications; Windows prepares the NSIS installer and then asks whether to quit and start installation. Download or installer failures do not damage the current version, and the tray operation can be retried.

## Troubleshooting

- **The window disappeared**: check the system tray; closing the window is not quitting.
- **A plugin is missing**: confirm the command targeted the intended profile and restart the application.
- **A terminal command is missing**: open a fresh Desktop terminal from the tray; Desktop does not modify the global PATH.
- **No update notification appeared**: background failures are silent; use the manual tray check to see the result.

The lower-level lifecycle, packaging, and platform limits belong to the developer documentation; see the [documentation index](README.md).
