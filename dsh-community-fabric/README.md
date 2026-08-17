# DSH Community Fabric

[中文说明](README.zh.md)

DSH Community Fabric is a proposed community interoperability standard for DSH plugins and hosts. Its goal is simple: a plugin should describe what it is and what it needs once, while Desktop, Web UI, TUI, launchers, and distribution tools interpret the same declaration consistently.

> **Current status: Draft and documentation only.** There is no Fabric runtime, SDK, schema release, compatibility badge, or loadable plugin in this workspace yet. This repository's working plugins still use the existing DSH and Cordis APIs.

## Why this project exists

The DSH community now has different user interfaces, launchers, plugin collections, and distribution channels. Authors should not have to guess which host can run a plugin, and users should not have to install it before discovering that it is incompatible.

Fabric proposes four shared building blocks:

1. A static manifest that tools can inspect without executing plugin code.
2. Versioned capabilities that describe what a plugin requests and what a host supports.
3. Predictable activation, deactivation, and event contracts.
4. Machine-readable compatibility results and conformance tests.

The proposal is an interoperability layer, not a replacement for DSH, Cordis, or each host's internal architecture. A host may use its native plugin system behind an adapter while exposing the same community contract to compatible plugins.

## An important safety boundary

Capability declarations are useful for compatibility, consent, and auditing, but they are **not automatically a security sandbox**. A trusted JavaScript plugin running in the same Node.js process may still access operating-system APIs outside the provided context.

Only a host that implements real isolation, controlled module loading, and mediated IPC may claim that a permission is technically enforced. The standard must show users the difference between requested, granted, tested, and enforced capabilities.

## First milestone

The first experimental milestone is intentionally small:

- a static JSON manifest and JSON Schema;
- a machine-readable Host Descriptor;
- required and optional capability negotiation;
- deterministic lifecycle hooks;
- one immutable `messages.observe` event;
- fixtures and a headless conformance suite.

Mutable `before-*` events, sensitive filesystem/network permissions, rich cross-host UI, marketplace certification, and isolated execution require separate proposals and evidence.

Community review also exposed several important problems that should not be forced into the first milestone. Remote execution and the interface currently calling it need separate identities; plugins that provide shared services need deterministic composition; and users need to know what a plugin changed and whether it cleaned up. These topics now have focused Draft RFCs so they can be reviewed and tested independently without expanding v0.1 by implication.

## Read and participate

- [Compatibility layer and developer framework](docs/architecture/compatibility-layer.md)
- [RFC 0001: Plugin Manifest, Capabilities, and Events](docs/rfcs/0001-plugin-manifest-capabilities-events.md)
- [RFC 0002: Runtime, Presentation, Control, Transport, and Invocation](docs/rfcs/0002-runtime-presentation-invocation-transport.md)
- [RFC 0003: Service Providers and Deterministic Composition](docs/rfcs/0003-service-providers-and-composition.md)
- [RFC 0004: Provenance, Validation, Diagnostics, and the Effect Ledger](docs/rfcs/0004-provenance-validation-and-diagnostics.md)
- [Review of Community Issue #23 and the disposition of each proposal](docs/research/community-issue-23-review.md)
- [Research: lessons from Koishi, Chrome, and VS Code](docs/research/mature-plugin-frameworks.md)
- [Research: the VS Code extension model and its RFC implications](docs/research/vscode-extension-model.md)
- [Research: what real DSH plugins need](docs/research/dsh-plugin-needs.md)
- [Existing DSH plugin development](../docs/plugin-development.en.md)
- [Community plugin ecosystem manifesto](../docs/plugin-ecosystem.en.md)

The RFC is a discussion draft, not an official DeepSeek or DSH standard. Open an issue, start a discussion, or propose edits by pull request. Plugin authors, GUI/Web UI/TUI maintainers, launcher maintainers, market maintainers, security reviewers, and ordinary users are all invited.

DSH Community Fabric is not affiliated with FabricMC. The name describes a community compatibility fabric around DSH.

## License

The proposal and future reference code are licensed under the [MIT License](LICENSE).
