# DSH Desktop User Guide

## Installation and first launch

Download the macOS or Windows installer from the product download page. DSH Desktop includes Electron, Node, and its pinned DSH dependencies, so normal users do not need to install Node.js or pnpm separately.

On first launch, the application prepares the default profile and starts the official DSH Web surface locally. Closing the window normally hides it; use **Quit** from the tray when you want to stop the application and Host process.

## Launching with a folder

Besides choosing a directory inside the interface, you can name a folder when the application starts. The folder is registered as a workspace and opened. A folder that is already a workspace is simply opened again; nothing is duplicated.

- **Windows drag and drop**: drop the folder onto the **DSH Desktop** desktop shortcut or its Start menu entry. A stopped application starts first; a running one comes to the front and opens the workspace.
- **Command line**: stable uses `dsh-desktop <folder>` and Beta uses `dsh-desktop-beta <folder>`. Relative paths resolve against the current directory. The installed EXE accepts one folder argument as well.

When the path does not exist, names a file, or lives on unsupported storage such as exFAT, FAT32, or a network drive, the application shows a native message and registers nothing. Launching with a folder is one-shot: a later restart triggered from settings does not reopen it.

Known limits: a DSH Desktop icon pinned to the Windows taskbar does not accept drops yet (that needs a folder association, planned separately); Linux supports the command line only; macOS supports neither route yet.

## Profiles

A profile is a composition of DSH bundles, dependencies, and patches. The tray **Profile** menu lists existing profiles and the lazy `desktop` and `web` defaults.

Selecting a profile performs an orderly restart. The new profile becomes the last-known-good choice only after the Host, window, and browser client all start successfully; a failed startup returns to the previous working choice. Official profiles normally use the same DSH home, so sessions, settings, and storage do not need to be migrated. A custom configuration (patch) can deliberately redirect a persistence root, in which case that profile's configuration wins.

Switching profiles does not silently copy plugins from the old profile into the new one. Use an explicit profile in the terminal when preparing another profile, or use the default commands after switching.

## Window modes and materials

- **Compatibility mode** keeps the selected profile's official layout/sidebar/conversation composition intact below a separate 36-pixel Desktop frame. The frame is draggable, its icon actions remain clickable, and official dialogs stay inside the unrelated content viewport below it.
- **Extended window** installs the Desktop-owned layout and sidebar surface, then hosts the official sidebar, conversation, and details occupants inside it. The 36-pixel top frame and left sidebar surface form one inverted-L material region with a rounded inner corner.
- **Enhanced mode** retains its dedicated root registration and compact internal captions: macOS uses a 20-pixel content inset with a 32-pixel drag region, while Windows uses a 32-pixel caption row. It does not reuse the independent extended frame.

macOS custom-window modes can turn the transparent material on or off. Windows has no material choice and always uses an opaque window. Legacy Windows Acrylic and Mica preferences are safely treated as off; Acrylic is also migrated when its settings file is writable. Changing mode or material restarts the application; it does not hot-swap root slots or native materials in a live renderer. Linux provides compatibility mode only.

## Local Web port

Desktop lets the operating system choose a random local Web port by default (`dsh-desktop.port: 0`), which avoids collisions with other services. Browser `localStorage` is isolated by origin, so UI plugins that store settings there need a fixed port to read the same settings after Desktop restarts:

```yaml
dsh-desktop:
  port: 43189
```

The port must be an integer from `0` through `65535`. Changing it performs an orderly restart. The service binds only to `127.0.0.1` by default; it listens on all network interfaces only after you acknowledge the danger prompt and explicitly allow LAN access in Desktop settings. If another program already uses a fixed port, Desktop cannot start; release that port or change the setting back to `0` or another available port.

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

Choose **Open DSH Terminal** from the tray, Desktop settings, or the Desktop frame. The settings action has a restart menu beside it for an ordinary restart or **Restart in Recovery Mode**; both require confirmation. macOS opens Terminal; Windows prefers Windows Terminal and falls back to PowerShell or Command Prompt when it is unavailable.

The welcome text shows the application version, active profile, profile directory, and DSH home. Desktop creates private `dsh`, `pnpm`, and `node` shims in its user-data directory and prepends that directory only for the new terminal process. It does not modify the system PATH or the user's shell files.

## Updates

Packaged macOS and Windows applications check `https://www.dshdesktop.cn/api/desktop/version` in the background. Startup is not blocked; network errors, non-200 responses, invalid versions, and a server version that is not newer remain silent in the background. A newer version updates the tray and raises one non-blocking system notification per version instead of opening a download confirmation automatically; clicking the notification reveals Desktop.

**Check for Updates…** in the tray checks the current release channel: stable receives only stable updates, while Beta receives only Beta updates. It shows a result even when the installed version is current and reports a retry message when the check fails. Beta also provides **Install Stable Edition…**, which installs stable alongside Beta. Cancelling never requests the counted download endpoint.

After confirmation, the app first opens the native **Save Update Installer** dialog, defaulting to the Downloads directory. You can choose another directory and filename; cancelling the dialog does not start a download. After the destination is confirmed, the app requests the fixed platform download URL and remembers the installer location. macOS opens the DMG for the user to replace the application in Applications; Windows prepares the NSIS installer and then asks whether to quit and start installation. After the upgrade completes and the app starts again, it asks whether to delete the installer to free disk space or keep it. Download or installer failures do not damage the current version, and the tray operation can be retried.

## Troubleshooting

Desktop confirmations, warnings, and operation results open as separate shadcn-backed modal Desktop windows rather than as overlays inside the official page. The Recovery window first shows why it opened and then provides **Plugin management**, **Rollback**, **Switch Profile**, and **Diagnostics** tabs. Its top utility frame and the Profile creation frame intentionally contain no duplicate title.

- **The application reaches the tray**: right-click the tray icon and choose **Export Diagnostics…**. After the privacy confirmation, Desktop creates a `diagnostics-*.zip` archive and reveals it in the file manager.
- **The application crashes repeatedly before the tray appears**: run the installed executable directly with the recovery option. The default Windows installation command is below; replace the path if you selected another installation directory.

  ```powershell
  & "$env:LOCALAPPDATA\Programs\DSH Desktop\DSH Desktop.exe" --export-diagnostics
  ```

  For npm installs, stable uses `dsh-desktop --export-diagnostics` and Beta uses `dsh-desktop-beta --export-diagnostics`. This command does not start Host, profiles, plugins, or a window. It prints the absolute diagnostics ZIP path when complete.
- **Diagnostic archive contents**: recent application logs, local Crashpad `.dmp` files, the active-run marker, and `system-info.txt`. System information records Desktop, Electron, Node, platform, and architecture versions. Recognized credentials are masked in logs, but local paths, workspace IDs, session IDs, and crash-time memory fragments may remain. Review the archive before public upload and send sensitive dumps only through a trusted channel.
- **The window disappeared**: check the system tray; closing the window is not quitting.
- **A plugin is missing**: confirm the command targeted the intended profile and restart the application.
- **A terminal command is missing**: open a fresh Desktop terminal from the tray; Desktop does not modify the global PATH.
- **No update notification appeared**: background failures are silent; use the manual tray check to see the result.

The lower-level lifecycle, packaging, and platform limits belong to the developer documentation; see the [documentation index](README.md).
