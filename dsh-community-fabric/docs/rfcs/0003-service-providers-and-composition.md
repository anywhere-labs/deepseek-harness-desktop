# RFC 0003: Service Providers and Deterministic Composition

English | [中文](0003-service-providers-and-composition.zh.md)

| Field | Value |
| --- | --- |
| Status | Draft / request for comments |
| Target | Post-v0.1 service runtime; v0.1 reserves semantics only |
| Scope | Service dependencies, Providers, and deterministic plugin-set composition |
| Depends on | [RFC 0001](0001-plugin-manifest-capabilities-events.md) |
| Community input | [Issue #23 composition comment](https://github.com/omdsh-dev/community/issues/23#issuecomment-5307228009) |
| Reference implementation | DSH Community Fabric (not implemented) |

## 0. Summary

Fabric needs to compose a set of plugins before it executes any of them. A plugin may require Host capabilities or services, provide a service implementation, contribute discoverable product metadata, request permissions, and subscribe to events. Those are five different declarations and must never be collapsed into one generic `capabilities` bag.

This RFC proposes a statically computed **Composition Plan**. Given manifests, a Host Descriptor, contract registries, grants, policy, and saved user selections, the planner classifies the plugin set as `merge`, `soft-conflict`, `selection-needed`, or `hard-conflict`. Provider cardinality and arbitration belong to each versioned service or contribution contract. Plugin discovery order, package-manager order, and activation timing are never arbitration inputs.

The plan is then the only authority from which a future Broker may construct activation instances, bind consumers to Providers, replace Providers, and dispose dependent resources. This makes plugin composition explainable before launch and recoverable during HMR, profile recomposition, health changes, or shutdown.

## 1. Draft boundary

This is a design draft, not an API that plugin authors can use today. It extends the model in [RFC 0001](0001-plugin-manifest-capabilities-events.md), whose experimental v0.1 runtime remains limited to Host-provided capabilities, lifecycle, `storage.local`, `commands`, and one immutable observation event.

For v0.1, `requires`, `provides`, `contributes`, `permissions`, and `subscriptions` reserve distinct meanings in the standard design, not five executable fields. The RFC 0001 v0.1 schema rejects `provides` and `requires.services` until this contract and a versioned schema revision are accepted. v0.1 does **not** ship a general plugin-provided service registry, dynamic dependency graph, Provider health protocol, or hot-replacement runtime. A Host must not claim that those features are part of Fabric v0.1 conformance.

This RFC also does not:

- expose a generic service locator, raw Cordis/Koishi Context, DSH object, or dependency-injection container to plugins;
- make capability declarations a security sandbox in trusted in-process execution;
- introduce demand activation—selected and authorized v0.1 plugins still activate while a runtime generation is assembled;
- standardize every model, search, Git, UI, tool, or storage service in one generic protocol;
- allow runtime registration to repair a statically invalid plugin set;
- require zero-downtime Provider replacement or automatic fallback.

The words MUST, SHOULD, and MAY have the draft strength defined by RFC 0001. They become compatibility commitments only after schemas, a reference Broker, and conformance fixtures are accepted.

## 2. Terms and two kinds of dependency

### 2.1 Host capability

A **Host capability** is implemented and owned by the Host integration or its versioned DSH Adapter. The Host advertises it in the Host Descriptor. Plugins may require and, where applicable, request permission to use it, but they cannot replace or shadow it through `provides`.

Examples include activation-scoped logging, `storage.local`, mediated network access, or the registration API for a domain Provider. A capability may expose a Provider SPI, but the capability itself remains Host-owned.

### 2.2 Plugin-provided service

A **plugin-provided service** is a versioned domain contract implemented by one plugin activation and consumed by another through Broker-generated typed proxies. Examples might later include `git.client`, `models.provider`, or `search.provider`.

The global service contract defines request and result schemas, cardinality, allowed scopes, version and feature negotiation, selection, health, cancellation, timeout, errors, teardown, and conformance tests. A package name or plugin ID is not a service contract.

The requirement namespace must identify which plane is being resolved. `requires.capabilities.storage.local` asks the Host; `requires.services.git.client` asks the Composition Planner for a compatible Provider. Reusing one unqualified string in both planes is invalid.

### 2.3 Provider and Provider instance

A **Provider declaration** states that a plugin can implement one service contract. A **Provider instance** is the runtime binding owned by one activation instance in one allowed scope. The Provider's package version, implementation version, and service-contract version are separate values.

A Host may implement a domain service only when that service contract explicitly allows a Host Provider. Contracts whose provider eligibility is `host-only` do not accept plugin Providers at all.

### 2.4 Runtime generation and Composition Plan

A **runtime generation** is one selected plugin set plus its Host Descriptor, grants, policy, selections, and resolved versions. A **Composition Plan** is the normalized, machine-readable result computed for that generation before plugin code executes.

The plan contains dependency edges, candidates, selected Providers, negotiated versions/features, contribution ownership, suppressed alternatives, pending grants, diagnostics, and provenance for every decision. The same normalized inputs must produce the same plan on every conforming Host.

## 3. Five declaration classes

The manifest keeps these declarations structurally and semantically separate:

| Declaration | Question answered | Authority and effect |
| --- | --- | --- |
| `requires` | What must or may already exist? | Compatibility dependency on a named Host capability or service contract. Required absence blocks the dependent activation; optional absence activates a declared degradation path. |
| `provides` | Which service contract can this plugin implement? | Provider candidacy only. It does not grant permissions, select the Provider, or activate code. |
| `contributes` | What discoverable product object does this plugin offer? | Static metadata such as a command, panel request, renderer ID, or setting. The Host owns validation, placement, composition, and presentation. |
| `permissions` | Which sensitive operation or data scope does this plugin ask the user or policy to grant? | Authorization request only. It neither proves Host support nor satisfies a dependency. |
| `subscriptions` | Which versioned event streams should be delivered after activation? | Delivery interest only. It is not a capability, permission, dependency, contribution, or activation trigger. |

An item may need more than one declaration. A search implementation may `provide` a search service, `require` the Host's mediated network capability, request a network-origin `permission`, `contribute` settings metadata, and `subscribe` to credential-revocation events. None of those declarations implies another.

An illustrative future shape follows. It is not the frozen manifest schema:

```json
{
  "requires": {
    "capabilities": {
      "storage.local": { "version": ">=0.1.0 <0.2.0", "optional": false }
    },
    "services": {
      "git.client": {
        "version": ">=1.2.0 <2.0.0",
        "requiredFeatures": ["status"],
        "optionalFeatures": ["worktrees"],
        "optional": false,
        "as": "gitClient"
      }
    }
  },
  "provides": [
    {
      "service": "git.client",
      "providerId": "com.example.git-native/client",
      "contractVersion": "1.4.0",
      "features": ["status", "worktrees"],
      "scope": "profile"
    }
  ],
  "contributes": {
    "commands": [
      { "id": "com.example.git-native.refresh", "title": "Refresh Git Status" }
    ]
  },
  "permissions": {
    "required": [
      { "name": "fs.read", "scope": "workspace" }
    ]
  },
  "subscriptions": [
    { "event": "workspace.changed", "version": ">=1.0.0 <2.0.0" }
  ]
}
```

Tooling must reject a runtime binding that was not declared, report a declaration that never binds, and keep permission/grant status out of compatibility claims.

## 4. Contract identity, versions, and features

### 4.1 Globally governed contract IDs

Portable Host capabilities, service contracts, event types, and standard contribution kinds use globally governed IDs from Fabric registries, for example `storage.local` or `git.client`. Their meanings cannot be privately redefined. Organization-specific contracts use a proven namespace such as `x-org.example.git.client`.

### 4.2 Publisher-namespaced resource IDs

Provider IDs, contribution IDs, commands, renderers, and other plugin-owned resources use publisher-controlled, globally unique namespaces, normally a reverse-domain prefix. IDs are stable identities, not display labels. Updating a package must not silently change the owner of an existing ID.

Two installed declarations claiming the same global resource ID are a hard conflict unless the resource contract explicitly defines an update/replacement identity and the package transaction proves continuity. The later-loaded declaration never overwrites the earlier one.

### 4.3 Version negotiation

The planner keeps these values separate:

| Value | Meaning |
| --- | --- |
| Plugin version | Release version of the package containing the Provider or consumer. |
| Service-contract version | SemVer version of the request/result and lifecycle contract. |
| Required range | Contract versions the consumer can use. |
| Provider-supported range/version | Contract versions the implementation has passed against. |
| Feature set | Named optional or required additions inside a compatible contract line. |

A candidate is compatible only when consumer, Provider, Broker, and Host/Adapter support have a non-empty contract-version intersection. The registry defines the deterministic selection rule; by default it chooses the highest mutually supported stable version. Prereleases participate only when every relevant range explicitly permits them.

Feature negotiation occurs only after a contract version is chosen. Missing or unknown required features make that candidate incompatible. Missing or unknown optional features are recorded as unavailable and the generated API omits them. Features cannot be used to smuggle a breaking contract change into an unchanged version.

The plan records the selected version, supported features, excluded candidates, and human-readable reasons. No consumer may inspect a Provider package and guess support from its package version.

## 5. Cardinality and provider eligibility

Every service and contribution contract declares cardinality independently from who is eligible to provide it. Combining them into one mode would make it impossible to express, for example, a Host-only service with many scoped instances or a selected service whose candidates may come from either the Host or plugins.

### 5.1 Cardinality

| Cardinality | Meaning | Static result when multiple declarations exist |
| --- | --- | --- |
| `many` | Zero or more Providers/resources may coexist. The contract defines enumeration, merge, selector, pipeline, or per-invocation routing semantics. | `merge` when IDs and contract rules are compatible; otherwise the relevant conflict class. |
| `single` | At most one Provider/resource may exist in a scope. This does not imply that one is required. | More than one compatible claim is a `hard-conflict` unless the contract defines an explicit replacement transaction. |
| `selected-one` | Multiple candidates may be installed, but exactly one is selected for an affected scope when the service is required. | A valid saved/policy selection resolves the set; otherwise `selection-needed`. |

Cardinality is scoped. A contract must say whether its instance space is runtime, profile, workspace, session, invocation, or another registered scope. A Provider cannot broaden its declared scope, and a Host cannot silently treat a global selection as a workspace selection.

For `many`, the service contract must still define what “many” means. Returning all Providers, merging values, selecting by an explicit selector, calling a pipeline, and asking the user are different protocols. A generic “highest priority wins” rule is not sufficient.

### 5.2 Provider eligibility

| Eligibility | Meaning | Invalid claim |
| --- | --- | --- |
| `plugin-only` | Only declared plugin Providers may satisfy the service. | A Host implementation cannot silently shadow or satisfy it. |
| `host-only` | Only the Host/Adapter implementation advertised in the Host Descriptor may satisfy it. | Any plugin `provides` claim is a `hard-conflict`. |
| `host-or-plugin` | Host and plugin implementations are candidates under the same version, feature, scope, cardinality, selection, and provenance rules. | A Host candidate cannot receive implicit priority merely because it is built in. |

Provider eligibility does not select an implementation and does not grant permissions. For `host-or-plugin`, the contract still needs an explicit selection or merge rule; Host identity is provenance, not arbitration priority. Contribution contracts that do not represent a callable Provider instead declare an equivalent ownership policy for their resource kind.

## 6. Static composition outcomes

The planner evaluates the entire selected plugin set before activation and assigns a disposition to every service, contribution, and dependent activation:

| Outcome | Meaning | Required Host behavior |
| --- | --- | --- |
| `merge` | All declarations compose under the contract's deterministic many/merge rules. | Include every accepted owner and record normalized ordering or routing. |
| `soft-conflict` | Declarations overlap, but a published deterministic policy can suppress, reposition, route, or otherwise resolve them without inventing semantics. | Apply the named policy, preserve all provenance, and show suppressed/adjusted results in diagnostics. |
| `selection-needed` | Multiple valid candidates exist for a user- or policy-selected contract and no valid selection is available. | Do not guess. Block only the affected required dependents and request an explicit selection through UI or headless configuration. |
| `hard-conflict` | The set violates identity, ownership, version, feature, scope, cycle, or cardinality rules and no published resolution exists. | Reject the affected generation or plugin subset according to Host policy; never activate it partially and silently. |

Missing required dependencies and denied required grants are also blocking diagnostics, but remain distinct from a collision: `dependency-unsatisfied` and `authorization-required` should not be mislabeled as conflicts.

The Composition Plan must be serializable and explain at least:

- which manifest and Host Descriptor supplied each claim;
- which contract and registry version supplied each rule;
- which user selection or administrative policy was applied;
- why each candidate was accepted, suppressed, awaiting selection, or rejected;
- which activations become blocked or degraded as a result;
- which normalized order is used where a contract genuinely defines ordered merging.

The service dependency graph must be acyclic. Late-bound cycles require a separate contract and are outside this RFC; without one, a cycle is a hard conflict with the complete cycle path in diagnostics.

### 6.1 Load order is not policy

Filesystem enumeration, npm dependency order, manifest discovery order, object insertion order, network arrival, and activation completion order must not select a winner or change a plan.

A contract may define explicit priority, selectors, or a stable lexical order for merging. Equal priority still needs a declared tie rule. Lexical ordering is suitable for reproducible display or concatenation, but must not silently choose a semantically exclusive Provider unless the contract explicitly makes that behavior part of its public contract.

Conformance tests must permute the same inputs and obtain a byte-equivalent normalized plan.

## 7. User and policy selection

For `selected-one`, the Host owns selection state. The selection key includes the service contract, allowed scope, and stable Provider ID; a plugin cannot write the selection directly.

Selection UI or headless configuration must show each candidate's owning plugin, plugin and contract versions, negotiated features, requested grants, current health evidence, compatibility/test evidence, and exclusion reason. Presence in a market or a previous selection is not endorsement.

Selection precedence is explicit and auditable, for example:

1. an applicable administrative policy;
2. an applicable current user selection;
3. a contract-defined default only when the contract is allowed to have one;
4. otherwise `selection-needed`.

The Host must not invent a default from install or load order. If the selected Provider disappears or becomes incompatible, the Host may use another Provider only when an already-approved policy explicitly permits fallback. Otherwise it returns to `selection-needed` and keeps unaffected plugins running.

Selections should be portable only when their scope and Provider identity remain meaningful. Importing a profile must preserve an unresolved selection rather than silently map it to a similarly named Provider.

## 8. Runtime binding and activation ownership

A future Broker binds only Providers and dependencies already authorized by a Composition Plan. Runtime code cannot add a new contract, change cardinality, or make an incompatible candidate valid.

Every registration, typed proxy, listener, timer, stream, operation, and child scope belongs to one activation instance. The Broker records the owner and removes its registry entries even if plugin cleanup throws. A plugin cannot unregister, replace, or dispose another activation's resources.

Provider replacement and HMR always create a new activation identity, even when the plugin version and Provider ID are unchanged. An old activation identity is never recycled; it remains historical provenance while current bindings point to the new owner.

Activation is the ownership boundary. If one activation owns several inseparable Providers or contributions, replacing one requires the plan to transition all affected resources and dependents. A Provider that needs independent replacement must be placed in its own declared child activation scope rather than detached from its owner after the fact.

Consumers receive only the dependencies declared for them, through generated/narrow typed handles. Fabric does not expose `ctx.get(string)`, registry enumeration, or a raw Provider object. A handle becomes unusable after its generation or Provider is disposed and fails with a stable `service-unavailable` error.

The future authoring experience might resemble the following, but names and signatures are not frozen:

```ts
export default definePlugin((ctx) => {
  // Generated from requires.services[...].as; no arbitrary service lookup.
  const git = ctx.dependencies.gitClient

  // Binding is allowed only for the providerId declared in provides.
  ctx.providers.bind('com.example.git-native/client', createGitClient(ctx))

  ctx.commands.handle('com.example.git-native.refresh', async ({ signal }) => {
    return git.status({ signal })
  })
})
```

Disposal is bounded and idempotent. During normal recomposition, consumers stop before their required Provider, dependency edges dispose in reverse topological order, and activations restart in topological order. The Host aborts in-flight calls, allows a contract-defined drain window, awaits `Disposable` / `AsyncDisposable` cleanup within a deadline, then forcibly removes registry state and records cleanup failures.

Consumers do not inherit a Provider's permissions, and Providers do not inherit consumer permissions. Delegating a sensitive authority requires a separately specified, scoped, expiring delegation token and an audit record. `provides` by itself grants nothing.

## 9. Health, replacement, and dependent reactivation

Each service contract states whether health is advisory or required for binding and defines a small state model such as `starting`, `healthy`, `degraded`, `unhealthy`, `stopping`, and `disposed`. Health is operational evidence, not proof of safety, compatibility, or correctness.

A Provider may publish health only through the Broker contract. Arbitrary plugin events cannot change selection state. The Broker rate-limits transitions, records reason and timestamp, and prevents a stale activation from reporting after disposal.

When a required or selected Provider is removed, replaced, or becomes unbindable, the Broker performs a generation transition:

1. validate and compute the replacement Composition Plan without executing new plugin code;
2. cancel or drain calls according to the service contract;
3. deactivate affected dependents in reverse dependency order;
4. dispose the old Provider activation and all owner-scoped resources;
5. activate and health-check the selected replacement;
6. reactivate dependents in dependency order with new typed handles;
7. publish the new generation or report a failed transition with provenance.

Optional dependencies should be isolated in child activation scopes where practical, so losing one optional Provider can dispose and re-create only the feature that uses it. A required dependency loss blocks the dependent activation.

Rollback is allowed only when the old Provider and its state remain valid and the contract defines a safe rollback boundary. Otherwise the Host exposes a degraded or selection-needed state. It must not retain a stale object reference or silently call a different Provider.

Zero-downtime handoff is contract-specific and deferred. The baseline may pause calls during replacement.

## 10. Calls, cancellation, timeout, and errors

Every service method contract defines request/result schemas, side effects, concurrency, idempotency, cancellation points, deadline behavior, maximum payloads, privacy, and audit requirements.

- Every asynchronous call receives a cancellation signal and effective deadline from the Broker.
- Cancellation is cooperative; requesting it does not prove that a remote or native side effect stopped.
- A timeout ends the consumer's wait and marks the call outcome, but does not imply rollback.
- Retry is forbidden unless the method contract declares it safe and defines idempotency keys or equivalent semantics.
- A Provider failure is isolated at the Broker boundary where the execution mode permits it. Trusted in-process execution still cannot contain `process.exit`, an infinite loop, or a native crash.
- Automatic “try the next Provider” behavior is forbidden unless the service contract and active user/policy selection explicitly define it.

At minimum, normalized errors distinguish:

| Code | Meaning |
| --- | --- |
| `service-unavailable` | No currently bound usable Provider exists. |
| `incompatible-version` | No mutually supported service-contract version exists. |
| `required-feature-missing` | A candidate lacks a required negotiated feature. |
| `selection-required` | A `selected-one` contract lacks a valid selection. |
| `composition-conflict` | A static hard conflict blocks the operation or activation. |
| `provider-unhealthy` | Health policy prevents use of the selected Provider. |
| `cancelled` | The caller or generation transition requested cancellation. |
| `deadline-exceeded` | The effective deadline elapsed. |
| `provider-failed` | The Provider returned or threw a normalized failure. |
| `activation-disposed` | The calling or serving activation no longer owns a valid handle. |

Error payloads are serializable, size-bounded, privacy-redacted, and carry a correlation ID plus Provider/consumer provenance. Raw stack traces, credentials, and arbitrary thrown objects do not cross plugin boundaries. Each contract states whether an error fails one call, degrades a feature, blocks an activation, or triggers a generation transition.

## 11. Composition Plan and runtime diagnostics

The Host retains both the static plan and runtime transitions. A diagnostic view or machine-readable report should answer:

- who declared, provided, selected, bound, replaced, and disposed a resource;
- which version and feature negotiation occurred;
- which policy or user action selected a Provider;
- which dependents were deactivated or degraded and why;
- which resources failed to clean up;
- whether a result is declared compatibility, runtime health, conformance evidence, or an unverified claim.

Composition decisions are owned by the Composition Plan and Host/Broker policy. Accepted, suppressed, selected, and rejected candidates remain `decided` evidence in the Composition Plan or its decision log. Only an actually created binding or runtime transition—such as bind, replace, release, or cleanup failure—enters the Host-observed effect ledger as `observed` evidence. The ledger is never an arbitration input. Plugin logs, events, or returned payloads cannot create, rewrite, or attest either record class; at most they are clearly labeled plugin claims.

This supports the provenance and impact-analysis request in the [Issue #23 discussion](https://github.com/omdsh-dev/community/issues/23#issuecomment-5305656025) without treating a market listing as verification.

## 12. Conformance and test matrix

Before the service runtime in this RFC can graduate beyond Draft, a headless testkit must cover at least:

| Area | Required fixtures and properties |
| --- | --- |
| Declaration separation | `requires`, `provides`, `contributes`, `permissions`, and `subscriptions` cannot satisfy or imply one another; undeclared binding and unbound declarations are reported. |
| Identity | Global contract registry lookup, namespace ownership, duplicate Provider/contribution IDs, update continuity, and provider-eligibility rejection. |
| Static planning | Every cardinality, every provider-eligibility value, and all four composition outcomes; missing dependency and pending grant remain distinct; dependency cycles show the complete path. |
| Determinism | Every permutation of equivalent manifest/descriptor inputs produces a byte-equivalent normalized plan; filesystem and activation timing do not change it. |
| Version/features | Empty and non-empty SemVer intersections, prereleases, required/optional features, unknown features, and Broker/Adapter support. |
| Selection | GUI-equivalent and headless selection, scope precedence, missing/stale selection, explicit fallback policy, and profile import. |
| Lifecycle ownership | Repeated activation, reverse-order disposal, async cleanup deadline, thrown cleanup, stale handles, and no resource leakage. |
| Health/replacement | Healthy/degraded/unhealthy transitions, stale health events, Provider removal, failed replacement, optional child reactivation, required dependent reactivation, and rollback boundaries. |
| Calls | Success, normalized failure, cancellation, timeout, late result, retry prohibition, concurrency limits, and redaction. |
| Interoperability | The same planner fixtures pass in a fake Host and at least two independent Host integrations; runtime fixtures use at least two Providers for one service contract. |

The normalized plan format, error format, health events, and transition log require schemas. Tests record the standard version, contract-registry version, Host/Adapter version, plugin versions, platform, and testkit commit. Passing the matrix is not a security certification.

## 13. Delivery stages

This RFC deliberately separates semantic reservation from implementation:

### Stage A — v0.1 semantic reservation

- keep the five declaration classes distinct in design while rejecting unsupported `provides` and service requirements in the v0.1 schema;
- reserve Host capability versus plugin-service namespaces;
- require service and contribution contracts to state cardinality, provider/owner eligibility, and conflict behavior;
- continue to activate the selected v0.1 plugin set eagerly by generation;
- do not expose a general plugin service runtime.

### Stage B — static planner prototype

- publish service/contribution contract registries and schemas;
- define the normalized Composition Plan and diagnostics schemas;
- implement a pure, headless planner with permutation tests;
- add fixtures for IDs, versions, features, cardinalities, scopes, conflicts, selections, and cycles.

### Stage C — Broker runtime experiment

- implement activation-owned Provider bindings and typed consumer proxies;
- implement bounded calls, health, teardown, replacement, and dependent reactivation;
- keep the runtime behind an experimental API range;
- validate it with fake Providers before adapting real DSH services.

### Stage D — domain contracts and interoperability evidence

- standardize individual high-value services through separate RFCs;
- test at least two implementations of one service contract;
- publish cross-Host evidence and operational diagnostics;
- graduate only the contracts whose semantics and failure behavior are proven.

## 14. Developer experience requirements

The eventual workflow should be:

```text
declare dependency/provider/contribution/permission/subscription
  → validate manifest and namespaces
  → preview the static Composition Plan
  → implement against generated typed contracts
  → run fake-Host lifecycle and conflict fixtures
  → test Provider replacement and cleanup
  → package without importing DSH, Cordis, or Host internals
```

The SDK should generate narrow dependency properties and binding functions from the manifest and contract registry. Editors should complete versions and features, explain why a candidate is incompatible, and display the same Composition Plan as the Host. Authors should never need to coordinate load order, probe `ctx.get()`, mutate another plugin's registry entry, or import a concrete Provider plugin merely to consume its service.

## 15. Security and trust

Static planning improves predictability and consent; it does not make arbitrary code safe. In trusted in-process mode, a malicious plugin may bypass the supported API through Node.js or native modules. Strong enforcement still requires the isolated execution specification described by RFC 0001.

The Broker must nevertheless enforce its own supported boundary: owner-scoped handles, declared dependencies, schema validation, size/rate/deadline limits, redaction, grants, delegation, and audit. A Provider's health, popularity, user selection, or conformance result must not be presented as a security review or endorsement.

## 16. Open questions

1. Which organization governs global service-contract IDs and publisher namespace disputes?
2. Which scopes belong in the first planner schema: runtime, profile, workspace, session, and invocation?
3. Should a Provider advertise one exact contract version or a tested discrete version set rather than a broad range?
4. Which selected-one services may define a default, and what evidence is required before fallback can be enabled?
5. How should persistent Provider state migrate across implementation replacement?
6. Which health signals are generic enough for the Broker, and which must remain domain-specific?
7. Can any late-bound dependency cycle be made portable, or should cycles remain forbidden permanently?
8. What minimum service contract should become the first two-Provider interoperability fixture?

## 17. References and design input

- [Issue #23: proposal for a unified plugin API and events](https://github.com/omdsh-dev/community/issues/23), especially the [Composition Rules comment](https://github.com/omdsh-dev/community/issues/23#issuecomment-5307228009).
- [RFC 0001: Manifest, Capabilities, and Events](0001-plugin-manifest-capabilities-events.md).
- [Research: Mature Plugin Framework Patterns](../research/mature-plugin-frameworks.md), especially Koishi-style dependency replacement and activation ownership.
- [Research: The VS Code Extension Model](../research/vscode-extension-model.md), especially domain Providers, contribution cardinality, selection, timeout, and replacement rules.
- [Research: What DSH Plugin Developers Actually Need](../research/dsh-plugin-needs.md), especially versioned service negotiation, Provider arbitration, health, and owner-scoped disposal.

The community comment establishes the missing composition layer; the research notes supply implementation evidence. This RFC turns both into a testable design while keeping the experimental v0.1 runtime deliberately small.
