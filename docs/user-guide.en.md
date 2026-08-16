# DSH Desktop User Guide

## Installation and first launch

Download the macOS or Windows installer from the product download page. DSH Desktop includes Electron, Node, and its pinned DSH dependencies, so normal users do not need to install Node.js or pnpm separately.

On first launch, the application prepares the default profile and starts the official DSH Web surface locally. Closing the window normally hides it; use **Quit** from the tray when you want to stop the application and Host process.

## Profiles

A profile is a composition of DSH bundles, dependencies, and patches. The tray **Profile** menu lists existing profiles and the lazy `desktop` and `web` defaults.

Selecting a profile performs an orderly restart. The new profile becomes the last-known-good choice only after the Host and window start successfully; a failed startup returns to the previous working choice. Official profiles normally use the same DSH home, so sessions, settings, and storage do not need to be migrated. A custom patch can deliberately redirect a persistence root, in which case that profile's configuration wins.

Switching profiles does not silently copy plugins from the old profile into the new one. Use an explicit profile in the terminal when preparing another profile, or use the default commands after switching.

## Compatibility and advanced modes

- **Compatibility mode** uses the upstream Web client and the selected profile's own layout/sidebar/conversation composition. It is the closest presentation to ordinary Harness.
- **Advanced mode** keeps the same upstream Web carrier while adding Desktop-owned framing, layout, Mica/vibrancy, and native drag regions. It is intended for a fuller desktop presentation.

Changing mode restarts the application; it does not hot-swap root slots or native materials in a live renderer. Linux provides compatibility mode only.

## Plugin management

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

Open **Settings → General → Software update** to see the installed version and update state. A manual check distinguishes an up-to-date installation, an unreachable GitHub connection, a GitHub Release that lacks updater files, download or storage failures, and an installation that could not start. The tray provides the same state-dependent action.

Packaged macOS and Windows applications check stable Releases from `anywhere-labs/deepseek-harness-desktop` 60 seconds after startup and six hours after each completed check. A new release creates a dismissible in-app notice. Prereleases, downgrades, source checkouts, GitHub tokens, and arbitrary download URLs are excluded.

Signed and notarized macOS packages download the update in the app and expose **Restart and update** after verification. Signed Windows packages use the same flow. An unsigned Windows package and Linux open the fixed GitHub Releases page for manual installation. Cancelling waits for the active transfer to stop before download can be retried.

Version 2.0.1 is the updater bootstrap and must be installed manually. Releases from 2.0.2 onward can use the complete in-app flow when the running and target packages both declare automatic installation support.

## Troubleshooting

- **The window disappeared**: check the system tray; closing the window is not quitting.
- **A plugin is missing**: confirm the command targeted the intended profile and restart the application.
- **A terminal command is missing**: open a fresh Desktop terminal from the tray; Desktop does not modify the global PATH.
- **The update page says updater files are unavailable**: the latest GitHub Release is missing `latest-mac.yml` or `latest.yml`; open the release page for a manual download or wait for the release assets to finish publishing.

For the complete native lifecycle, packaging, and platform limits, see [`dsh-plugin-desktop/README.md`](../dsh-plugin-desktop/README.md).
