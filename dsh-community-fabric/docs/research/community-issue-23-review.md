# Community Issue #23: Review and Disposition

English | [中文](community-issue-23-review.zh.md)

| Field | Value |
| --- | --- |
| Source | [omdsh-dev/community issue #23](https://github.com/omdsh-dev/community/issues/23) |
| Snapshot | 2026-08-17; Open; 13 comments; no milestone or accepted specification |
| Purpose | Record which ideas changed the Fabric drafts, which need separate RFCs, and which are not portable core contracts |

## 0. Summary

Issue #23 is valuable design input, not an approved community standard. The comments exposed four gaps in the original proposal:

1. Runtime, Presentation, Control, Transport, and the current Invocation are separate concerns;
2. plugins need deterministic service-provider composition, not just capability checks;
3. compatibility needs machine-readable validation and runtime ownership evidence;
4. migration from private patches needs an Adapter strategy without turning patches into the public plugin API.

The Fabric documents now absorb those points through a strengthened [RFC 0001](../rfcs/0001-plugin-manifest-capabilities-events.md) and three focused follow-up drafts:

- [RFC 0002: Runtime, Presentation, Control, Transport, and Invocation](../rfcs/0002-runtime-presentation-invocation-transport.md);
- [RFC 0003: Service Providers and Composition](../rfcs/0003-service-providers-and-composition.md);
- [RFC 0004: Provenance, Validation, Diagnostics, and the Effect Ledger](../rfcs/0004-provenance-validation-and-diagnostics.md).

None of these documents claims that a runtime, SDK, schema release, or compatibility certification already exists.

## 1. How decisions are classified

| Disposition | Meaning |
| --- | --- |
| Adopted | The current Fabric drafts include the requirement. |
| Adopted with limits | The underlying need is accepted, but the draft narrows an unsafe or over-broad implementation. |
| Separate RFC | The idea is useful but needs its own contract, evidence, and review before it can become portable API. |
| Adapter experiment | A version-pinned implementation may explore the idea behind the DSH Adapter boundary; plugins cannot depend on it as stable Fabric API. |
| Not portable core | The idea may belong to a product or UI, but it is not a cross-Host Fabric requirement. |
| Recorded | The input is linked for traceability but does not itself create a normative change. |

“Adopted” means adopted by these Draft documents. It does not mean Issue #23 participants reached formal consensus.

## 2. Comment-by-comment disposition

| Community input | Disposition | Result in the Fabric drafts |
| --- | --- | --- |
| [`plugin.json` conflicts with the Agent Plugins specification](https://github.com/omdsh-dev/community/issues/23#issuecomment-5305622804) | Adopted | Fabric uses the unambiguous root filename `dsh-plugin.json` and keeps the document static. |
| [Kubernetes-style type metadata and versioned services/events](https://github.com/omdsh-dev/community/issues/23#issuecomment-5305636433) | Adopted with limits | Schema identity, Fabric API version, capability versions, Host Descriptor version, plugin version, and event type version are separate axes. Fabric does not copy Kubernetes resource semantics wholesale. |
| [Patch/version churn and the need for credible verification](https://github.com/omdsh-dev/community/issues/23#issuecomment-5305638423) | Adopted | RFC 0004 separates listing, declaration, testing, attestation, and enforced isolation. A passing format check is never presented as “safe”. |
| [URL query state for multi-panel Web UI](https://github.com/omdsh-dev/community/issues/23#issuecomment-5305642357) | Not portable core | Deep-link and URL-state conventions belong to a Web Presentation capability. They cannot be required of TUI, native GUI, or headless Runtime implementations. |
| [Installation preview and runtime provenance](https://github.com/omdsh-dev/community/issues/23#issuecomment-5305656025) | Adopted | RFC 0004 defines an installation-impact report, validation report, activation ownership, and a Host-observed effect ledger with cleanup diagnostics. |
| [dsh-forge / dsh-neoforge runtime mixin proof of concept](https://github.com/omdsh-dev/community/issues/23#issuecomment-5305908558) | Adapter experiment | The current [dsh-neoforge proof of concept](https://github.com/r05En1cU/dsh-neoforge) provides useful evidence for explicit conflict detection, reversible ownership, and lifecycle cleanup. Runtime method replacement remains an experimental, version-pinned DSH Adapter technique; manifests cannot carry executable mixin instructions and plugins cannot treat private targets as portable API. |
| [Static validation, separate schema/API versions, capability registry, contribution IDs, migration metadata, and validation reports](https://github.com/omdsh-dev/community/issues/23#issuecomment-5306132230) | Adopted with limits | RFC 0001 requires static JSON, explicit schema selection, an authoritative machine-readable registry, and deterministic contribution identities. RFC 0004 defines report evidence and a read-only `legacyEffects` diagnostic section; declaring a legacy effect never authorizes it. |
| [dsh-TUI as an early conformance implementation](https://github.com/omdsh-dev/community/issues/23#issuecomment-5306241618) | Adopted with limits | Real TUI evidence is welcome and headless conformance is required, but no implementation self-certifies by volunteering. Mutable `before-*` interception remains outside v0.1 until ordering, timeout, cancellation, privacy, and audit semantics are specified. |
| [Remote SSH counterexample, command trees, invocation capabilities, and ephemeral presentation](https://github.com/omdsh-dev/community/issues/23#issuecomment-5306386927) | Separate RFC | RFC 0002 separates Runtime, Presentation, Control, Transport, and Invocation. Presentation capabilities travel with each invocation; command trees and non-persistent presentation messages are first-class draft contracts rather than TUI-only metadata. |
| [Reference Host and attachable Runtime/Presentation model](https://github.com/omdsh-dev/community/issues/23#issuecomment-5306670321) | Adopted with limits | RFC 0002 defines the separation and conformance scenarios. Fabric will define reference components and suites, not bless a single product architecture or require a specific SSH/WebSocket transport. |
| [Dependency locking, replay, and observable environments](https://github.com/omdsh-dev/community/issues/23#issuecomment-5306757296) | Separate RFC | RFC 0004 records immutable artifact and environment evidence. Complete lockfiles, modpacks, migration, rollback, and reproducible workspace distribution remain a later packaging/distribution proposal. |
| [`requires` / `provides` / `contributes` and deterministic composition](https://github.com/omdsh-dev/community/issues/23#issuecomment-5307228009) | Adopted | RFC 0003 defines provider cardinality, user selection, conflict plans, replacement, health, and lifecycle ownership. Load order is not an arbitration mechanism. |
| [Link to the expanded Fabric research and drafts](https://github.com/omdsh-dev/community/issues/23#issuecomment-5308979722) | Recorded | This review closes the loop by linking each community concern to a concrete draft or a documented deferral. |

## 3. Decisions that remain deliberately strict

### 3.1 No demand activation in v0.1

Fabric v0.1 keeps generation-scoped eager activation after negotiation. Lazy activation adds a second lifecycle, concurrent first-use races, delayed failures, and harder cleanup. It can be proposed later with measurements and a complete state machine.

### 3.2 No mutable `before-*` event in v0.1

The first event is immutable observation. A mutation or cancellation hook requires deterministic participant ordering, conflict rules, deadlines, backpressure, error isolation, replay rules, payload privacy, and an audit record. Calling an ordinary event listener “before” does not solve these requirements.

### 3.3 Capability declarations are not a sandbox

A trusted in-process Node.js plugin can import operating-system modules outside its provided context. Fabric can validate, negotiate, record, and reject unsupported calls at its API boundary; only an isolated execution tier with mediated imports and IPC may claim technical enforcement.

### 3.4 Legacy compatibility is owned by the Adapter

Fabric-managed plugins use public contracts. A reviewed DSH Adapter may temporarily map a stable contract to a pinned private seam, but the seam is not exposed to plugin authors. When upstream changes, the Adapter must adapt, degrade, or reject activation instead of asking every plugin to patch a new target.

### 3.5 Products may coexist with legacy loading

Fabric can prohibit bypass loading for Fabric-managed plugins. It cannot claim that every DSH product immediately removes its existing Cordis/plugin/profile paths. Compatibility mode and non-Fabric plugins remain explicit product boundaries during migration.

## 4. What should be built next

The next implementation work should stay smaller than the full vision and distinguish the v0.1 critical path from later experiments.

### 4.1 Experimental v0.1 critical path

1. freeze a Draft manifest Schema, Host Descriptor Schema, capability registry, and event envelope;
2. implement a pure manifest/Host-capability negotiator with no DSH dependency;
3. add a Broker prototype that owns registrations, activation lifetime, and the minimum transition ledger;
4. build one version-pinned DSH Adapter and compare its observed effects with real DSH registrations;
5. publish headless fixtures for supported, degraded, conflicting, cancelled, and incomplete-cleanup cases;
6. collect v0.1 results from at least two Host integrations without treating either implementation as the standard itself.

The v0.1 negotiator covers Host capabilities and the declarations actually supported by RFC 0001. It does not activate plugin-provided services or claim the post-v0.1 extensions proposed by RFC 0002–0004.

### 4.2 Parallel and post-v0.1 exploration

- RFC 0002 may prototype one Runtime with two simultaneous Presentation descriptors so Remote SSH assumptions fail visibly.
- RFC 0003 may build a pure static service-composition planner before it exposes any runtime Provider binding.
- RFC 0004 may prototype installation reports and materialized diagnostics on top of the canonical v0.1 transition ledger.
- TUI, Web UI, and Desktop may contribute evidence without any one product becoming the standard itself.

UI rendering languages, strong sandboxing, package distribution, market attestation, mutable interception, and full reproducibility must remain separate milestones.

## 5. How this record changes

This is a dated review of the linked Issue snapshot. New comments do not silently rewrite a Draft. A material change should update the relevant RFC through review and then update this record with the comment link, disposition, and affected contract.
