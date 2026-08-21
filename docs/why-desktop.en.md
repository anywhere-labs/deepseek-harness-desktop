# Why DSH Desktop Exists

## The problem

DeepSeek Harness is a composable agent harness. It is powerful from the command line and through its Web UI, and it lets developers combine models, tools, sessions, and workflows into their own runtime. For a first-time user, however, Node.js, profiles, dependency installation, ports, and process lifetime are still part of the experience.

DSH Desktop does not reimplement Harness. It puts the same runtime into an application that is easier to start and manage on a desktop operating system:

- The installer provides Electron, a Node runtime, and pinned DSH dependencies.
- The application owns the window, tray, single-instance lock, shutdown, and local-service lifecycle.
- Users keep using the official DSH profiles, plugins, sessions, and Web UI.
- Upstream Harness remains authoritative for agents, models, tools, sessions, and Web client behavior.

Desktop is therefore a product entry point and runtime adapter. It is not a replacement for upstream Harness and it is not a second copy of the upstream source that must permanently diverge.

## Why plugins

Harness follows an “everything is a plugin” model. Desktop keeps the same principle for three practical reasons:

1. **Upstream behavior stays replaceable.** Desktop can use the official Web client, while a profile can add model, tool, UI, or workflow plugins.
2. **Desktop behavior stays extensible.** Profile management and the packaged package-manager environment can be exposed as explicit Host services instead of making every plugin guess at Electron internals.
3. **Ownership stays clear.** Upstream DSH owns agent semantics, Desktop owns native integration, and third-party plugins depend only on the contracts they need.

The plugin boundary also tells us what not to expose. Third-party plugins can only use clearly published interfaces; they cannot directly control the window, tray, installers, or other internal implementation. A stable boundary is easier to upgrade and debug than an unrestricted private API. See [plugin development](plugin-development.en.md) for the published interface details.

## What Desktop provides

The current Desktop product provides:

- Native windows, a tray, and single-instance lifecycle on macOS, Windows, and Linux.
- Compatibility and advanced presentation modes. Compatibility preserves the upstream client; advanced adds Desktop-owned layout, native materials, and drag regions.
- Multiple profile selection. Desktop exposes the active profile identity for the current generation, and switching takes effect through an orderly restart.
- A bundled terminal and pinned pnpm environment. They apply only to processes created by Desktop and do not modify the user's global PATH.
- A controlled set of extension interfaces for plugin developers (see [plugin development](plugin-development.en.md)).
- Version discovery and confirmation-gated installer downloads, handing off to a macOS DMG or Windows NSIS installer.

## What we deliberately do not do

- Reimplement the upstream Web UI as an Electron-native page.
- Override the upstream layout, sidebar, or conversation composition in compatibility mode.
- Copy records into a separate “Desktop database”; official profiles share the DSH home for sessions and settings by default.
- Give third-party plugins an undefined private Electron API.
- Present roadmap items such as a plugin marketplace, mobile remote control, or Channels as shipped features.

## Who should read this

- Users who want to install and use Harness: start with the [user guide](user-guide.en.md).
- Users installing or building DSH plugins: read [plugin development](plugin-development.en.md), then the [Desktop service contract](../dsh-plugin-desktop/docs/plugin-services.md).
- Maintainers working on startup, profiles, or packaging: read the [architecture](architecture.en.md) and the package [README](../dsh-plugin-desktop/README.md).
