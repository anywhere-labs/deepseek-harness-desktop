# Research: What DSH Plugin Developers Actually Need

English | [中文](dsh-plugin-needs.zh.md)

Status: Source study, 2026-08-17. This describes observed needs and design implications; it is not an endorsement, security review, compatibility badge, or stable Fabric API.

## 1. Method and limits

We used two evidence sets:

1. the public [DSH 1024Store / awesome DeepSeek Harness plugin catalog](https://github.com/imsai-sh/awesome-deepseek-harness-plugins) at commit [`415a2d0`](https://github.com/imsai-sh/awesome-deepseek-harness-plugins/tree/415a2d0a78c93b3671dc2718721e52f39f06fb96), whose generated README listed 3,809 repositories on 2026-08-17;
2. static source inspection of twelve open-source plugins selected to cover UI, tools, sessions, memory, models, files, external integrations, package management, and terminal behavior.

We cloned repositories and read manifests, patches, Host and Client entrypoints, tests, and documentation. We did not install dependencies or execute third-party plugin code. The sample is intentionally functional rather than statistically random. It tells us which contracts are needed; it does not measure popularity or code quality.

The catalog itself is evidence for a better manifest. Its current generated categories include 65 UI plugins, 81 tools, 51 development/runtime plugins, 24 workflows, 20 session/message plugins, 19 notifications/integrations, 17 memory plugins, 7 model/provider plugins, 6 themes, and 3,491 entries still awaiting classification. Package names and a patch file are not enough to infer compatibility, privileges, runtime faces, native requirements, or extension points reliably.

## 2. Representative plugins

| Plugin | User-facing function | Current implementation | Compatibility-layer need |
| --- | --- | --- | --- |
| [DSH Better Sidebar](https://github.com/omdsh-dev/DSH-better-sidebar/tree/a673f2399f14c5cec8e1673511049721512e28ad) | A full file/editor/terminal/Git/sidebar workbench and a registry for third-party tabs and file viewers. | Dual Host/Client plugin; private HTTP/WS routes, UI slots, client service registry, structural probes, and native PTY. | Versioned sidebar/tab/file-viewer contribution, cross-face bridge, scoped files, process/PTY, and conflict rules. |
| [dsh-stylevault](https://github.com/GptsApp/dsh-stylevault/tree/b627f3a40c86cee9016d3749368479c08b5443b9) | Theme catalog and live appearance editing. | Client theme APIs plus settings UI and localStorage; DOM observation and generated-class patching when semantic tokens are insufficient. | Theme/token contribution, declarative settings, durable client storage, and an explicit Host-specific escape hatch instead of DOM patching. |
| [dsh-session-export](https://github.com/bwndlct/dsh-session-export/tree/eb18389192e36934718877fd7c6eb397f5cf1cd4) | Export a session through a model tool or slash command. | Reads internal session events and writes directly to the workspace with Node filesystem APIs. | Canonical transcript projection, commands/tools, mediated artifact export, workspace scopes, and user-visible file outcomes. |
| [dsh-memento](https://github.com/PerryLink/dsh-memento/tree/724ad2ec2853f136d9730858295d4d397f4711fc) | Long-term memory, tools, prompt injection, approvals, and a management panel. | Dual face; storage and tool services plus internal event vocabulary, structural service probing, and raw UI. | Plugin-private storage, context-contribution pipeline, tool/interceptor contracts, transcript read, and typed management UI. |
| [dsh-web-search-exa](https://github.com/TonyDua/dsh-web-search-exa/tree/083706bae60af8e1f3776b02448f17c140c3f571) | Exa-backed search provider. | Registers a Host search provider, uses API-key or remote MCP network paths, and relies on manual provider-ID coordination. | Provider registry/arbitration, secret references, scoped network grants, settings schema, health and fallback semantics. |
| [dsh-bash-terminal](https://github.com/MAXeaglet/dsh-bash-terminal/tree/6894913d71098f2ea24120d3a1afd5771f9ccd4a) | Model shell tool and interactive terminal. | Host subprocess/sandbox services, Client settings row, and a direct node-pty fallback where the official seam is missing. | Process, shell environment, PTY and job capabilities with platform/native ABI descriptors, tree cancellation, and explicit fallback status. |
| [dsh-codex-auth](https://github.com/suntianc/dsh-codex-auth/tree/484f5383dc7a80df426ef817daf02a67d9c1dc45) | Codex authentication, models, search, image tool, usage, and settings. | Registers LLM/search/tool providers, reads local auth, makes provider requests, and opens custom loopback RPC to Client UI. | Model/provider SPI, secret vault, network scopes, media/files, provider conflict policy, typed Host↔Client bridge, and settings. |
| [dsh-market](https://github.com/dsh-market/dsh-market/tree/5c4d8c25f0860d67755f719f5e149f99219fd79a) | Install, update, remove, back up, and manage plugins and themes. | Reads and mutates profile manifests, lockfiles and modules; invokes DSH/pnpm; inspects Loader entries for some live updates. Desktop already supplies narrower profile and package services. | Transactional profile/package management, progress, locks, build-script consent, rollback/restart, and no raw Loader/Fiber access. |
| [dsh-genui](https://github.com/omdsh-dev/dsh-genui/tree/4415bef7c15376b0b4cecc895fe26823840d0977) | Interactive UI blocks inside assistant replies and an action loop back to the model. | Host tool/system-prompt/assets; Client fence renderer and slots; falls back to internal service reflection and DOM observation on older Hosts. | Typed content renderer, sandboxed rich view, versioned action messages, static assets, context contribution, and feature negotiation. |
| [dsh-notify-bark](https://github.com/pc439527/dsh-notify-bark/tree/26e229876312b18cc46b7a7ba04daa73e0226603) | Send turn/tool/approval notifications through Bark. | Observes internal session event names, stores settings, sends outbound requests, and builds custom RPC because third-party settings are not exposed to Client. | Canonical observations, notification policy, network/secret scopes, deduplication, settings, and a standard bridge. |
| [dsh-files](https://github.com/taxueseek/dsh-files/tree/2c453ab3f74659f91a84a35f71ff270eea77e674) | File upload cards and a document-reading tool. | Dual face; custom upload route, direct workspace writes, tool registration, conversation slots, DOM drag/drop, custom CSS, TTL and deduplication. | File picker/upload/artifact APIs, attachment contribution, quotas, session/workspace scope, tools, and composer contribution. |
| [dsh-sidechain](https://github.com/omdsh-dev/dsh-sidechain/tree/ee6fadd9bae9efb36477ec17c58e1409eeabaf88) | Side conversations and sub-session panels. | Host agents/subagents plus Client conversation UI; patches Agent methods to change settlement and message delivery. | Session actions, child-session identity, delivery/interceptor contract, durable relationships, and typed conversation contributions. |

Across this sample, two plugins were Host-only, one was effectively Client-only, and nine needed both faces. Cross-face behavior is not an edge case; it is the normal shape of substantial DSH plugins.

## 3. The capabilities developers repeatedly need

### 3.1 Identity, compatibility, and services

A useful manifest needs more than `dsh.bundle.patch`:

- stable plugin ID, publisher and plugin version;
- manifest and Fabric API versions;
- Host and Client faces, supported surfaces, platforms, architectures, and native modules;
- required, optional, and provided capabilities with versions;
- declared contributions, subscriptions, sensitive scopes, external domains, executable code, and install/build scripts;
- honest compatibility evidence: declared, authorized, tested, certified, or unknown.

The runtime needs a versioned service registry with required/optional dependency semantics, provider uniqueness or arbitration, health, feature negotiation, and owner-scoped disposal. It must replace internal reflection and arbitrary `ctx.get()` probing, not standardize those workarounds.

### 3.2 UI contributions and renderers

Observed UI needs are structurally different:

- settings sections and rows;
- command palettes, menu actions, status indicators, notifications, and dialogs;
- conversation header, composer button/dock, tool card, command result, message-content and fence renderers;
- theme and semantic token layers;
- sidebar tabs and file viewers;
- full rich views such as GenUI, dashboards, editors, terminals, and workbenches.

Fabric therefore needs the four-layer UI model from the [mature-framework study](mature-plugin-frameworks.md): declarative contributions, typed providers/renderers, sandboxed rich views, and clearly labeled Host extensions. Slot IDs need schemas, version ranges, cardinality, priority, fallback and collision diagnostics. Generated CSS classes, MutationObserver, raw DOM, or imported product React components cannot be the supported portable path.

### 3.3 Agent, tool, model, and context extension

Developers need to:

- register tools and slash/product commands;
- register LLM, search, image, memory, and other provider types;
- inspect model capabilities without credentials;
- add bounded system/context fragments at a defined phase;
- observe tool execution;
- request user approval or enforce policy before a tool executes;
- render the result through a declared renderer.

These are registries and pipelines, not one generic service. Provider IDs need ownership and arbitration. Tool inputs/results need schemas, cancellation, timeout, audit and privacy. Prompt contributions need provenance, deterministic order and token budgets. Tool approval needs an ordered interceptor contract with an explicit failure policy.

### 3.4 Sessions, messages, and workflows

Plugins need stable views and actions for sessions without receiving live Agent objects:

- list/get/paginate redacted sessions and canonical transcript entries;
- observe message, turn, tool, approval, child-session and job events;
- send, continue, interrupt, resume, branch or create a session when granted;
- select model or mode through a stable operation;
- relate child sessions and jobs to their owners;
- append a namespaced custom durable event when the Host supports it.

Observation, action, interception, context contribution, and durable job behavior must be separate protocols. Event DTOs need IDs, correlation/causation, scope sequence, privacy classification, ordering and replay boundaries. Sidechain-style monkey patches and hard-coded private event vocabularies are evidence of a missing contract, not APIs to preserve.

### 3.5 Cross-face bridge

Every dual-face plugin should receive a namespaced, typed bridge instead of opening a private route:

- request/response RPC for small operations;
- bounded streams for progress and live data;
- Host-served static/media resources;
- automatic plugin/session/workspace scoping;
- authentication, authorization, CSRF/origin policy, size/rate limits, cancellation, disconnect and secret redaction;
- schema/version negotiation and test fakes.

The Broker can map this to Cordis, loopback HTTP/WS, IPC, or another Host transport. Plugin code should not care which transport is used.

### 3.6 Files, network, secrets, process, and packages

These sensitive features are common enough to require first-class mediated APIs:

- sandbox-aware file read/write, user file picker, upload, attachment/media, and artifact export;
- declared network origins/methods, bounded fetch, redirect/timeout policy, and secret references that never cross to Client code;
- subprocess, shell environment, PTY, background jobs, progress, process-tree cancellation, platform and native ABI constraints;
- active profile identity plus transactional plugin install/update/remove/enable/disable/restart with locking, backup and rollback.

In trusted in-process mode these APIs improve compatibility, consent and auditing but cannot stop malicious code from importing Node APIs. Strong enforcement requires an isolated execution mode.

## 4. Priority based on observed breakage

### P0 — remove the most common private coupling

1. manifest/schema and Host Descriptor;
2. versioned service negotiation and activation ownership;
3. declarative UI contributions with collision diagnostics;
4. canonical session/message/tool observations and narrow session actions;
5. typed Host↔Client bridge and static assets;
6. mediated files/artifacts, network and secrets;
7. lifecycle/testkit fixtures for HMR, provider replacement and shutdown.

### P1 — enable advanced plugin categories

1. typed renderers and sandboxed rich views;
2. tool, model/search and other provider SPIs;
3. context-contribution and tool-approval interceptor RFCs;
4. process/PTY/job contracts;
5. transactional profile/package management.

### P2 — distribution and stronger isolation

1. signing, provenance, review/certification evidence and vulnerability response;
2. isolated Worker/process execution with enforceable module, file, network and resource boundaries;
3. modpack compatibility evidence and reproducible cross-Host test matrices.

This does not mean all P0 APIs must ship in Fabric v0.1. It means the manifest, Broker, face model and Adapter must leave space for them without exposing upstream internals as an interim public API.

## 5. Target authoring experience

For a normal plugin, developers should be able to write:

```ts
import { definePlugin } from 'dsh-community-fabric/sdk'

export default definePlugin((ctx) => {
  ctx.tools.register('com.example.export', exportTool)

  ctx.messages.observe('received', event => {
    ctx.log.debug('message received', { id: event.id })
  })

  ctx.ui.toolResults.bind('com.example.export.result', exportResultRenderer)
})
```

The exact package and method names are not frozen. The intended experience is:

- the manifest declares the tool, renderer, event interest, permissions and faces once;
- generated types expose only negotiated APIs;
- registrations are automatically removed with the activation;
- a fake Host exercises the same schemas, cancellation, lifecycle and error behavior as a real Host;
- the DSH Adapter translates to official services and slots;
- missing semantics produce `unsupported` with a human explanation, never a silent private workaround.

Advanced plugins may have a Host entry and an isolated Client view, but they use a generated bridge instead of importing each other's implementation or inventing HTTP routes.

## 6. Product conclusion

Koishi and Chrome are strong references, but real DSH plugins show where a theoretical standard would fail. A useful Fabric compatibility layer must cover the ways plugins extend the agent, not only how modules are loaded.

The decisive product boundary is:

> Plugins describe and implement their intent against Fabric contracts. The Host owns placement, authorization, lifecycle, transport, and policy. The DSH Adapter alone touches version-specific upstream mechanisms.

That boundary lets the ecosystem evolve without promising impossible cross-Host UI parity or pretending that a trusted JavaScript plugin is sandboxed.
