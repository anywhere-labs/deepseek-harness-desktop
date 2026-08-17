# Research: The VS Code Extension Model and Its Value to the Fabric RFC

English | [中文](vscode-extension-model.zh.md)

Status: source and official-documentation research, 2026-08-17. This document is design input for DSH Community Fabric, not a published Fabric API.

## 1. Scope

VS Code is relevant not because DSH should become a code editor, but because it has spent years solving three problems that closely resemble DSH's:

1. letting extensions add commands, settings, views, and domain behavior without editing product source or the product DOM;
2. separating statically discoverable feature declarations from runtime implementations;
3. exposing one product API across local, browser, and remote environments without sharing internal objects.

This investigation uses only first-party Microsoft sources:

- [Extension Manifest](https://code.visualstudio.com/api/references/extension-manifest), [Extension Anatomy](https://code.visualstudio.com/api/get-started/extension-anatomy), and [Contribution Points](https://code.visualstudio.com/api/references/contribution-points);
- [Extension Capabilities](https://code.visualstudio.com/api/extension-capabilities/overview), [Extension Host](https://code.visualstudio.com/api/advanced-topics/extension-host), [Remote Extensions](https://code.visualstudio.com/api/advanced-topics/remote-extensions), and [Web Extensions](https://code.visualstudio.com/api/extension-guides/web-extensions);
- [Webview](https://code.visualstudio.com/api/extension-guides/webview), [Workspace Trust](https://code.visualstudio.com/api/extension-guides/workspace-trust), [Extension Runtime Security](https://code.visualstudio.com/docs/configure/extensions/extension-runtime-security), and [Proposed API](https://code.visualstudio.com/api/advanced-topics/using-proposed-api);
- a fixed snapshot of Microsoft's official [`vscode-extension-samples`](https://github.com/microsoft/vscode-extension-samples/tree/3d8442b16c7f353779e266f16295703b2b4a6dcc) repository.

We read documentation, manifests, and source. We did not install dependencies or execute sample extensions.

## 2. What VS Code Actually Implements

VS Code extensibility is not one universal API. It is composed of static declarations, activation, runtime APIs, and Extension Hosts.

```text
package.json / contributes
  ↓ static discovery, indexing, presentation, and compatibility decisions
activation
  ↓ load code only when a feature is needed
register handler / provider
  ↓ bind an implementation to a declared ID
Extension Host
  ↓ isolate the product UI and select local, Web, or remote placement
```

### 2.1 Manifest and compatibility metadata

Every extension uses a root `package.json` as its manifest. Besides identity and version, it may declare:

- `engines.vscode`: the compatible VS Code API/product range;
- `main` and `browser`: Node and Web Worker entrypoints;
- `contributes`: static commands, settings, views, themes, tasks, tools, and more;
- `activationEvents`: when extension code is needed;
- `extensionKind`: whether execution should be near the UI or the workspace;
- `extensionDependencies` and `extensionPack`: functional dependencies and grouped installation;
- `capabilities.untrustedWorkspaces` and `virtualWorkspaces`: support in restricted environments.

The Marketplace and Host can understand much of the extension's presentation and runtime requirements without executing it.

### 2.2 Static Contribution Points

The official [Contribution Points](https://code.visualstudio.com/api/references/contribution-points) can be grouped by product purpose:

| Category | Representative implemented features | Design property |
| --- | --- | --- |
| Commands and entry surfaces | `commands`, `menus`, `submenus`, `keybindings` | Declare ID, title, and placement first; code only binds the handler. |
| Settings and conditions | `configuration`, `configurationDefaults`, `when` conditions | One schema drives validation, editor completion, and settings UI. |
| Product UI | `views`, `viewsContainers`, `viewsWelcome`, `customEditors`, themes, colors, and icons | The Host owns layout and rendering; the extension contributes metadata or a Provider. |
| Work execution | `taskDefinitions`, `terminal`, `debuggers`, `problemMatchers` | Declare discoverable types first, then create instances through runtime Providers. |
| Languages and documents | `languages`, `grammars`, `snippets`, semantic-token types | Simple capabilities can be fully declarative and require no executable code. |
| Authentication and Providers | `authentication`, language-model chat providers | The Host owns unified presentation and provider selection. |
| Agents and AI | agents, instructions, prompts, skills, language-model tools | Statically describe identity, input, and intent, then bind a controlled implementation. |
| Onboarding | `walkthroughs` | The Host presents installation steps and completion conditions. |

The important conclusion is not that Fabric should implement dozens of points at once. It is that each extension point has its own schema, ID, lifecycle, placement, conditions, and runtime binding rules.

### 2.3 Runtime handlers and Providers

Declarations describe what exists. Runtime APIs provide behavior:

| Pattern | VS Code example | Why it matters |
| --- | --- | --- |
| Handler | `commands.registerCommand(id, handler)` | A declared ID has one explicit execution path. |
| Data Provider | `registerTreeDataProvider(viewId, provider)` | The Host renders the tree; the extension supplies structured data and refresh events. |
| Domain Provider | completion, hover, task, debug, test, SCM, and filesystem Providers | Each domain defines its own input, output, cancellation, and composition semantics. |
| Controller | Test Controller, Source Control, and similar APIs | The Host owns user experience while the extension manages constrained domain objects. |
| Codec / Controller / Renderer | Notebook Serializer, Controller, and MIME Renderer | Data format, execution, and presentation can use separate contracts and runtimes. |
| Rich View bridge | Webview `postMessage` / `onDidReceiveMessage` | Custom UI exchanges messages with the extension process instead of sharing DOM or objects. |

Many registration APIs return a `Disposable`; long operations receive a `CancellationToken`. Extensions add owned resources to `ExtensionContext.subscriptions` so they are released during deactivation.

### 2.4 Conflict and arbitration are domain-specific

VS Code does not resolve every conflict with “last registration wins.” It selects rules by domain:

- commands, authentication providers, filesystem schemes, and similar identities require a unique owner and reject duplicate registration;
- some language Providers merge results from multiple implementations;
- some Providers use selector matching to choose the best implementation;
- when several Custom Editors match, the user can choose and persist a default;
- keybindings combine Host defaults, extension suggestions, and user configuration.

Fabric need not copy VS Code's selector scoring, but every capability or contribution must define cardinality, selector, priority, merge / first-result / pipeline / user-choice behavior, equal-priority tie-breaking, error isolation, timeout, cancellation, duplicate registration, and hot replacement. Load order must never become an undocumented arbitration rule.

### 2.5 UI capability levels

VS Code provides a clear UI escalation path:

1. native commands, menus, settings, notifications, Quick Pick, and status items;
2. Host-rendered Provider UI such as Tree View, Test Controller, and SCM;
3. Webview or Custom Editor only when native capabilities are insufficient.

Official guidance forbids extensions from accessing the Workbench DOM or injecting custom styles, and recommends using Webviews only when necessary. A Webview runs in a separate context and communicates through messages; it must also address CSP, resource URIs, themes, accessibility, state restoration, and disposal.

This strongly supports Fabric's four layers: declarative contributions, typed Providers/Renderers, isolated rich views, and Host-specific extensions.

### 2.6 Placement and multiple environments

The [Extension Host](https://code.visualstudio.com/api/advanced-topics/extension-host) may be:

- a local Node.js Host;
- a remote Node.js Host;
- a browser/Web Worker Host.

Extensions expose different entrypoints through `main` or `browser`, and use `extensionKind` to express a preference to run near the UI or workspace. In remote configurations, the UI and workspace can be on different machines; extensions cannot assume that local paths, processes, and UI share one environment.

This directly supports defining Fabric Host, Client, Worker, and Rich View as distinct runtime faces that communicate only through versioned DTO, RPC, stream, and asset channels.

Virtual Workspaces and FileSystemProvider also show that a resource need not be a local absolute path. Fabric portable resource contracts should use URIs, opaque resource IDs, and Host-mediated file/artifact capabilities. Only explicit local Host extensions should promise a physical disk path.

### 2.7 Lifecycle, state, and cancellation

VS Code activates an extension when its feature is needed. Commands, views, languages, filesystems, and tasks can trigger activation. Recent VS Code versions derive some activation conditions from contributions, avoiding duplicated author declarations.

Extensions receive workspace/global state, storage directories, and SecretStorage. They place registrations in subscriptions and use `deactivate` for additional cleanup.

Fabric should borrow resource ownership without copying the assumption that an extension activates only once per Extension Host session. DSH profile recomposition, Provider replacement, HMR, and recovery require the same plugin to activate and dispose repeatedly.

### 2.8 Trust and security facts

VS Code Workspace Trust lets an extension declare whether an untrusted workspace is:

- fully supported;
- completely unsupported;
- supported with limited functionality and restricted workspace configuration.

Microsoft also states that a desktop Node Extension Host has the same file, network, and process permissions as VS Code itself. Extension Host isolation protects the UI and some failure boundaries; it is not a plugin permission sandbox.

Fabric must therefore keep these states separate:

```text
Host supports a capability
≠ plugin requests it
≠ user or policy grants it
≠ runtime technically enforces isolation
≠ Marketplace security review
```

Publisher trust, plugin grants, and profile/workspace content trust must also remain distinct states.

### 2.9 Versions, experimental APIs, and tooling

VS Code makes a best effort to preserve stable Extension API compatibility. Unstable Proposed APIs must be enabled explicitly in Insiders/development environments and cannot be normal Marketplace dependencies.

Its toolchain covers scaffolding, types, an Extension Development Host, unit and integration testing, Web testing, VSIX packaging, and publication. Workspace Trust behavior is tested separately in trusted and untrusted states.

Fabric should retain a clearer multi-axis version model than VS Code: plugin, manifest schema, Fabric API, capability/event, Host product, SDK, and Adapter versions must not collapse into one product version.

## 3. What the official samples prove

The following samples come from Microsoft's official repository at commit [`3d8442b`](https://github.com/microsoft/vscode-extension-samples/tree/3d8442b16c7f353779e266f16295703b2b4a6dcc):

| Sample | Implementation pattern | Verifiable lesson for Fabric |
| --- | --- | --- |
| [Hello World](https://github.com/microsoft/vscode-extension-samples/tree/3d8442b16c7f353779e266f16295703b2b4a6dcc/helloworld-sample) | The manifest declares a command; code registers its handler with the same ID and owns the Disposable. | Contribution/implementation separation should be a contract, not a style suggestion. |
| [Tree View](https://github.com/microsoft/vscode-extension-samples/tree/3d8442b16c7f353779e266f16295703b2b4a6dcc/tree-view-sample) | The manifest declares containers, views, commands, menus, and settings; code supplies a TreeDataProvider. | A complex sidebar does not require DOM access when a domain Data Provider exists. |
| [Webview View](https://github.com/microsoft/vscode-extension-samples/tree/3d8442b16c7f353779e266f16295703b2b4a6dcc/webview-view-sample) | The manifest declares a View; code registers a WebviewViewProvider. | A Rich View still has a stable ID, Host placement, and Provider lifecycle. |
| [Custom Editor](https://github.com/microsoft/vscode-extension-samples/tree/3d8442b16c7f353779e266f16295703b2b4a6dcc/custom-editor-sample) | The document model and Webview are separate; messages synchronize state and standard save/undo/redo participate. | Rich UI must not bypass domain models and operation semantics. |
| [File System Provider](https://github.com/microsoft/vscode-extension-samples/tree/3d8442b16c7f353779e266f16295703b2b4a6dcc/fsprovider-sample) | Registers a URI scheme and a controlled filesystem Provider. | Plugins should implement a capability SPI rather than share internal storage objects. |
| [Task Provider](https://github.com/microsoft/vscode-extension-samples/tree/3d8442b16c7f353779e266f16295703b2b4a6dcc/task-provider-sample) | The manifest defines a task schema; code discovers and resolves tasks with cancellation. | Task definition, discovery, execution, and cancellation require a dedicated contract. |
| [Test Provider](https://github.com/microsoft/vscode-extension-samples/tree/3d8442b16c7f353779e266f16295703b2b4a6dcc/test-provider-sample) | The Host provides Test UI while the extension maintains the test tree, run profiles, and results. | Providers can support complex workflows without giving plugins control of the entire UI. |
| [Chat and tools](https://github.com/microsoft/vscode-extension-samples/tree/3d8442b16c7f353779e266f16295703b2b4a6dcc/chat-sample) | The manifest declares Chat/Tool metadata; runtime binds handlers/tools and receives cancellation and confirmation flows. | DSH tools, agents, and renderers should also use static declaration plus typed runtime binding. |

Together these samples show that a sustainable extension platform does not hand every internal object to a universal `ctx`; it accumulates well-bounded domain contracts.

## 4. Direct value to the Fabric RFC

### 4.1 Make contribution/implementation binding a core principle

The RFC should state that:

- the Manifest is the sole authority for discoverable command, setting, menu, View, Renderer, and Tool metadata;
- plugin code only binds a handler or Provider to a declared ID;
- every contribution type independently specifies schema, IDs, conflicts, cardinality, conditions, fallback, and lifecycle;
- the Marketplace and Host can present features and compatibility without executing the plugin.

The current RFC command design already follows this model. Every later standard extension point should use the same path.

### 4.2 Separate activation policy, business events, and interceptors

VS Code Activation Events only answer when to load an extension; they do not allow it to modify a business workflow. Fabric should still separate:

- `contributes`: what the Host knows before code runs;
- the Host's activation policy: when a selected and authorized plugin enters an activation scope;
- `subscriptions`: which events an active plugin receives;
- observation: what an active plugin may observe;
- action: what it may request;
- interceptor: what it may modify through an ordered controlled pipeline.

Fabric deliberately does not adopt demand activation in v0.1. A Host activates every selected and authorized plugin while assembling a runtime generation. Declared commands, Providers, and subscriptions do not trigger first-use activation. This matches current DSH composition, avoids missed events and first-call latency, and keeps activation order and failure reporting deterministic across Hosts. Demand activation can be reconsidered only in a later RFC backed by measured startup needs and conformance tests.

### 4.3 Prefer Providers over universal events and Panels

Tree, Task, Test, Debug, SCM, Language, and Tool capabilities use domain Providers instead of listening to a string event and mutating product internals.

Fabric should define Providers/Renderers for observed high-frequency needs one at a time:

- session tree;
- message and tool-result renderers;
- composer attachments;
- file viewers;
- model and search providers;
- tasks and jobs;
- package transactions.

Each Provider needs input/output DTO, cancellation, concurrency, ordering/arbitration, errors, and teardown semantics.

### 4.4 Model runtime faces and placement separately

VS Code local/web/remote behavior shows that placement is not a simple platform field. A later Fabric Runtime Faces RFC should define:

- the runtime type of each entrypoint;
- which capabilities are available in each face;
- requirements to run near UI, workspace/profile, DSH runtime, or isolated computation;
- identity, schema, cancellation, timeout, disconnect, and resource limits for cross-face RPC/streams;
- a prohibition on passing arbitrary JavaScript objects across faces or plugins.

### 4.5 Specify synchronous and asynchronous disposal

Fabric can define a stricter shutdown sequence than VS Code:

1. abort `ctx.signal`;
2. stop accepting new operations;
3. drain in-flight operations within a bounded deadline;
4. run Disposable / AsyncDisposable resources in reverse order;
5. invoke explicit deactivate;
6. isolate timeout failures and record unreleased resources.

This should become a Broker and testkit conformance requirement.

### 4.6 Add a content-trust dimension

Future Project/Profile Trust must not be folded into an ordinary capability grant. A plugin granted `process.run`, for example, should not automatically execute scripts from an untrusted repository.

At minimum, Fabric should distinguish:

- trusted publisher;
- approved plugin capability;
- trusted profile/workspace content;
- user intent confirmation for the current sensitive operation.

This need not enter v0.1, but the Manifest, Host Descriptor, and Broker must leave room for it.

### 4.7 Establish an experimental API channel

Borrow the Proposed API discipline:

- experimental capabilities are explicitly declared;
- only development Hosts or Hosts that explicitly allow them can enable them;
- stable Marketplace channels reject them by default;
- types and fixtures bind to a particular proposal version;
- maturation moves them into a stable namespace instead of silently changing an existing contract.

## 5. What Fabric should not copy

| VS Code design | Why Fabric should not copy it directly |
| --- | --- |
| Global `vscode` API namespace | Fabric should generate a minimal context from the Manifest; undeclared capabilities must not appear in the standard SDK. |
| Single-axis `engines.vscode` compatibility | Fabric has independent Hosts and must separate API, capability, Host, SDK, and Adapter versions. |
| Arbitrary string `when` context | Early versions should expose a small, versioned set of Host-owned condition keys instead of another Host-specific expression language. |
| ID-only `extensionDependencies` | Fabric services need required/optional semantics, version ranges, provider arbitration, and dynamic lifecycle. |
| Treating Node Extension Host as security isolation | It still has file, network, and process access; enforcement needs constrained modules and IPC. |
| Editor-specific layout and object model | Editor Groups, document selections, and debug concepts are not automatically cross-Host DSH standards. |
| Shipping every capability in the first release | VS Code accumulated these contracts over years; Fabric v0.1 should remain small. |

## 6. Recommended changes to RFC 0001

### Add to RFC 0001 now

1. Promote “static contribution + runtime binding by stable ID” to a core invariant.
2. Specify eager generation activation for every selected and authorized plugin; contributions and subscriptions are not activation triggers.
3. Distinguish Host activation policy, business subscriptions, observations, actions, and interceptors.
4. Specify activation-scoped Disposable / AsyncDisposable and bounded drain.
5. Preserve repeatable activation for profile recomposition and Provider replacement.
6. State that an execution process or Extension Host is a failure boundary, not automatically a security boundary.
7. Define how experimental capabilities mature into the stable standard.
8. Prohibit arbitrary cross-plugin object APIs through the standard contract.

### Split into later RFCs

- Runtime Faces and the cross-face bridge;
- UI Contribution, Provider, Renderer, Rich View, and conditions;
- Project/Profile Trust;
- Marketplace packaging, signing, scanning, and publication;
- multi-scope storage and Secret capabilities;
- domain semantics for Tools, Providers, tasks, and interceptors.

### Keep v0.1 deliberately small

The VS Code research does not justify putting dozens of extension points into Fabric v0.1. v0.1 still only needs to prove:

- Manifest, Host Descriptor, and capability negotiation;
- activation scope and repeatable disposal;
- static `commands` declaration and handler binding;
- `storage.local`;
- immutable `messages.observe`;
- conformance between a fake Host and a pinned DSH Adapter.

Its schema, Broker, and testkit must nevertheless leave the right seams for later domain contracts rather than exposing DSH, Cordis, DOM, or Loader internals as temporary public APIs.

## 7. Conclusion

VS Code's most important proof for Fabric is that an extension ecosystem can be powerful while extensions remain unable to modify product source or the UI DOM directly. The key is not a universal API, but a maintained set of domain extension points with clear responsibilities, static declarations, tests, cancellation, and disposal.

Fabric should adopt that engineering discipline while retaining its own advantages: multi-Host capability negotiation, repeatable activation, versioned Adapters, clearer authorization layers than VS Code, and a future optional isolated execution tier.
