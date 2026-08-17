# RFC 0001: A Unified DSH Plugin Contract — Manifest, Capabilities, and Events

English | [中文](0001-plugin-manifest-capabilities-events.zh.md)

| Field | Value |
| --- | --- |
| Status | Draft / request for comments |
| Target | Experimental v0.1 |
| Scope | Interoperability contract between plugins and Hosts |
| Reference implementation | DSH Community Fabric (not implemented) |
| Discussion | [Community Issue #23](https://github.com/omdsh-dev/community/issues/23), related discussions, and pull requests editing this document |

## 0. Summary

Define a community-governed, statically analyzable interoperability standard for DSH plugins. A plugin declares its identity and capability requirements in a manifest; a Host publishes a machine-readable descriptor and uses negotiation plus a common lifecycle to decide whether and how to activate it.

The proposal borrows the manifest-and-capability idea from browser extensions and the stable lifecycle-hook idea from Forge/Fabric. It does not claim to provide browser-grade isolation, and it must not create a second plugin-loading ecosystem beside DSH and Cordis.

## 1. Draft boundary

This is a community discussion draft, not an official DeepSeek or DSH standard and not an API developers can use today.

Existing DSH plugins continue to use current package metadata, Cordis services, slots, and patches. Fabric begins as an interoperability layer assembled by Host integrations over a versioned DSH Adapter. It neither requires immediate upstream changes nor requires a Host to remove built-in or legacy extensions.

The words MUST, SHOULD, and MAY describe the strength of proposals. They do not create a stable compatibility promise until the RFC is accepted, schemas are published, and conformance tests exist.

The filename, topology, composition, and provenance refinements in this revision respond to counterexamples collected in [community Issue #23](https://github.com/omdsh-dev/community/issues/23). They are decisions of this draft, not a claim that the community discussion has already reached formal consensus.

## 2. Motivation

The community now has GUI, Web UI, TUI, launcher, modpack, and distribution projects. Growth exposes common problems:

- compatibility requirements cannot be inspected reliably before installation;
- extensions tied to loader details, internal functions, or source patches break when implementations change;
- different Hosts expose different paths for the same user need;
- multiple plugins can alter one behavior without declaration, ordering, or conflict rules;
- markets and launchers lack static compatibility metadata and fall back to hand-tested locked combinations.

This proposal concentrates upstream-specific change in the versioned DSH Adapter while Host integrations own product policy and UX. Governance and the plugin-facing contract are not versioned with one DSH release. When upstream behavior changes, an Adapter and Host must adapt, explicitly downgrade, or stop advertising a capability rather than pretending its old semantics still hold.

This is not absolute independence from upstream. If upstream no longer exposes the observation or operation required for a capability, that capability cannot honestly be implemented.

## 3. Goals

1. **Static declaration:** inspect identity, version, entrypoints, capability requirements, and declarative contributions without executing code.
2. **Compatibility negotiation:** reject missing required capabilities clearly and allow deterministic degradation for missing optional capabilities.
3. **One community contract:** one normative API and behavior model for each operation covered by the standard.
4. **Adapt existing ecosystems:** implement the contract on DSH, Cordis, or another native Host mechanism rather than creating a parallel loader.
5. **Verifiability:** publish schemas, fixtures, and headless conformance tests for manifests, Host Descriptors, negotiation, and lifecycle behavior.
6. **Lower user friction:** let markets and launchers distinguish compatible, incompatible, awaiting authorization, tested, and unknown combinations before installation.

## 4. Non-goals

- Requiring immediate adoption by DSH upstream.
- Standardizing the internal rendering technology of GUI, Web UI, or TUI Hosts.
- Building a package manager, market backend, ranking system, or account service in this RFC.
- Treating valid static metadata as a source-code security review.
- Promising that arbitrary rich UI runs unchanged on every Host.
- Standardizing a complete set of mutable `before-*` events in v0.1.
- Requiring Hosts to remove built-in, legacy, or non-standard extension paths; those paths simply do not participate in Fabric conformance claims.

## 5. Trust and execution modes

Capability handling has four separate stages:

1. **support:** the Host says it can provide a capability;
2. **request:** the plugin asks for it in its manifest;
3. **grant:** the user or policy authorizes it;
4. **enforcement:** isolation prevents the plugin from bypassing the grant.

The v0.1 reference adapter may use a **trusted in-process** mode. In this mode, capabilities support compatibility, consent, and auditing; they are not a security sandbox. The Host must say so prominently.

A future **isolated** mode needs a separate specification covering process or realm isolation, module controls, mediated IPC, resource limits, filesystem and network scopes, crash recovery, and platform differences. A Host without that evidence must not claim technical permission enforcement.

## 6. Version model

The following versions are distinct:

| Name | Meaning |
| --- | --- |
| `version` | The plugin's own SemVer version. |
| `manifestVersion` | The JSON document structure version. |
| `apiVersion` | The community Host API compatibility range requested by the plugin. |
| Capability/event version | The contract version for one capability or payload; v0.1 may temporarily tie it to the API version. |
| Host version | The product version of a GUI, Web UI, TUI, or launcher. |
| SDK version | The release version of types and tooling, not automatically the standard version. |

Breaking standard changes require a new incompatible API range. During `0.x`, experimental releases must state their own compatibility discipline instead of presenting `1.x` stability.

### 6.1 Terminology

- **Host product:** a GUI, Web UI, TUI, or launcher product that supports plugins.
- **Host-side runtime face:** the Node.js environment inside a Host product that executes a v0.1 plugin entrypoint.
- **Activation instance:** one bounded activation of one plugin entrypoint; lifecycle and resource ownership are scoped to it.
- **Adapter:** the implementation mapping Fabric capabilities to a concrete DSH/Cordis version.
- **Runtime:** the execution placement plus trust and resource boundary in which plugin code runs.
- **Presentation:** the user-facing capabilities attached to one interaction, such as a GUI window, browser, TUI, or headless caller.
- **Control:** the authority that selects plugins, applies policy, routes an invocation, and owns cancellation.
- **Transport:** the mechanism carrying contract messages between those parties, such as in-process calls, IPC, WebSocket, or SSH forwarding.

v0.1 specifies only a Host-side Node.js entrypoint and its activation instance. Browser Client, native UI, isolated Worker, and other executable faces plus their communication protocols are later RFCs. TUI is a Host product in this document, not a runtime-face name.

### 6.2 Runtime topology is not a Host type

Runtime, Presentation, Control, and Transport are independent axes. They MUST NOT be collapsed into fields such as `hostType: "gui"` or `isRemote: true`: a plugin can execute on a remote Node.js Runtime, be controlled by a server-side session, present through a local GUI, and cross SSH plus WebSocket transports in one invocation. Transport never proves where code executes, which surface is present, or who may authorize an action.

A Host Descriptor may advertise the presentation kinds it can potentially route, but that is not a grant and not evidence that a surface exists for a particular call. Any future presentation capability is **invocation-scoped**: the Control plane supplies a versioned, immutable invocation snapshot describing the currently attached surface and grants, and plugin code must not cache that offer as activation-global state. [RFC 0002](0002-runtime-presentation-invocation-transport.md) proposes identities, routing, authentication, cancellation, reconnect, replay, and failure boundaries without enlarging v0.1. Experimental v0.1 exposes no generic presentation channel.

## 7. Core model

```text
Manifest (plugin identity, requirements, exports, and contributions)
    ↓
Host Descriptor (Host support and execution mode)
    ↓
Negotiation + Authorization
    ↓
Lifecycle + Events
    ↓
Capability-scoped Host API
```

### 7.1 Manifest

v0.1 freezes the manifest as static JSON at **`dsh-plugin.json` in the package root** and rejects dynamically generated JavaScript manifests. The distinct name is deliberate: the [Agent Plugins Specification](https://agent-plugins.org/specification) Working Draft already reserves root `plugin.json` for its own manifest contract. A package may support both ecosystems with both files, but neither file overrides or silently extends the other.

The Phase 0 schema MUST require a top-level `$schema` canonical identifier. A Host selects a locally supported, bundled schema from that identifier and MUST NOT retrieve a schema or other validation policy over the network while loading a plugin. The canonical identifier becomes immutable when the schema is published. `$schema` selects manifest parsing and validation; if `manifestVersion` remains in the final shape, it MUST match the schema version selected by `$schema` rather than create another negotiation axis. The separate `apiVersion` remains the plugin's requested runtime Host API range. The placeholder below is therefore a discussion marker, not a published identifier or valid fixture.

```json
{
  "$schema": "<canonical v0.1 dsh-plugin.json schema identifier>",
  "manifestVersion": "0.1.0",
  "id": "com.example.message-memory",
  "name": "Message Memory",
  "version": "1.2.0",
  "apiVersion": ">=0.1.0 <0.2.0",
  "entrypoints": {
    "host": "dist/host.js"
  },
  "capabilities": {
    "required": {
      "messages.observe": ">=0.1.0 <0.2.0",
      "commands": ">=0.1.0 <0.2.0",
      "storage.local": ">=0.1.0 <0.2.0"
    },
    "optional": {
      "ui.panel.basic": ">=0.1.0 <0.2.0"
    }
  },
  "subscriptions": [
    { "event": "messages.observe", "version": ">=0.1.0 <0.2.0" }
  ],
  "contributes": {
    "commands": [
      { "id": "com.example.message-memory.show-last", "title": "Show Last Message" }
    ]
  }
}
```

The final schema must also define:

- plugin ID syntax, namespace ownership, and collision handling;
- entrypoints constrained to the package root, module format, and execution environment;
- whether Host, renderer, and worker entrypoints coexist and how they communicate;
- capability version ranges and sensitive scopes;
- renewed consent when an update adds capabilities;
- contribution ID namespaces and conflicts;
- the authority of fields duplicated in npm package metadata.

The schema and tooling MUST keep five declaration classes semantically separate, even if their final JSON nesting is refined with fixtures:

| Declaration | Meaning |
| --- | --- |
| `requires` | Versioned Host capabilities or service contracts needed by the plugin, including required and optional dependencies. |
| `permissions` | User- or policy-granted sensitive scopes; support alone does not grant them. |
| `provides` | Versioned service or Provider contracts exported for other plugins or the Host to consume. |
| `contributes` | Declarative product metadata discoverable before code executes. |
| `subscriptions` | Event interests that control delivery after eager activation, not activation triggers. |

These five names reserve distinct semantics for the standard roadmap; they do not make every class executable in v0.1. The v0.1 schema MUST reject `provides` and `requires.services` until the service-composition contract and a versioned schema revision are accepted. A Host must not preserve an unsupported field inertly and present it as functional. The initial schema accepts only the requirement, permission, subscription, and contribution forms whose concrete v0.1 contracts exist.

Sharing one manifest does not make these the same compatibility or security object. A consumer depends on a `provides` contract ID and version, never on the concrete package chosen to satisfy it. v0.1 reserves this declaration class but exposes no general plugin-provided service runtime; [RFC 0003](0003-service-providers-and-composition.md) proposes cardinality, multiple instances, user selection, replacement, and dependency cycles for a later runtime.

In the discussion example, `capabilities.required` / `optional` is the provisional v0.1 encoding of Host capability requirements, while `subscriptions` separately requests event delivery. The final schema may nest the former under `requires`; it must not merge either declaration with permissions, exports, or contributions.

Following the VS Code Contribution Point pattern, `contributes` describes metadata that a Host can discover before plugin code runs; it is not a capability, grant, runtime implementation, or activation trigger. After activation, plugin code may bind handlers or Providers only to IDs declared in the manifest. Tooling and conformance tests should report both declared-but-unbound and bound-but-undeclared entries.

The standard does not mandate a particular loader or source transformer. A Host locates entrypoints from the manifest and activates them through its native mechanism following the standard lifecycle. Fabric-managed plugins use this path; other Host extension paths are labeled non-standard.

A conforming Fabric entrypoint has no runtime dependency on DSH, Cordis, Desktop, or Adapter packages. Package inspection, dependency rules, and conformance fixtures enforce this supported boundary against accidental coupling; trusted in-process mode still cannot turn it into a malicious-code sandbox.

### 7.2 Host Descriptor

Every compatible Host publishes a machine-readable descriptor. This is also only a discussion shape:

```json
{
  "descriptorVersion": "0.1.0",
  "id": "org.example.dsh-webui",
  "version": "1.4.0",
  "apiVersions": ["0.1.0"],
  "execution": {
    "environment": "node",
    "trustMode": "trusted-in-process"
  },
  "capabilities": {
    "messages.observe": "0.1.0",
    "commands": "0.1.0",
    "storage.local": "0.1.0"
  },
  "platforms": ["darwin-arm64", "win32-x64", "linux-x64"]
}
```

Compatibility is primarily derived from API and capabilities, not ambiguous names such as `gui>=2.0`. Exceptional Host constraints use stable organization-namespaced IDs.

The descriptor reports the Runtime and trust mode it actually supplies. It MUST NOT use `hostType` or `isRemote` as a shortcut for Runtime, Presentation, Control, or Transport, and a statically advertised presentation kind does not become an activation-wide capability.

Markets distinguish at least:

- **declared compatible:** static negotiation passed;
- **awaiting authorization:** support exists but a sensitive grant is missing;
- **tested:** a named Host, system, plugin, and suite combination passed;
- **incompatible:** a required capability or API range cannot be met;
- **unknown:** evidence is insufficient.

Declared compatibility is neither test evidence nor a security review.

The default product experience should show but disable incompatible plugins and list missing capabilities. Hiding them makes a plugin appear to vanish when a user changes device or profile.

### 7.3 Capabilities

A capability is a versioned Host service contract. Candidate v0.1 namespaces are:

| Name | Purpose | v0.1 status |
| --- | --- | --- |
| `storage.local` | Host-managed plugin-private persistence. | v0.1 negotiated capability |
| `commands` | Bind handlers to commands declared in the manifest. | v0.1 negotiated capability |
| `messages.observe` | Observe immutable message events. | v0.1 negotiated capability |
| `sessions.read` | Read a versioned, redacted session view. | Later design |
| `ui.panel.basic` | A tiny, versioned declarative UI subset. | Later prototype |
| `sessions.actions`, `net.*`, `fs.*` | Session mutation, network, and file access. | Deferred |

Each capability defines methods, schemas, errors, cancellation, lifecycle, privacy, resource limits, and tests. Private extensions use organization namespaces such as `x-org.example.tui.keymap`.

The standard publishes a versioned, machine-readable Capability Registry rather than asking implementations to scrape this RFC. Every entry contains at least its canonical ID and version, status, owning RFC, input/output/error schema identifiers and immutable hashes, sensitivity and grant class, lifecycle scope, and deprecation or replacement metadata. A Host Descriptor advertises exact registry entries it implements; private entries remain explicitly namespaced and cannot masquerade as standard capabilities.

Every contribution and Provider contract also defines cardinality, selector, priority, merge / first-result / pipeline / user-choice behavior, equal-priority tie-breaking, error isolation, timeout, duplicate registration, and hot replacement. Load order cannot become an undocumented conflict-resolution rule.

The “one standard method” rule applies inside the Fabric contract. It does not claim to stop trusted in-process code from importing Node.js APIs directly.

Declarative contributions never imply runtime access or a grant. Manifest command metadata is authoritative; a command contribution also requests `commands`, and plugin code only binds its handler by ID. Required APIs are present after negotiation. Optional APIs remain optional until an explicit capability check narrows them.

The v0.1 `commands` contract is deliberately limited to **flat action leaves**: one globally namespaced command ID maps to one declared action and one activation-owned handler. A Host chooses whether that action appears in a palette, menu, button, or TUI without changing its identity. Nested command trees, subcommands, CLI-style option parsing, interactive prompts, streaming output, and background command sessions are outside v0.1.

Device codes, temporary URLs, QR codes, confirmations, and similar short-lived interaction MUST NOT be smuggled into persistent session messages. [RFC 0002](0002-runtime-presentation-invocation-transport.md) proposes expiring, sensitivity-labelled presentation items and delivery acknowledgements for a later protocol. Until then, a v0.1 command cannot require such a channel.

### 7.4 Lifecycle and events

Host product state and plugin activation are separate state machines. A Host normally moves through:

```text
starting → ready → stopping → stopped
```

While a Host is ready, each activation instance independently moves through:

```text
discover → validate → negotiate → authorize
→ activating → active → deactivating → disposed
```

Experimental v0.1 does not use demand activation. After discovery, negotiation, and authorization, a Host activates every selected plugin while assembling a runtime generation. Contributions describe discoverable features and subscriptions control event delivery; invoking a command, requesting a Provider, or matching a subscription never activates an inactive plugin. Future interceptors still need independent grants, ordering, and failure contracts.

A Host guarantees ordering for a normal activation and best-effort deactivation during normal shutdown, but cannot guarantee deactivation after a crash, power loss, or forced termination. Plugin cleanup is idempotent and recovery-aware. A plugin may activate and dispose repeatedly while the Host remains ready, including during HMR or profile recomposition.

Activation and deactivation are Host-invoked activation-instance hooks, not ordinary business events a plugin subscribes to itself. The same v0.1 Host-side entrypoint may activate repeatedly; the final lifecycle contract defines repeated activation, HMR, and provider replacement. Client or isolated-Worker scopes and cross-face communication belong to later RFCs.

v0.1 standardizes lifecycle plus one immutable `messages.observe` event. It uses a versioned envelope with at least:

- `envelopeVersion`, `eventType`, and `eventVersion`;
- a unique `eventId`, source `runtimeId`, and `occurredAt` time;
- `scopeType`, `scopeId`, and a monotonically increasing `scopeSequence` for ordering within that scope;
- optional `correlationId` and `causationId` for one operation chain;
- `privacyClass` and an explicit `redactions` summary;
- a canonical `payloadSchema` identifier plus the immutable `payload`.

The payload contract still needs to freeze message fields, sensitive-field rules, concurrency, backpressure, error isolation, cancellation signals, and shutdown behavior. Cross-scope global order is not implied by timestamps or delivery order.

The standard also publishes a machine-readable Event Registry. Each entry binds the canonical event ID and version to its envelope and payload schema identifiers plus immutable hashes, scope and ordering rules, privacy/redaction class, delivery/backpressure contract, error policy, status, owning RFC, and deprecation metadata. `subscriptions` and Host Descriptors refer to these registry entries; implementations do not invent equivalent event names from prose.

Mutable or cancellable `before-*` events are deferred. A later RFC must define plugin order, priorities, merge behavior, cancellation continuation, timeout, errors, rollback, reentrancy, per-session ordering, cross-session concurrency, and privacy.

### 7.5 Host API

A future SDK may provide an experience like this, but package names and signatures are not frozen:

```ts
export default definePlugin((ctx) => {
  ctx.commands.handle('com.example.message-memory.show-last', async () => {
    const lastMessageId = await ctx.storage.local.get('lastMessageId')
    ctx.log.info('Last observed message', { lastMessageId })
  })

  ctx.messages.onReceived(async (message) => {
    await ctx.storage.local.set('lastMessageId', message.id)
  })

  return {
    deactivate() {
      // release resources owned by this activation
    },
  }
})
```

The context exposes only negotiated and granted standard capabilities. A missing required capability prevents activation. A missing optional capability has no API and requires an explicit degradation path.

In trusted in-process mode, this remains a supported contract facade rather than a JavaScript security boundary.

### 7.6 Broker ownership and effect ledger

Every standard registration crosses the Host API Broker, which assigns it to the current activation instance. From v0.1 onward, the Broker MUST maintain a machine-readable effect ledger so diagnostics and cleanup can answer which plugin created, replaced, or failed to release a resource. The minimum record contains:

- `ledgerVersion`, `recordId`, a monotonic `sequence`, and `recordedAt`;
- owner `pluginId`, `pluginVersion` or `manifestDigest`, `activationId`, and `runtimeId`;
- `effectId`, `effectKind`, canonical contract ID/version, and `resourceId` when one exists;
- `operation` and resulting `state`, covering at least `create`, `bind`, `replace`, `release`, and `cleanup-failed`;
- optional `correlationId`, previous/new owner or related effect IDs for replacement, and a non-sensitive `outcome` or canonical `errorCode`;
- `sensitivityClass` and the applied redaction policy.

Command handlers, subscriptions, Providers, UI contributions, and other activation-owned registrations use the same ownership rule when those contracts exist. The Broker coordinates disposal with the native Host lifecycle and records the outcome. Ledger records MUST NOT include message bodies, secrets, command arguments, or arbitrary plugin payloads by default. The ledger improves provenance and diagnosis; trusted in-process code can still bypass it, so it is not proof of sandbox enforcement.

## 8. Host obligations

A compatible Host should:

1. read static manifests for Fabric-managed plugins without executing dynamic manifest code;
2. publish an honest Host Descriptor and stop advertising semantics it cannot preserve;
3. validate schemas, negotiate API/capabilities, and obtain required grants before executing plugin code;
4. explain missing required capabilities in user language and make optional degradation deterministic;
5. preserve normal lifecycle ordering and catch ordinary errors crossing standard callback/Promise boundaries; trusted in-process code cannot isolate `process.exit`, native crashes, or infinite loops;
6. publish its execution mode and never describe trusted in-process code as sandboxed;
7. resolve standard capabilities and events through the published machine-readable registries rather than product-local aliases;
8. assign every standard registration to a plugin and activation, maintain the minimum effect ledger, and attempt bounded cleanup on disposal;
9. run versioned conformance tests and publish the environment and result.

## 9. Relationship to DSH and Cordis

Fabric must not answer loader fragmentation by inventing another loader. A reference adapter maps the Fabric contract onto existing DSH/Cordis composition:

- the manifest provides static discovery and negotiation;
- the Host integration asks the versioned DSH Adapter to map granted capabilities to existing services, slots, routes, or events;
- native Cordis lifecycle retains ownership of real resource cleanup;
- a capability without an equivalent mapping is reported unsupported rather than approximated through private APIs;
- existing plugins may gain manifests through migration tools but do not become invalid merely because Fabric exists.

The portable v0.1 contract rejects source modification, monkey patching, and private-function hooks as plugin APIs. Existing `cordis.patch.yml` files are DSH's official declarative profile-composition layers, not source patches; the Fabric Adapter itself may enter a profile through a standard bundle patch. A separately labelled, version-pinned Adapter experiment may study a reviewed private compatibility bridge, but it cannot expose patch targets to ordinary plugins, advertise them as portable capabilities, or pass portable conformance on that basis.

The current `desktopProfiles` and `desktopPnpm` services in this repository are Desktop-specific Host contracts, not automatic cross-Host standards. Standardizing one of their use cases requires a separate capability RFC and evidence from multiple Hosts.

## 10. Markets, modpacks, and evidence

A market can index manifests and Host Descriptors to calculate compatibility before installation. Catalog inclusion is not review, endorsement, or security certification.

Modpacks remain first-class reproducible releases: they can lock standard, Host, plugin, platform, and test-suite versions. Locking does not replace SemVer contracts or compatibility windows.

A “tested” record binds standard/schema version, Host ID/version/platform, plugin ID/version, conformance suite version and commit, date, and outcome.

## 11. Minimal delivery path

Experimental v0.1 is complete only when the minimum Phase 0–2 contracts have specifications and tests. Phase numbers describe implementation order, not conflicting version scopes.

Its exact runtime surface is: baseline `host.info`, `log`, and lifecycle cancellation, plus negotiated `storage.local`, `commands`, and one immutable `messages.observe` event. Other names in this RFC are future candidates.

### Phase 0: standard foundations

- RFC 0000 for governance and status transitions;
- package-root `dsh-plugin.json` Manifest Schema with a required canonical `$schema` identifier;
- Host Descriptor Schema;
- machine-readable Capability and Event Registries with immutable schema hashes;
- valid and invalid fixtures;
- a pure capability negotiator;
- a headless conformance harness skeleton.

### Phase 1: trusted reference adapter

- one explicit Node.js Host execution environment;
- discover, validate, negotiate, activate, and deactivate;
- only low-risk, non-mutating initial capabilities; sensitive read access still requires grants and redaction;
- Broker-assigned plugin/activation ownership and the minimum effect ledger;

### Phase 2: events and a minimal contribution

- one immutable `messages.observe` event with the minimum versioned envelope;
- `storage.local`;
- `commands` as flat action leaves with same-ID runtime binding, without command trees or interactive presentation;
- activation-scoped Disposable / AsyncDisposable, bounded drain, and repeated activation;
- failure, duplicate-ID, undeclared/unbound contribution, timeout, cancellation, and shutdown fixtures.
- after the complete v0.1 surface exists, interoperability evidence from at least two different Host products or integrations; they may share the same versioned DSH Adapter.

### Separate later RFCs

- mutable `before-*` events;
- [Runtime / Presentation / Control / Transport identities, invocation routing, command trees, and ephemeral presentation](0002-runtime-presentation-invocation-transport.md);
- [Service Provider contracts, `provides` composition, cardinality, selection, and dependency cycles](0003-service-providers-and-composition.md);
- UI Contribution, Provider, Renderer, Rich View, conditions, and a minimal cross-Host UI IR;
- Project/Profile Trust and experimental-capability graduation;
- multi-scope storage and Secret capabilities;
- filesystem, network, and session-write permissions;
- isolated execution and mediated IPC;
- [install impact previews plus full provenance, validation, and diagnostic exchange beyond the minimum effect ledger](0004-provenance-validation-and-diagnostics.md);
- market compatibility labels and test-result interchange.

## 12. Governance requirements

Before this RFC becomes Accepted, RFC 0000 should define statuses, minimum public review, decision and appeal processes, capability/event naming registries, breaking changes, deprecation, errata, private security reporting, licensing, and the boundary between a community and official standard.

The reference implementation cannot define the standard by accident. Behavior belongs to the contract only when normative text, fixtures, and conformance tests describe it.

## 13. v0.1 acceptance and conformance evidence

Experimental v0.1 separates evidence into four classes:

1. **Schema validation:** public `dsh-plugin.json` and Host Descriptor Schemas, required recognized `$schema`, complete SemVer rules, registries, and valid/invalid fixtures.
2. **Host conformance:** required/optional negotiation, unknown versions, denied grants, activation order, best-effort shutdown, standard callback errors, truthful Runtime/trust descriptions, and plugin/activation effect ownership.
3. **Plugin validation:** manifest/entrypoint consistency, declared-capability use, matching contribution declarations/bindings without ID conflicts, optional degradation, releasable synchronous/asynchronous resources after repeated activation, and understandable errors.
4. **Interop evidence:** two independent Host products or integrations and three example plugins complete the same scenarios as the standard-graduation evidence for v0.1. The Hosts may share a DSH Adapter, but their integration and descriptor evidence remain independent.

Because Events are in both the RFC title and v0.1 scope, at least one immutable observation event has the minimum versioned envelope, a payload schema, privacy redaction, ordering within its scope, backpressure/timeout, error handling, shutdown semantics, and headless contract tests.

A Host may claim only that it passes the v0.1 Host conformance suite; a plugin may claim only that it passes v0.1 plugin validation. Neither claim means “safe plugin” or “officially certified.”

## 14. Open questions

1. Who owns and publishes canonical `$schema` identifiers and offline compatibility mappings?
2. How are publisher namespaces proven, transferred, and disputed?
3. Which Node.js version, module format, and entrypoint-loading boundary should v0.1 support?
4. Which message content fields and redaction rules belong inside the now-defined v0.1 `messages.observe` envelope?
5. Do capability versions use independent SemVer or follow `apiVersion` during v0?
6. What evidence proves that flat `commands` actions behave consistently across GUI, Web UI, and TUI Hosts?
7. Who publishes, stores, and revokes Host conformance results?
8. How should RFC review, merge rights, and dispute resolution be governed by the community?

## 15. Why now

Multiple Hosts, plugin authors, and distribution channels already exist. A static and testable interoperability contract is cheaper to establish now than after interfaces fragment further.

The reusable asset is not a loader. It is the declaration, negotiation, lifecycle, and verification method. Fabric should be a community-maintained adapter and experiment, not another unilateral parallel plugin system.

The next step is not automatic standardization after one week. It is to collect counterexamples publicly, finish governance plus schema fixtures, and validate the minimum contract with two Hosts and real plugins.
