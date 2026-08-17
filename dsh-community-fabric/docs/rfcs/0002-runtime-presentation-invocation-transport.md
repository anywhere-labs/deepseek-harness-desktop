# RFC 0002: Runtime, Presentation, Control, Transport, and Invocation

English | [中文](0002-runtime-presentation-invocation-transport.zh.md)

| Field | Value |
| --- | --- |
| Status | Draft / request for comments |
| Target | Post-v0.1 protocol exploration |
| Scope | Interaction between plugin Runtimes and user-facing Presentations |
| Depends on | [RFC 0001](0001-plugin-manifest-capabilities-events.md) |
| Reference implementation | DSH Community Fabric (not implemented) |
| Discussion | [Community Issue #23](https://github.com/omdsh-dev/community/issues/23) and pull requests editing this document |

## 0. Summary

Separate five concepts that a local-only design can easily conflate:

- a **Runtime** executes plugins;
- a **Presentation** interacts with a user;
- **Control** authenticates attachments, applies policy, and coordinates invocations;
- a **Transport** carries protocol messages without changing plugin semantics;
- an **Invocation** is one bounded request from an authorized Presentation to a Runtime.

Presentation capabilities are immutable input to each invocation. They are never activation-time globals. A plugin must not branch on `isRemote`, `hostType`, the transport name, or a remembered “current client.” The same Runtime may serve several Presentations concurrently, and one Presentation may attach to or switch between several Runtimes without changing the plugin contract.

## 1. Status and relationship to RFC 0001

This document is a discussion draft prompted by the [Remote SSH counterexample](https://github.com/omdsh-dev/community/issues/23#issuecomment-5306386927) and the subsequent [Runtime / Presentation / Control decomposition](https://github.com/omdsh-dev/community/issues/23#issuecomment-5306670321). It is not an API developers can use today.

[RFC 0001](0001-plugin-manifest-capabilities-events.md) deliberately limits experimental v0.1 to one Host-side Node.js runtime face. This RFC does not enlarge that v0.1 runtime surface. Descriptor schemas, protocol schemas, a reviewed Control implementation, transport adapters, and conformance fixtures must exist before any implementation can claim this RFC.

The RFC 0001 activation decision also remains unchanged: experimental v0.1 does **not** use demand activation. A selected plugin activates while its Runtime generation is assembled. Attaching a Presentation, discovering a command, or invoking a command does not activate an inactive plugin.

The words MUST, SHOULD, and MAY express the intended strength of the draft. They do not create a compatibility promise until this RFC is accepted and backed by schemas and tests.

## 2. The Remote SSH counterexample

The community report describes one remote profile that executes a plugin while a local TUI or Web UI presents its commands. Three failures expose the missing boundary:

1. A root command reaches the remote command catalog, but subcommands held in a TUI-only service do not. Portable command syntax was incorrectly owned by one Presentation implementation.
2. A login handler chooses browser mode during plugin registration. On a remote Runtime, it may try to open a browser on the wrong machine. Another Presentation attached to the same Runtime may have entirely different capabilities.
3. A device authorization URI and user code are returned through a persistent command/session result even though they are short-lived and sensitive.

Adding `isRemote: true` does not solve these failures. Locality is not a Presentation capability, and a Runtime can be remote to one client while serving many clients simultaneously. Adding `hostType: "tui"` also fails because execution and presentation are independent axes.

The protocol therefore needs a portable command tree, per-invocation Presentation capabilities, and a non-persistent Presentation channel.

## 3. Goals

1. Give Runtime, Presentation, Control, Transport, and Invocation one precise meaning each.
2. Allow many Presentations to attach to one Runtime without shared “current client” state.
3. Allow one Presentation to attach to or switch between many Runtimes with separate identity and grants.
4. Make command discovery, typed invocation, cancellation, and transient user interaction portable across GUI, Web UI, TUI, CLI, and headless test clients.
5. Keep plugin behavior independent of SSH, WebSocket, local IPC, container exec, or any future transport.
6. Make authorization, sensitive-data handling, attachment lifetime, and failure behavior observable and testable without a graphical environment.

## 4. Non-goals

- This RFC does not enter the RFC 0001 experimental v0.1 runtime surface.
- It does not introduce demand activation or change generation-scoped eager activation.
- It is not a cluster scheduler, workflow engine, profile manager, deployment system, service discovery system, or fleet control plane.
- It does not standardize GUI, Web UI, TUI, or CLI rendering technology, layout, navigation, styling, or component libraries.
- It does not make arbitrary rich UI portable. Rich views and renderer extensions require separate capability RFCs.
- It does not require SSH or select a preferred transport.
- It does not make a trusted in-process plugin a security sandbox.
- It does not define a persistent session-history format or permit transient secrets to enter one.

## 5. Terminology and invariants

### 5.1 Runtime

A **Runtime** is the execution location and trust/resource boundary in which one Runtime generation activates selected plugin entrypoints. It owns activation instances, Runtime capabilities, command handlers, storage bindings, and business-event subscriptions.

A Runtime is not “the UI” and is not defined by whether another machine considers it local or remote. Its descriptor may expose relevant execution facts such as operating system, architecture, API versions, and trust mode. It must not expose a plugin-facing `isRemote` shortcut.

### 5.2 Presentation

A **Presentation** is the user-interaction surface available to an invocation. A Presentation endpoint may remain attached and can discover commands, collect input, render output, or offer transient interaction affordances, but its capabilities have plugin-facing meaning only through an invocation snapshot. A desktop window, browser client, TUI, CLI, and deterministic headless test client can each be a Presentation.

A Presentation advertises versioned capabilities, not a branch-driving product label. Plugins choose only among negotiated capabilities. Product identity may be retained for diagnostics and conformance evidence, but `hostType`, `clientType`, or a product name is not a substitute for capability checks.

### 5.3 Control

**Control** is the policy and coordination plane between Presentation and Runtime. It selects the applicable plugin/runtime generation, authenticates peers, authorizes Runtime access, negotiates descriptors, creates and revokes attachments, binds Presentation claims to invocations, routes requests and cancellation, enforces quotas, and records provenance-safe diagnostics.

Control may be embedded in a local product or split across processes. Its logical obligations do not imply a centralized internet service.

### 5.4 Transport

A **Transport** moves versioned protocol envelopes between Control endpoints. Examples include in-memory calls, local IPC, SSH channels, WebSocket, HTTP streams, container exec, or Kubernetes exec.

Transport affects connectivity, latency, framing, and failure signals. It does not change command IDs, payload schemas, Presentation capability semantics, authorization rules, or plugin APIs. Transport details are unavailable to ordinary plugin code.

### 5.5 Invocation

An **Invocation** is one authorized, cancellable, bounded execution of a declared command or Provider operation against one Runtime generation. It carries an immutable snapshot of the Presentation capabilities available for that request.

### 5.6 Normative invariants

1. Plugin activation is scoped to a Runtime generation; Presentation attachment is not activation.
2. Presentation state is scoped to an attachment and snapshotted into every invocation.
3. No Runtime or plugin may store a global `currentPresentation`, `hostType`, or `isRemote` for later requests.
4. A capability advertised by one attachment must never leak into another attachment or invocation.
5. A Transport may forward a standard envelope but must not reinterpret its business meaning.
6. Control is authoritative for attachment identity, grants, deadlines, and revocation; an untrusted client claim alone is insufficient.
7. An invocation targets one immutable `runtimeId` plus `generationId`; reconnecting or switching cannot silently retarget it.
8. Attach, detach, command discovery, and invocation do not demand-activate plugins.

## 6. Topology and ownership

The relationship is many-to-many:

```text
Presentation A ─┐                 ┌─ Runtime 1 / generation X
                ├─ Control plane ┤
Presentation B ─┘                 └─ Runtime 2 / generation Y
```

One remote Runtime may simultaneously serve a local TUI and a browser Presentation. Their capability snapshots and grants remain independent. One TUI may attach to Runtime 1, attach to Runtime 2, or switch its active view without transferring invocation IDs, grants, ephemeral messages, or cancellation handles between them.

A product may implement more than one role. A desktop application can contain Runtime, Control, Presentation, and local IPC in one process tree. Conformance still tests the logical boundaries; process co-location is not permission to replace explicit context with globals.

## 7. Descriptors and invocation context

All examples in this section are discussion shapes, not published schemas. Final documents must reject unknown security-sensitive fields, define size limits, and include valid and invalid fixtures.

### 7.1 RuntimeDescriptor

Control obtains a `RuntimeDescriptor` for one live Runtime generation:

```json
{
  "descriptorVersion": "0.1.0",
  "runtimeId": "runtime:01K3EXAMPLE",
  "generationId": "generation:01K3EXAMPLE",
  "product": {
    "id": "org.example.dsh-runtime",
    "version": "2.0.0"
  },
  "execution": {
    "environment": "node",
    "trustMode": "trusted-in-process"
  },
  "platform": {
    "os": "linux",
    "arch": "x64"
  },
  "apiVersions": ["0.1.0"],
  "capabilities": {
    "commands": "0.1.0",
    "storage.local": "0.1.0"
  }
}
```

`runtimeId` is unique in the relevant Control authority; it is not a hostname. `generationId` changes whenever profile composition or active plugin bindings are replaced. Both IDs are opaque and must not be parsed to infer topology or product behavior. A stale generation target is rejected rather than redirected.

The RFC 0001 Host Descriptor and this Runtime Descriptor have different lifetimes. A Host Descriptor is pre-generation product/integration evidence used for installation and composition planning; a Runtime Descriptor describes one live, already assembled generation. The live descriptor must be derivable from the Host/Adapter implementation and actual generation, and it cannot advertise a capability that the applicable Host Descriptor and negotiated contracts do not support.

The Runtime Descriptor says what the Runtime can execute. It says nothing about the current user's browser, clipboard, QR renderer, or prompt surface.

### 7.2 PresentationDescriptor

Control validates a `PresentationDescriptor` while attaching a Presentation:

```json
{
  "descriptorVersion": "0.1.0",
  "product": {
    "id": "org.example.dsh-tui",
    "version": "1.4.0"
  },
  "locale": "en-US",
  "capabilities": {
    "presentation.text": "0.1.0",
    "presentation.link.show": "0.1.0",
    "presentation.clipboard.copy": "0.1.0"
  }
}
```

The client-submitted descriptor has no trusted `presentationId`. After authentication, Control assigns one within the attachment authority and adds it only to the authenticated descriptor snapshot used by an invocation. It must not be supplied as or derived from a stable hardware fingerprint. The assigned ID is opaque and must not drive plugin behavior. Capability values are versioned contracts. Absence means unavailable. A product name, locale, screen size, or TUI/GUI label never implies a capability.

Candidate capability contracts include:

| Capability | Meaning |
| --- | --- |
| `presentation.text` | Render bounded plain text with defined control-character handling. |
| `presentation.prompt.select` | Collect one selection from a bounded, typed choice set. |
| `presentation.link.show` | Display an audited HTTPS URI without opening it. |
| `presentation.link.open` | Offer to open an audited URI after an explicit user gesture. |
| `presentation.clipboard.copy` | Offer an explicit user action that copies an identified field. |
| `presentation.qr.render` | Render a QR representation of an audited field. |

Each contract still needs accessibility, timeout, size, scheme, gesture, error, and privacy rules. Claiming a capability does not bypass user consent or platform policy.

### 7.3 InvocationContext

Control creates a fresh context for every invocation:

```json
{
  "protocolVersion": "0.1.0",
  "invocationId": "invocation:01K3EXAMPLE",
  "attachmentId": "attachment:01K3EXAMPLE",
  "runtime": {
    "runtimeId": "runtime:01K3EXAMPLE",
    "generationId": "generation:01K3EXAMPLE"
  },
  "presentation": {
    "descriptorVersion": "0.1.0",
    "presentationId": "presentation:01K3EXAMPLE",
    "capabilities": {
      "presentation.text": "0.1.0",
      "presentation.link.show": "0.1.0"
    }
  },
  "authority": {
    "subject": "subject:opaque-user-reference",
    "grantId": "grant:01K3EXAMPLE"
  },
  "deadline": "2026-08-17T12:00:00Z",
  "trace": {
    "correlationId": "correlation:01K3EXAMPLE"
  },
  "command": {
    "id": "com.example.codex.login.device",
    "input": {}
  }
}
```

The serialized context contains only the minimum data required for authorization, routing, capability negotiation, cancellation, and diagnostics. The SDK may expose a narrower typed facade plus an `AbortSignal` instead of the raw envelope.

The Presentation capability map is copied into and authenticated with the invocation. It is not fetched from mutable plugin state. Even a Presentation with no interactive capability sends an explicit empty map.

## 8. Attach and detach lifecycle

Each attachment has an independent state machine:

```text
connecting → authenticating → negotiating → attached
    → draining → detached
```

An attachment proceeds as follows:

1. Transport establishes a channel and reports its authenticated peer evidence to Control.
2. Control authenticates the principal and authorizes access to one specific Runtime generation.
3. Runtime and Presentation descriptors are validated and version-negotiated.
4. Control assigns a fresh `attachmentId`, binds descriptor evidence and grants to it, and exposes command discovery.
5. Every invocation revalidates that the attachment, generation, command, grant, deadline, and capability snapshot are still acceptable.
6. Detach prevents new invocations, applies the declared policy to in-flight work, revokes attachment-scoped handles, and disposes ephemeral messages.

Attach does not activate plugins, create a global current Presentation, or transfer a grant from another Runtime. Reconnect creates a new attachment unless a future resume protocol proves continuity and replay safety.

Runtime shutdown detaches all Presentations for that generation. Presentation shutdown detaches only its own attachments; a shared Runtime continues serving other authorized Presentations.

## 9. Invocation protocol and cancellation

An invocation moves through a single monotonic state machine:

```text
accepted → running → succeeded
                   ├→ failed
                   └→ cancelling → cancelled
```

Only one terminal state is valid. Control and Runtime must deduplicate `invocationId`; a retry cannot execute a non-idempotent handler again unless an operation-specific contract explicitly permits it.

Invocation input and output are schema-validated at the Control boundary and again at the Runtime boundary. Errors use stable machine codes plus safe user-facing messages; transport errors are not exposed as plugin business errors.

Cancellation has these rules:

- the SDK provides a per-invocation cancellation signal;
- a deadline causes the same cancellation path as an explicit authorized cancel request;
- cancellation is cooperative unless an isolated execution mode specifies stronger termination;
- Control waits for a terminal acknowledgement up to a bounded drain timeout;
- a Transport disconnect does not silently mean either “cancel” or “continue”; each operation class declares and tests its disconnect policy;
- late output after a terminal state is discarded and reported through diagnostics without being shown to another attachment.

## 10. Portable command descriptor and command tree

Portable command syntax belongs to the Runtime command catalog, not a TUI-only or GUI-only registry. One `CommandDescriptor` contains the complete tree needed for discovery and invocation:

```json
{
  "descriptorVersion": "0.1.0",
  "id": "com.example.codex",
  "name": "codex",
  "title": "Codex",
  "description": "Manage Codex integration",
  "children": [
    {
      "id": "com.example.codex.login",
      "name": "login",
      "description": "Authenticate Codex",
      "children": [
        {
          "id": "com.example.codex.login.browser",
          "name": "browser",
          "description": "Use browser authentication",
          "inputSchema": {
            "type": "object",
            "additionalProperties": false
          }
        },
        {
          "id": "com.example.codex.login.device",
          "name": "device",
          "description": "Use device-code authentication",
          "inputSchema": {
            "type": "object",
            "additionalProperties": false
          }
        }
      ]
    },
    {
      "id": "com.example.codex.set",
      "name": "set",
      "description": "Change a Codex setting",
      "children": [
        {
          "id": "com.example.codex.set.native-compaction",
          "name": "native-compaction",
          "arguments": [
            {
              "id": "value",
              "position": 0,
              "required": true,
              "type": "string",
              "enum": ["on", "off"]
            }
          ],
          "options": [],
          "inputSchema": {
            "type": "object",
            "required": ["value"],
            "properties": {
              "value": { "enum": ["on", "off"] }
            },
            "additionalProperties": false
          }
        }
      ]
    }
  ]
}
```

`inputSchema` validates `command.input` in the InvocationContext. Argument and option declarations map Presentation syntax to stable input-property names; raw command tokens never cross the Runtime protocol boundary.

The final contract must define:

- globally namespaced command IDs and sibling-unique syntax tokens;
- ordered positional arguments, named options, subcommands, defaults, enums, validation, sensitive-input markings, and their mapping to stable input properties;
- a bounded JSON Schema vocabulary for terminal-node input and output;
- localization and aliases as display/input metadata that never replace stable IDs;
- duplicate-ID, duplicate-token, shadowing, depth, size, and cycle rejection;
- authorization, timeout, concurrency, disconnect, and cancellation policy per terminal operation;
- deterministic behavior when an intermediate tree node is invoked.

A TUI may parse `/codex login device`; a Web UI may render nested controls; both produce the same typed invocation of `com.example.codex.login.device`. A raw shell command string is not the Runtime protocol payload.

Explicit commands such as `login browser` and `login device` are preferred when they represent a user choice. A generic `login` command may negotiate a flow, but it may inspect only the current invocation's Presentation capabilities.

## 11. Ephemeral Presentation channel

Short-lived user interaction must not be smuggled into a persistent session result. During an authorized invocation, a plugin may request a bounded transient message through the invocation-scoped Presentation facade:

```json
{
  "messageVersion": "0.1.0",
  "messageId": "ephemeral:01K3EXAMPLE",
  "invocationId": "invocation:01K3EXAMPLE",
  "kind": "auth.device-code",
  "sensitivity": "secret",
  "noPersist": true,
  "expiresAt": "2026-08-17T11:55:00Z",
  "content": {
    "verificationUri": "https://example.com/device",
    "userCode": "ABCD-EFGH"
  },
  "affordances": [
    { "type": "link.show", "field": "verificationUri" },
    { "type": "clipboard.copy", "field": "userCode" },
    { "type": "qr.render", "field": "verificationUri" }
  ]
}
```

`noPersist` is always `true`; a false or missing value is rejected. `expiresAt` is required and bounded by the message-kind contract. Expiry, detach, cancellation, or invocation termination disposes the message and instructs every Presentation replica to clear it.

Initial sensitivity levels are:

| Level | Minimum handling |
| --- | --- |
| `public` | Transient and excluded from session history; bounded diagnostic metadata may be recorded. |
| `private` | Content redacted from logs, traces, analytics, crash reports, and notifications. |
| `secret` | Private handling plus no content caching, offline queues, previews, or unattended actions. |

The name `public` does not waive `noPersist`. It only controls diagnostic redaction.

Every registered message kind defines a minimum sensitivity. A plugin may request stricter handling but cannot downgrade that minimum; for example, `auth.device-code` is always `secret` regardless of the value supplied by plugin code.

An affordance is a request, not an instruction to take an unattended action. `link.open` and `clipboard.copy` require the matching negotiated capability and an explicit user gesture. QR rendering encodes the already-audited field; the Runtime does not send arbitrary image or script payloads. The initial URI policy should allow HTTPS only, with other schemes requiring separate review.

If the current invocation cannot present a required message safely, the handler returns a typed `presentation-unavailable` outcome or follows an explicitly defined fallback. It must not open a Runtime-side browser, write the secret to a session log, or borrow another attachment's Presentation.

## 12. Authorization, privacy, and security

Runtime capability, Presentation capability, permission, and trust evidence are distinct:

- a Runtime capability says the Runtime implements an operation;
- a Presentation capability says the attached endpoint can offer an interaction under a defined contract;
- a grant says an authenticated subject may use an operation against a specific Runtime scope;
- enforcement says Control and the execution mode prevent unauthorized paths.

Minimum requirements are:

1. Control authenticates both ends and binds the Presentation descriptor, Runtime generation, principal, and grant to every invocation.
2. Runtime reauthorizes the command and scope before invoking plugin code. Client-provided capability JSON alone is not trusted.
3. Grants are Runtime-scoped and least-privilege. Switching Runtime requires an independent grant decision.
4. Revocation blocks new work immediately and cancels or drains existing work according to declared policy.
5. Invocation IDs, attachment IDs, generation IDs, deadlines, and replay protection are verified before dispatch.
6. Descriptors and contexts minimize stable device identifiers and personal data. Plugins normally receive a typed capability facade, not authentication credentials or raw transport metadata.
7. Cross-machine transports provide confidentiality, integrity, peer authentication, bounded frames, and resistance to replay and resource exhaustion.
8. Presentation surfaces attribute the requesting plugin and Runtime, sanitize text, validate URI schemes, and keep link opening and clipboard writes behind user gestures.
9. Ephemeral content is excluded from session history, logs, telemetry, analytics, crash reports, persistent queues, and reconnect replay.
10. Provenance records may contain IDs, timestamps, state transitions, sizes, and redacted error codes, but never transient secret content.

These controls do not make trusted in-process plugins safe against direct Node.js access. The execution-mode limitation from RFC 0001 remains visible to the user and in conformance evidence.

## 13. Failure, detach, and recovery semantics

Failures are scoped so one attachment cannot corrupt another:

- **Presentation failure:** detach its attachments, dispose its transient messages, and apply each invocation's disconnect policy. Other Presentations remain attached.
- **Transport interruption:** mark the attachment unavailable, stop new dispatch, and either drain or cancel in-flight work according to the declared policy. No implicit replay occurs.
- **Control restart:** reject stale attachment and invocation credentials unless a separately specified resume protocol restores them safely.
- **Runtime generation replacement:** reject invocations for the old `generationId`, dispose old handlers through normal plugin deactivation, and require descriptor renegotiation.
- **Plugin handler failure:** return a typed, redacted failure for that invocation and preserve the Runtime plus unrelated handlers where the execution mode permits.
- **Slow consumer:** apply bounded queues and backpressure; never convert a transient secret channel into a durable backlog.

Cleanup is idempotent. Detach and cancellation may race, so the final protocol defines which component owns the terminal transition and how duplicate cleanup is acknowledged.

## 14. Intended developer experience

Plugin code binds handlers during normal generation activation, then receives per-invocation context:

```ts
ctx.commands.handle('com.example.codex.login.browser', async (_input, invocation) => {
  if (invocation.presentation.has('presentation.link.open')) {
    const challenge = await createBrowserChallenge()

    await invocation.presentation.show({
      kind: 'auth.browser-link',
      sensitivity: 'secret',
      noPersist: true,
      expiresAt: challenge.expiresAt,
      content: { verificationUri: challenge.verificationUri },
      affordances: [{ type: 'link.open', field: 'verificationUri' }],
    })

    return await challenge.wait({ signal: invocation.signal })
  }

  return { code: 'presentation-unavailable' }
})
```

Package names and signatures are illustrative. The important properties are:

- command metadata and tree are declarative and available before invocation;
- the handler is already active and receives one typed context per call;
- capability checks are made against that call, not activation state;
- cancellation uses the invocation signal;
- transient interaction uses a constrained facade and never the session result;
- no ordinary plugin API reveals SSH, WebSocket, local IPC, or “remote.”

Tooling should generate TypeScript types from command input/output schemas, provide a fake Presentation for unit tests, and fail tests that use undeclared commands, missing capability checks, persistent transient payloads, or attachment-global state.

## 15. Headless conformance requirements

The first reference harness must run without a graphical session. It uses fake Runtime, Control, Presentation, and Transport implementations plus a deterministic clock.

Conformance includes at least:

1. RuntimeDescriptor, PresentationDescriptor, CommandDescriptor, InvocationContext, result, cancellation, and ephemeral-message schema fixtures.
2. Two concurrent Presentations with disjoint capabilities invoking the same active handler without capability leakage.
3. One Presentation attached to two Runtimes with independent grants, generations, cancellation, and command catalogs.
4. Proof that attach, command discovery, and invocation never activate an inactive plugin.
5. Complete command-tree round trips, typed validation, duplicate and malformed tree rejection, and identical command IDs across renderers.
6. Cancellation before dispatch, during execution, after completion, at deadline, and during detach.
7. Transport loss, duplication, reordering within allowed framing, stale generation, replay, and bounded-backpressure fixtures.
8. Ephemeral expiry, redaction, no persistence, no reconnect replay, gesture gating, and capability-fallback fixtures.
9. Authorization denial before plugin code, cross-attachment isolation, grant revocation, and redacted provenance reports.
10. A zero-capability headless Presentation that receives typed unavailability instead of a crash or an attempt to launch a browser.

Passing an in-memory test does not prove an SSH or WebSocket adapter. Each adapter publishes its own versioned transport evidence against the same semantic suite.

## 16. Remote SSH conformance matrix

Remote SSH is the first required end-to-end counterexample, not the privileged architecture.

| Scenario | Presentation capability snapshot | Required assertion |
| --- | --- | --- |
| Remote Runtime + local TUI | text, link display, optional clipboard; no browser open | Device flow is rendered locally; no browser launch occurs on the Runtime. |
| Remote Runtime + local GUI | text, link display/open, optional QR | Opening is offered by the GUI after a user gesture; the Transport only forwards the standard message. |
| One Runtime + TUI and Web UI concurrently | Different capability maps and grants | Each invocation sees only its own immutable snapshot; messages and cancellation never cross attachments. |
| One TUI attached to Runtime A and Runtime B | Separate Runtime generations and grants | Switching views never retargets an invocation or reuses a grant, ephemeral handle, or cancellation token. |
| Full `/codex` command tree over SSH | Typed command catalog | Root, nested `login browser`, `login device`, options, and help metadata survive the round trip. |
| SSH disconnect during a command | Operation-specific disconnect policy | Control reaches one bounded terminal outcome; no implicit replay and no transient-secret backlog occurs. |
| Presentation reconnects with changed capabilities | New attachment and descriptor snapshot | Old invocations retain their old snapshot; new invocations use only renegotiated capabilities. |
| Unauthorized Presentation or stale generation | Any | Runtime rejects before plugin code and emits only redacted diagnostics. |
| Headless client | Empty capability map | Handler returns a typed unavailable/fallback result; no GUI assumption or crash occurs. |

Equivalent semantic cases must later pass over local IPC and at least one non-SSH remote transport so the standard does not accidentally encode SSH behavior.

## 17. Delivery and compatibility path

This RFC proceeds separately from RFC 0001 v0.1:

### Phase A: protocol documents

- freeze terminology and ownership boundaries;
- publish versioned schemas and valid/invalid fixtures;
- define command-tree, invocation, cancellation, attachment, and ephemeral-message state machines;
- define authorization and privacy threat models.

### Phase B: headless reference broker

- implement deterministic in-memory Control and Transport;
- implement fake Runtime and Presentation adapters;
- publish typed SDK facades and provenance-safe diagnostics;
- pass multi-Presentation and multi-Runtime isolation tests.

### Phase C: Remote SSH counterexample

- implement one reviewed SSH transport adapter without changing plugin APIs;
- prove full command-tree transport, per-invocation capability snapshots, cancellation, detach, and transient device authorization;
- compare with a local IPC adapter using the same semantic fixtures.

### Phase D: independent Presentation evidence

- run the same suite with at least two independently implemented Presentation products;
- document capability gaps rather than emulating unsupported behavior;
- publish version-bound conformance evidence and known limitations.

No phase creates a package entrypoint or compatibility claim merely by publishing this Draft.

## 18. Open questions

1. Which party signs or attests Runtime and Presentation descriptors, and how are keys rotated?
2. Which Presentation capabilities form the smallest portable initial registry?
3. Is `presentation.prompt.select` part of this protocol or a separate interactive-prompt RFC?
4. Which operation classes default to cancel or continue after detach, and may a user override that policy?
5. What deduplication and idempotency evidence is required before retrying an invocation?
6. What maximum lifetime, size, and allowed URI schemes apply to each ephemeral message kind?
7. Can a reconnect resume an attachment safely, or must v0 always create a new one?
8. What minimum provenance can be retained without creating a cross-device tracking identifier?
9. How are capability downgrades handled while an attachment is draining?
10. Which Control responsibilities must be centralized within one trust authority, and which can be federated?

## 19. References and discussion inputs

- [RFC 0001: Plugin Manifest, Capabilities, and Events](0001-plugin-manifest-capabilities-events.md)
- [Community Issue #23: unified plugin API, events, and SDK discussion](https://github.com/omdsh-dev/community/issues/23)
- [Remote SSH counterexample and command/presentation gaps](https://github.com/omdsh-dev/community/issues/23#issuecomment-5306386927)
- [Runtime, Presentation, Control, and transport decomposition](https://github.com/omdsh-dev/community/issues/23#issuecomment-5306670321)
