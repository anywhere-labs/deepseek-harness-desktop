# DSH Desktop FAQ

[中文](faq.md)

This page answers common questions about installation, supported platforms, the bundled runtime, and plugins in the current stable release. The [latest GitHub Release](https://github.com/anywhere-labs/deepseek-harness-desktop/releases/latest) and [user guide](user-guide.en.md) define the shipped product scope.

## What is DSH Desktop?

DSH Desktop is an open-source DeepSeek Harness desktop client for Windows, macOS, and Linux. It packages the official Harness local Web UI, Host service, and plugin system into a native desktop application with a window, system tray, terminal, updates, and profile management.

## Is this an official DeepSeek product?

No. DSH Desktop is an independent, community-maintained open-source project. It is not affiliated with or endorsed by DeepSeek. The name only describes its technical relationship with the official [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

## Which operating systems are supported?

Current release installers support Windows x64, universal macOS (Intel and Apple Silicon), and Linux x64 (deb, rpm, and AppImage). Linux arm64 is not supported; cross-platform compatibility code in the source tree does not imply that an installer has been released for that platform. The Linux build only offers compatibility mode, does not include a packaged terminal, and has no in-app update download and no passive update notification; use **Check for Updates…** in the tray to see whether a newer version exists. Minimal desktop environments or container images may be missing `libasound2`, `libgbm1`, `libdrm2`, and `libgl1`; ordinary desktop distributions normally have these preinstalled.

## Do I need to install Node.js, pnpm, or DSH?

No. The installer includes Electron, Node.js, pnpm, and pinned DSH dependencies. Ordinary users can install and launch directly, and Desktop does not modify the global system PATH or user shell configuration.

## Does the first launch download a runtime?

No separate Node.js or Harness core download is required. The installer is larger because it contains the runtime and pinned dependencies, trading download size for a more deterministic first launch and dependency set. Cloud models, update checks, and new-version downloads still require network access.

## Does DSH Desktop modify official Harness?

No. The repository pins an unmodified official Harness checkout. Compatibility mode runs the upstream default Web client. Advanced mode adds Desktop-owned layout and native window presentation through plugins without editing upstream source.

## Is data stored locally?

The Desktop Host, profiles, and DSH home live on the local machine. Whether content is sent to an external service depends on the model or tool providers the user configures; requests to cloud models still go to those providers.

## Can I install DSH plugins?

Yes. DSH Desktop uses the official Harness plugin system. Open DSH Terminal from the tray and run `dsh plugin add`, `dsh plugin remove`, or `dsh plugin update`. These commands default to the active profile, and Desktop must be restarted after plugin changes.

## Does the Desktop profile automatically sync with an existing web profile?

No plugins are copied automatically. Each profile has its own bundle and dependency composition. After switching profiles, default plugin commands target the active profile; `--profile <name>` can always select one explicitly.

## How are updates installed?

Packaged applications check for stable releases in the background but never install silently. A newer version requires confirmation. Before downloading, a native save dialog lets you choose the installer's directory and filename; cancelling it does not start a download. macOS downloads and opens a DMG; Windows downloads and starts an NSIS installer. After the upgrade and next launch, the app asks whether to delete or keep the installer. Network and download failures leave the current installation intact.

## Where can I download the app or report a problem?

Download from the [project download page](https://www.dshdesktop.cn/) or the [latest GitHub Release](https://github.com/anywhere-labs/deepseek-harness-desktop/releases/latest). Check the [troubleshooting section](user-guide.en.md#troubleshooting) first. If the problem remains, open a [GitHub Issue](https://github.com/anywhere-labs/deepseek-harness-desktop/issues/new/choose) with the operating system, app version, reproduction steps, and error details.
