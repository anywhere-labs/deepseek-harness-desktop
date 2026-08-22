# DSH Desktop Documentation

[中文文档](README.md)

This directory is the product and developer documentation index for DSH Desktop. The root [`README.en.md`](../README.en.md) is the short product entry point; these pages explain why the project exists, how to use it, and how to build plugins for it. Want to contribute? See [Contributing](../CONTRIBUTING.en.md).

## Read by goal

Ordinary users can start with the [user guide](user-guide.en.md) and never need the developer documentation.

### User documentation

| Document | Covers |
| --- | --- |
| [User guide](user-guide.en.md) | Installation, profiles, modes, terminal, plugins, and updates |
| [Managed WSL Host](../dsh-plugin-desktop/docs/wsl-host.md) | Keep the native Windows shell while the complete Host, profiles, plugins, and workspaces run in WSL 2 |
| [FAQ](faq.en.md) | Direct answers about platforms, bundled runtime, project status, data, plugins, and updates |
| [Why Desktop](why-desktop.en.md) | The boundary with upstream Harness and the case for plugins |

### Developer and maintainer documentation

| Document | Covers |
| --- | --- |
| [Plugin ecosystem manifesto](plugin-ecosystem.en.md) | The vision of an open, composable, sustainable plugin ecosystem and its three principles |
| [Plugin development](plugin-development.en.md) | Ordinary DSH plugins, Desktop services, compatibility, and lifecycle |
| [Community Fabric Draft](../dsh-community-fabric/README.md) | Community interoperability drafts spanning manifest/capability foundations, Runtime/Presentation, service composition, and provenance diagnostics |
| [Fabric community-feedback disposition](../dsh-community-fabric/docs/research/community-issue-23-review.md) | Which Issue #23 proposals were adopted, split into focused RFCs, deferred, or kept out of portable core |
| [Fabric framework and plugin-needs research](../dsh-community-fabric/docs/research/mature-plugin-frameworks.md) | Mature Koishi, Chrome, and VS Code patterns plus requirements observed in real DSH plugins |
| [VS Code extension-model research](../dsh-community-fabric/docs/research/vscode-extension-model.md) | Implemented declaration, Provider, UI, placement, and lifecycle patterns, with concrete constraints for the Fabric RFC |
| [Community Market design](../dsh-community-market/README.md) | The proposed market shell, extensible catalog sources, user selection, install confirmation, and safety boundary |
| [Market catalog provider contract](../dsh-community-market/docs/catalog-provider-contract.md) | Schemas, query parameters, multi-source behavior, and adapter rules for the implementation team |
| [Architecture](architecture.en.md) | Electron, Host, loopback Web, profiles, and packaging |
| [Desktop service reference](../dsh-plugin-desktop/docs/plugin-services.md) | Stable `desktopProfiles` and `desktopPnpm` contracts with TypeScript examples |
| [Package reference](../dsh-plugin-desktop/README.md) | Detailed build, runtime, release, and limitation notes |

## How the README files are organized

The outer repository has two formal product READMEs plus one legacy compatibility entry:

- [`README.md`](../README.md): the Chinese product entry point.
- [`README.en.md`](../README.en.md): the English product entry point with the same product scope.
- [`README.zh.md`](../README.zh.md): a legacy Chinese-path compatibility page with no independent content.

`README.i18n.yaml` records the bilingual blob hashes for those two formal entry points; it is not a user guide. `dsh-plugin-desktop/README.md` and `dsh-plugin-desktop/README.zh.md` ship with the npm package and are the more technical package reference. `dsh-plugin-desktop/docs/` contains stable API contracts rather than marketing copy. `.agents/notes/implemented/` contains dated maintainer decision records and does not replace user documentation.

`deepseek-harness/` is the pinned upstream submodule. Its README and `docs/` belong to the upstream project, not to the Desktop product, and are excluded from the outer documentation inventory.

## Status convention

These pages distinguish shipped behavior, platform limits, and roadmap items. Compatibility mode keeps the upstream default Web client; advanced mode installs the Desktop-owned layout and native materials. The plugin marketplace now has a documentation scaffold in [`dsh-community-market`](../dsh-community-market/README.md), but no usable page or installer; mobile remote control and Channels also remain separate roadmap items and are not implied to be part of the current installer.
