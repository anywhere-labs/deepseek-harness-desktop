# Research: Mature Plugin Framework Patterns

English | [中文](mature-plugin-frameworks.zh.md)

Status: Research note, 2026-08-17. This is design input for DSH Community Fabric, not a published Fabric API.

## 1. Question and method

Fabric needs more than a manifest. It needs a durable answer for lifecycle ownership, dependency negotiation, UI extension, events, permissions, multiple execution environments, and developer tooling.

We compared primary documentation from three mature systems:

- [Koishi plugin lifecycle](https://koishi.chat/en-US/guide/plugin/lifecycle), [services and dependencies](https://koishi.chat/en-US/guide/plugin/service), and [event dispatch](https://koishi.chat/en-US/api/service/events.html);
- [Chrome extension permissions](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions), [optional runtime grants](https://developer.chrome.com/docs/extensions/reference/api/permissions), [message passing](https://developer.chrome.com/docs/extensions/develop/concepts/messaging), [service-worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle), and [extension UI](https://developer.chrome.com/docs/extensions/develop/ui);
- [VS Code extension anatomy](https://code.visualstudio.com/api/get-started/extension-anatomy), [contribution points](https://code.visualstudio.com/api/references/contribution-points), [extension capabilities](https://code.visualstudio.com/api/extension-capabilities/overview), [web extensions](https://code.visualstudio.com/api/extension-guides/web-extensions), and [webviews](https://code.visualstudio.com/api/extension-guides/webview).

They solve different product problems. The goal is not to copy one framework. It is to identify patterns that remain useful for DSH GUI, Web UI, TUI, launchers, and future isolated runtimes.

## 2. What each framework gets right

### 2.1 Koishi: Context owns dependencies and side effects

Koishi's most useful idea is not a particular event name. It is that every plugin activation receives a Context which owns registrations and side effects.

- `ctx.on()`, commands, middleware, and child plugins are released with the activation.
- Plugins can be enabled, disabled, reloaded, and activated more than once.
- Required services delay activation until available. If a required provider changes, dependent work rolls back and activates again.
- Optional services do not hold the whole plugin lifecycle hostage.
- `ctx.inject()` gives one feature a narrower dependency scope than the rest of the plugin.
- Service providers and consumers are separated. Multiple implementations may satisfy one service contract.
- Event dispatch has distinct parallel, serial, and first-result forms rather than pretending every event has identical semantics.

This solves a real ecosystem problem: a plugin should not leak listeners, routes, timers, tools, or UI entries after HMR, profile recomposition, provider replacement, or shutdown.

What Fabric should borrow:

1. activation-scoped resource ownership;
2. required and optional service negotiation;
3. provider replacement as an explicit lifecycle transition;
4. narrowly scoped child activations;
5. different dispatch contracts for observation and decision pipelines.

What Fabric should not expose:

- a raw Cordis/Koishi Context with arbitrary service lookup;
- TypeScript declaration merging as the public compatibility contract;
- same-process service access described as a security permission.

Fabric should generate a minimal typed context from the manifest. The Broker may use Cordis internally, but the plugin-facing contract must remain independent of Cordis and DSH versions.

### 2.2 Chrome: static intent, separate faces, mediated messages

Chrome extensions make identity, entrypoints, UI surfaces, permissions, and site access statically inspectable in `manifest.json`. Required and optional permissions are different. Optional access can be requested when the user invokes the feature, which gives the Host a meaningful moment to explain why it is needed.

Chrome also treats the extension as several cooperating execution environments:

- an event-driven service worker;
- content scripts attached to eligible pages;
- popups, options pages, side panels, and other extension pages;
- explicit one-shot messages or long-lived ports between those environments.

The service worker may be terminated when idle, so durable state belongs in storage rather than global variables. This is a valuable discipline even for a Host that initially keeps plugins alive: code becomes restartable, reconnectable, and easier to isolate later.

What Fabric should borrow:

1. one static manifest as the inspection and consent source of truth;
2. distinct required and optional grants;
3. explicit execution faces with serializable messages between them;
4. durable state outside transient runtime globals;
5. user-gesture boundaries for sensitive or disruptive actions;
6. Host-owned UI surfaces instead of arbitrary mutation of the product shell.

What Fabric must qualify:

- a capability declaration is only a request; support, user grant, and technical enforcement are separate facts;
- Chrome's security model depends on browser process and origin isolation. A trusted in-process Node plugin does not gain the same protection by adopting similar manifest fields;
- Fabric needs DSH scopes such as session, workspace, tool execution, model access, and profile, not Chrome URL match patterns.

### 2.3 VS Code: declare the contribution, bind the implementation

VS Code separates three concerns:

1. **Contribution Points** statically declare commands, settings, views, menus, themes, and other discoverable objects.
2. **Activation** decides when extension code needs to run.
3. **Runtime APIs** bind handlers or providers to declared IDs.

For example, command title and identity are declared once, while code registers the handler for that ID. This prevents the market, settings UI, command palette, and runtime from inventing separate metadata.

VS Code also has multiple UI levels:

- native, constrained surfaces such as commands, settings, notifications, status items, trees, and file pickers;
- typed providers for richer product-owned views;
- Webviews for custom HTML when native APIs are insufficient.

Webviews run in a separate context and communicate by messages. VS Code explicitly recommends using them sparingly because they cost resources and can easily violate product UX, accessibility, and theme conventions. Extensions cannot directly access the workbench DOM.

Web extensions add another important lesson: `main` and `browser` entrypoints are different runtime faces. A contribution-only extension can work without executable code, while a browser entrypoint runs without Node APIs.

What Fabric should borrow:

1. static contribution metadata plus runtime binding by stable ID;
2. typed product-owned UI surfaces before custom rich UI;
3. a sandboxed rich-view escape hatch with message passing, themes, accessibility, and resource policy;
4. separate Host and Client/Worker entrypoints rather than one bundle that assumes every environment.

Fabric deliberately does not adopt VS Code's demand-activation policy in v0.1. A Host activates every selected and authorized plugin while assembling a runtime generation. Contributions remain discovery metadata, and subscriptions control event delivery; neither becomes an implicit first-use activation trigger.

What Fabric should not copy literally:

- VS Code's workbench layout or editor-specific object model;
- arbitrary HTML as the default way to add every UI feature;
- one product's `when`-clause vocabulary as a cross-Host standard.
- demand activation before Fabric has a proven need and deterministic cross-Host semantics.

## 3. Combined design decisions for Fabric

| Problem | Adopted pattern | Fabric interpretation |
| --- | --- | --- |
| Identity and compatibility | Chrome/VS Code static manifest | Schema-valid identity, API range, faces, requirements, permissions, subscriptions, and contributions. |
| Dependencies | Koishi required/optional services | Capability negotiation and narrowly scoped activation; no generic service locator. |
| Cleanup and HMR | Koishi Context/Fork | Every registration and operation belongs to an activation and is disposed or aborted automatically. |
| UI discovery | VS Code Contribution Points | The manifest owns stable IDs, labels, placement requests, settings schemas, and compatibility metadata. |
| Rich UI | VS Code Webview + Chrome extension pages | Isolated view face, message protocol, CSP/resource policy, theme tokens, accessibility, and explicit Host placement. |
| Multiple runtimes | Chrome scripts/pages + VS Code main/browser | Separate Host, Client, and later Worker faces with a brokered cross-face protocol. |
| Sensitive access | Chrome required/optional permissions | Separate support, request, grant, and enforcement; request narrow scopes near user intent. |
| Restartability | Chrome ephemeral worker | Durable state lives in Host-managed storage; event handlers tolerate restart, reconnect, and replay. |
| Business events | Koishi's different dispatch modes | Separate observation streams, commands, interceptor pipelines, and context-contribution pipelines. |

## 4. UI should be four layers, not one universal renderer

A single `panel.render()` API cannot serve a settings toggle, Diff renderer, command palette, file uploader, full sidebar workbench, rich assistant card, and TUI.

Fabric should define four layers:

### Layer 1 — Declarative contributions

For commands, settings schemas, menus, status items, theme tokens, notifications, and simple forms. The Host owns rendering, localization, accessibility, ordering, and conflict UX. Some plugins can contain no Client code at all.

### Layer 2 — Typed providers and named renderers

For domain surfaces whose input and output have stable meaning: tool-result renderers, message-content renderers, composer accessories, file viewers, session trees, or model/settings cards. A provider binds to a declared ID and receives canonical DTOs rather than product components.

Each extension point defines cardinality, priority, fallback, conflicts, lifecycle, error boundaries, and Host coverage. Replacing one renderer is not equivalent to inserting a panel.

### Layer 3 — Sandboxed rich views

For dashboards, GenUI, complex editors, visualizations, or an entire sidebar workbench. The plugin supplies a Client/Worker view bundle in an isolated frame or equivalent Host container. It receives only a versioned message bridge and approved resources.

The contract must cover CSP, resource URLs, navigation, size, focus, keyboard handling, theme tokens, localization, accessibility, persistence, crash recovery, and message schemas. A TUI may reject this capability or provide a different Host-specific implementation.

### Layer 4 — Host extensions

Raw DOM, Electron, native widgets, terminal escape protocols, and Host-specific composition belong to organization-namespaced `x-*` capabilities. They may be useful and documented, but markets must not present them as portable.

Fabric may later define a very small cross-Host UI description for text, lists, buttons, inputs, and basic forms. It must not promise that arbitrary GUI UI can be rendered faithfully in a TUI.

## 5. Business behavior needs several protocols, not one event bus

### 5.1 Immutable observation streams

Examples: message received, session created, tool started, tool completed. Observers cannot alter the operation. Every contract defines payload schema, privacy scope, event identity, per-scope ordering, replay boundary, backpressure, error isolation, and shutdown behavior.

### 5.2 Commands and actions

Examples: send a message, resume a session, select a model, open a file, or run a declared command. These are request/result operations with authorization, cancellation, idempotency, stable errors, audit data, and a clear owning scope. They are not fake events.

### 5.3 Ordered interceptor pipelines

Examples: tool approval or a `before-send` policy. Interceptors can allow, deny, or return a narrowly defined rewrite. The contract must define deterministic ordering, timeout, failure policy, conflict behavior, provenance, reentrancy, and what later interceptors see. This needs a separate RFC before it becomes stable.

### 5.4 Context-contribution pipelines

Examples: memory, system instructions, or per-turn policy. Plugins contribute bounded fragments with source, priority, privacy classification, expiry, and token budget. The Host collects, validates, orders, and freezes them. Plugins do not mutate one shared prompt object or patch an internal prompt builder.

### 5.5 Durable jobs and workflows

Long-running automation needs job identity, checkpoints, progress, cancellation, retry policy, ownership, and reconnect/restart behavior. An in-memory listener plus a timer is not a workflow contract.

## 6. Target developer experience

The best parts of all three systems lead to a simple authoring model:

```text
manifest: declare identity, faces, requirements, permissions,
          subscriptions, and contributions
code:     bind handlers and providers to declared IDs
SDK:      expose only negotiated capabilities as typed APIs
Broker:   own cleanup, cross-face messages, grants, errors, and audit
Adapter:  translate stable contracts to the pinned DSH runtime
testkit:  validate the manifest and run the same lifecycle/capability fixtures as Hosts
```

A developer should not need to import DSH source, discover a Cordis service name, edit a patch file, create a private HTTP route, or manipulate the product DOM for common features. The normal loop should be scaffold → declare → implement → test against a fake Host → run against a development Adapter → pack.

## 7. What this research changes

Fabric should keep v0.1 small, but its architecture must leave the right seams:

1. keep the current manifest, negotiation, lifecycle, `storage.local`, `commands`, and immutable observation baseline;
2. add separate future specifications for runtime faces and cross-face messaging;
3. design UI as contribution/provider/rich-view/Host-extension layers;
4. split business behavior into observation, action, interceptor, context-contribution, and job protocols;
5. treat permissions as a four-stage support/request/grant/enforcement model;
6. make activation scopes and automatic cleanup non-negotiable;
7. never expose the upstream Cordis Context or internal DSH objects as the compatibility API.

The dedicated [VS Code extension-model study](vscode-extension-model.md) expands its contribution, Provider, UI, placement, lifecycle, and arbitration patterns from official documentation and samples. The [DSH plugin-needs study](dsh-plugin-needs.md) then tests the combined conclusions against real community plugins.
