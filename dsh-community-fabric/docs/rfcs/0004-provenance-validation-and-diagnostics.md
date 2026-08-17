# RFC 0004: Provenance, Validation, Diagnostics, and the Effect Ledger

English | [中文](0004-provenance-validation-and-diagnostics.zh.md)

| Field | Value |
| --- | --- |
| Status | Draft / request for comments |
| Target | Cross-cutting contract extending the minimum v0.1 ownership ledger |
| Scope | Installation impact, runtime ownership, validation evidence, cleanup diagnostics |
| Depends on | [RFC 0001](0001-plugin-manifest-capabilities-events.md) |
| Community input | [omdsh-dev/community issue #23](https://github.com/omdsh-dev/community/issues/23) |

## 0. Summary

Fabric must be able to answer four questions without guessing:

1. What does this plugin claim it will add or change?
2. What did the Host actually allow and activate?
3. Which plugin owns the command, service, UI, process, route, or other effect now visible?
4. After disable, replacement, or uninstall, what was cleaned up and what remains?

This RFC proposes three machine-readable products: an installation-impact report, a validation report, and a Host-observed runtime effect ledger. They make compatibility and failures explainable; they do not turn untrusted local code into safe code.

## 1. Motivation

Manifest validation alone proves only that JSON has an expected shape. A catalog listing proves only that a source supplied metadata. Neither explains package scripts, native dependencies, grants, shared-service conflicts, runtime registrations, or cleanup.

The community requested separate installation preview and runtime tracing in [this issue comment](https://github.com/omdsh-dev/community/issues/23#issuecomment-5305656025). The verification-tool discussion also requested a common machine-readable report instead of Host-specific prose in [this comment](https://github.com/omdsh-dev/community/issues/23#issuecomment-5306132230).

RFC 0001 already requires activation-scoped ownership and a minimum append-only transition ledger in v0.1. This RFC extends that foundation with installation, validation, materialized diagnostics, retention, and recovery semantics. Reconstructing ownership later from ordinary logs would be incomplete and unreliable.

## 2. Goals

- Distinguish plugin/provider claims, package-manager observations, Host decisions, and runtime observations.
- Bind every report to an immutable plugin artifact identity.
- Preview meaningful installation effects before executable package code runs.
- Record every Fabric-managed runtime effect with plugin and activation ownership.
- Produce stable validation outcomes and reason codes for Hosts, CI, launchers, and markets.
- Explain conflicts, replacements, failed activation, incomplete cleanup, and residual state.
- Preserve enough evidence to reproduce a tested combination without leaking user content or secrets.

## 3. Non-goals

- Defining a universal malware scanner or claiming that a passing report means “safe”.
- Replacing code signing, sandboxing, operating-system policy, or human review.
- Standardizing every package manager or lockfile in this RFC.
- Treating catalog popularity, stars, publisher claims, or a cooperating source as validation.
- Granting permission to patch private code merely because a legacy effect was declared.
- Requiring raw message content, credentials, local paths, or environment variables in reports.

## 4. Evidence classes

Every field in a report has an evidence class. A UI must not silently promote one class into another.

| Class | Meaning | Example |
| --- | --- | --- |
| `declared` | Supplied by the plugin manifest or publisher. | Requested capability, claimed repository. |
| `resolved` | Derived by a package manager or resolver from immutable inputs. | Exact package version, dependency graph, artifact digest. |
| `decided` | Chosen by Host policy or the user. | Granted scope, selected provider, denied build script. |
| `observed` | Recorded by the Broker or Adapter while running. | Registered command, opened process, cleanup result. |
| `tested` | Produced by a named suite in a defined environment. | Host conformance case passed on win32-x64. |
| `attested` | Signed by an identified verifier. | Future signed validation statement. |

`attested` says who signed a statement, not that the statement is universally trustworthy. Signature and trust policy remain separate.

## 5. Immutable subject identity

Reports never bind only to a mutable package name, branch, URL, or “latest” label. Their subject includes:

- Fabric plugin ID and plugin version;
- package ecosystem and exact package version when applicable;
- canonical source identity and immutable repository commit when applicable;
- cryptographic digest of the inspected artifact;
- manifest Schema identifier and Fabric API range;
- optional build-output digest when installation creates a different executable artifact.

If an artifact digest changes, an earlier report does not apply. A Host may display related historical evidence, but it must mark it stale.

## 6. Installation-impact report

The installation-impact report is generated before installation confirmation from manifest data, package metadata, a resolved dependency plan, and Host policy. It contains no executable command supplied by a catalog.

At minimum it records:

- exact subject identity and source attribution;
- direct and transitive package dependencies with native-addon markers;
- lifecycle/build scripts that would be eligible to run;
- requested Fabric capabilities, permissions, and scopes;
- declared contributions, provided services, and subscriptions;
- profile or composition records that would be added, changed, or removed;
- expected files, storage namespaces, network origins, processes, and secrets by stable scope rather than raw local paths;
- conflicts, required user selections, unsupported capabilities, and restart requirements;
- any detected legacy patch/mixin/override target as an explicit non-portable effect.

Static inspection can be incomplete. Every field carries `complete`, `partial`, `unknown`, or `not-applicable`; absence of evidence is never rendered as “no effect”.

The final confirmation presents a bounded product summary and links to the detailed report. Installation may proceed only with an immutable target and a fresh report for the selected profile and Host policy.

## 7. Validation report

A validation report is an exchange format, not a single boolean. A draft shape is:

```json
{
  "schemaVersion": "0.1.0",
  "reportId": "urn:uuid:...",
  "subject": {
    "pluginId": "com.example.plugin",
    "version": "1.2.0",
    "digest": "sha256:..."
  },
  "standard": {
    "apiVersion": "0.1.0",
    "manifestSchema": "https://example.invalid/fabric/manifest/0.1.0"
  },
  "validator": {
    "id": "org.example.fabric-verify",
    "version": "0.3.0"
  },
  "environment": {
    "hostDescriptorDigest": "sha256:...",
    "platform": "linux-x64",
    "trustMode": "trusted-in-process"
  },
  "suite": {
    "id": "fabric-plugin-validation",
    "version": "0.1.0",
    "commit": "..."
  },
  "startedAt": "2026-08-17T00:00:00Z",
  "outcome": "pass",
  "checks": []
}
```

Each check has a stable ID, version, outcome (`pass`, `fail`, `warning`, `skipped`, `unknown`), evidence class, reason code, and redacted diagnostic. An aggregate `pass` is invalid when a required check failed or was silently omitted.

The first report families should be separate:

- Manifest and package validation;
- Host conformance;
- plugin contract validation;
- plugin × Host interoperability evidence;
- installation-impact inspection;
- runtime cleanup diagnostics.

Markets and launchers may consume these reports, but must show the verifier, artifact digest, environment, time, and stale/revoked status. “Listed”, “declared compatible”, “tested”, “attested”, and “sandbox-enforced” remain distinct labels.

## 8. Runtime effect ledger

The canonical ledger is an append-only sequence of immutable transition records. Its v0.1 minimum is the same model defined by RFC 0001:

- `ledgerVersion`, `recordId`, monotonic `sequence`, and `recordedAt`;
- owner `pluginId`, `pluginVersion` or `manifestDigest`, `activationId`, and `runtimeId`;
- `effectId`, `effectKind`, canonical contract ID/version, and stable `resourceId` when one exists;
- `operation` and resulting `state`, including at least `create`, `bind`, `replace`, `release`, and `cleanup-failed`;
- optional `correlationId`, previous/new owner or related-effect IDs, and a non-sensitive `outcome` or canonical `errorCode`;
- `sensitivityClass` and the applied redaction policy.

As an RFC 0004 extension, a Host may add versioned observer metadata identifying the Runtime or Adapter component that produced the observation. It is not part of the v0.1 minimum, must remain Host-generated, and must not expose Transport details to plugin code.

A Host may derive a materialized current view containing creation time, last-transition time, current owner, and current state. That view is a cache over transition records, not a second source of truth; it cannot erase failed cleanup, historical owners, or sequence gaps. Composition candidates that were suppressed or rejected before runtime stay in the Composition Plan decision log and never become observed effects.

Initial effect kinds include command handlers, service providers, contributions, subscriptions, routes/RPC handlers, timers, background jobs, child processes, storage namespaces, temporary files, and experimental legacy effects.

The ledger is Host-observed evidence. Plugins cannot write or rewrite ownership records. Adapters may submit observations only through the Broker SPI, which attaches the active owner and validates the resource kind.

## 9. Activation, replacement, and cleanup

An activation record links negotiation, grants, provider selections, effects, diagnostics, and final disposition.

On normal deactivation the Broker:

1. stops new invocations;
2. aborts and drains owned work within a documented bound;
3. releases effects in contract-defined order;
4. records each success, timeout, and residual effect;
5. marks the activation disposed only after the ledger reaches a terminal state.

A process crash can prevent final records. On the next start, a recovery scanner compares persistent resource markers with the last durable ledger and reports `orphaned` or `unknown`; it must not fabricate successful cleanup.

Provider replacement and HMR create a new activation identity. Historical ownership remains queryable, while the current resource points to the new owner according to its composition contract.

## 10. Diagnostics graph

User-facing diagnostics should answer “what failed and what can I do?” without exposing internals. Developer diagnostics may follow stable IDs across:

```text
artifact → manifest → negotiation/grant → activation
         → provider/contribution → invocation → effect → error/cleanup
```

The graph records causal IDs, not arbitrary object references or stack-trace objects. Raw upstream causes remain in Host-owned logs and are correlated by ID.

Suggested stable outcomes include:

- incompatible API or missing capability;
- permission denied;
- unresolved or conflicting provider;
- duplicate contribution ID;
- activation failed or timed out;
- invocation failed or cancelled;
- cleanup incomplete;
- stale validation evidence;
- legacy effect detected;
- report subject mismatch.

## 11. Legacy effects and migration

Migration tooling may emit a read-only `legacyEffects` inspection section describing known source patches, mixin targets, private-service access, or unmanaged global side effects.

This is diagnostic metadata only:

- it does not grant permission;
- it does not make the effect portable;
- it does not promote a private seam into a Fabric capability;
- it does not allow an ordinary plugin to provide executable patch instructions in its manifest.

An experimental, version-pinned DSH Adapter may use a reviewed compatibility bridge. Such effects are labeled experimental and excluded from portable conformance until replaced by a public, testable capability.

## 12. Privacy and retention

- Never store message bodies, prompts, model output, secret values, authorization codes, raw environment variables, or unredacted local paths in standard reports.
- Use opaque scope/resource IDs and explicit sensitivity labels.
- Keep ephemeral presentation data out of the durable ledger unless a redacted fact such as “shown” is required for audit.
- Give users a way to inspect and delete local diagnostics subject to required security/audit policy.
- Telemetry export is separate, opt-in policy; a local ledger does not authorize upload.
- Bound report size, history length, and retention. Summarization must preserve failed cleanup and unresolved conflicts.

## 13. Conformance requirements

A conforming prototype must test at least:

- artifact digest mismatch invalidates prior evidence;
- unknown checks never become pass;
- validation reason codes remain stable and localizable text stays separate;
- every Fabric-managed registration receives the active plugin and activation owner;
- a plugin cannot forge another owner;
- replacement records both owners and follows composition policy;
- synchronous and asynchronous resources release on deactivation;
- timeout and crash paths report incomplete or unknown cleanup;
- sensitive values are absent from serialized reports;
- catalog listing does not produce a validation label by itself;
- legacy-effect declaration never authorizes execution;
- reports from a different Host descriptor, platform, suite, or artifact are visibly non-matching.

Tests must run headlessly. At least one real Adapter integration test should compare ledger observations with actual DSH registrations and teardown.

## 14. Relationship to other work

- [RFC 0001](0001-plugin-manifest-capabilities-events.md) owns manifest, negotiation, lifecycle, and basic activation ownership.
- [RFC 0003](0003-service-providers-and-composition.md) owns service-provider conflict and replacement policy; this RFC records only the resulting runtime transitions as observed effects while decisions remain in the Composition Plan.
- [RFC 0002](0002-runtime-presentation-invocation-transport.md) owns invocation and Runtime/Presentation identity; this RFC records opaque identities and redacted outcomes.
- [DSH plugin-needs research](../research/dsh-plugin-needs.md) supplies real examples of private routes, UI registration, processes, package operations, and monkey patches that require ownership.
- [DSH Community Market](../../../dsh-community-market/README.md) may display reports but cannot create or upgrade their trust class.

## 15. Open questions

1. Beyond the RFC 0001 minimum, which transition records and materialized views must be durable, and which may remain in memory?
2. Who owns namespaces for validation check IDs and reason codes?
3. Which report families require signatures, transparency logs, or revocation?
4. How are package scripts and native modules represented consistently across package managers?
5. What minimum recovery marker allows orphan detection without storing user paths?
6. Which diagnostics are visible to ordinary users, plugin authors, Host maintainers, and security reviewers?
