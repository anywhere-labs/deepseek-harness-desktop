# Security policy

[中文](SECURITY.zh.md)

## Current status

`dsh-community-market` is complete and built into DSH Desktop. It openly connects to a wide range of plugin data sources: anyone can provide, integrate, and use a source that follows the public schemas, while an existing API can become a cooperating source through a reviewed adapter shipped with Market. Its Host/Client runtime validates and normalizes catalog data, persists user-owned source choices, and performs constrained HTTPS requests only after a source is explicitly enabled. Market also implements a limited exact-version npm install path and receipt-backed uninstall through the managed package capability; the renderer has no package-manager access.

## Trust model

Catalog responses are untrusted remote input. A catalog listing or **Installable** card is not a security review, compatibility promise, maintainer verification, or endorsement. Plugin repository links and display metadata are validated and rendered as inert data.

Installing a plugin is a higher-risk action than browsing because the installed plugin and its dependency tree become local third-party code running with the user's permissions. The current installer rejects a target package that declares `preinstall`, `install`, `postinstall`, or `prepare`; this policy does not inspect or prove the safety of all dependency code. Package operations preserve all of these rules:

- installation starts only after an explicit user gesture and confirmation;
- the exact Host-verified npm package/version and active profile are visible before execution;
- no command string, script, or HTML from a catalog response is executed; provider commands are discarded, while any Host-reconstructed manual command is bounded, display-only, and never sent to a Desktop action;
- Market installation goes through the managed recoverable Desktop install capability; ordinary package operations cannot use the unprotected path for `plugin add`;
- only an exact stable npm target that passes independent registry, repository, integrity, bundle, deprecation, lifecycle-script, DSH rc.2, and bundled Node.js checks may proceed;
- previews and reads are cancellable; after confirmation is accepted, the serialized mutation is Host-owned and a UI disconnect only drops the response; a changed active profile or one-shot preview is rejected;
- uninstall owns only a valid Market receipt whose exact package and bundle still match in the active profile; it does not depend on the catalog source remaining available;
- opening DSH Terminal is an exact empty-body action that carries no command, path, or profile; it never pastes or executes the displayed manual hint;
- before a Market install, or a `dsh plugin add` launched through Desktop's built-in DSH Terminal, Desktop privately snapshots only the active profile's `package.json`, `pnpm-lock.yaml`, and `pnpm-workspace.yaml`; direct `pnpm`/`npm` commands in that terminal and commands in an external system terminal are outside this boundary;
- the snapshot does not back up or actively roll back `node_modules`, environment variables, or separate credential stores; because the three allowlisted files are copied as-is, they must not contain embedded credentials;
- one recovery record blocks the next protected plugin add until the following Desktop generation starts the Host successfully and receives a healthy Renderer report, or recovery is reconciled;
- if Host startup fails, or the Renderer fails or does not report healthy within 30 seconds, Desktop saves a local diagnostics archive before restoring only recognized before/after configuration images; unknown drift requires manual recovery, and automatic relaunch happens at most once;
- a successful mutation may issue a short-lived, one-shot restart grant; the normal success-path restart remains a separate explicit user choice and is never silent;
- credentials, environment variables, raw response bodies, and local paths are not exposed in the Market UI or user-facing errors;
- a catalog failure never blocks DSH or Desktop startup.

The automatic recovery diagnostics archive is retained locally and is not uploaded by the Market. It may include logs, system information, and crash evidence, so it must be handled as sensitive data and must not be described as completely redacted.

Any implementation that weakens these rules needs an explicit security review before merge.

## User-added catalog sources

Adding a source is a separate, explicit user action; a remote manifest cannot enable itself or choose its priority. The production client accepts HTTPS catalog endpoints only. It must reject URL credentials, fragments, unsafe schemes, and redirects to loopback, private, link-local, or cloud-metadata addresses. Every redirect and DNS resolution is checked again so an initially public URL cannot become a private-network request.

Source requests use no ambient cookies or credentials. They have bounded redirects, timeouts, concurrency, decoded response size, item count, nesting, and string lengths. The response must be JSON and pass the published schema before normalization. Remote adapter code, scripts, HTML, install commands, headers, and secrets are never accepted from a source manifest. A development-only loopback exception must be visibly enabled and must never change production defaults.

Only one source is selected for browsing at a time. Its failure may be shown beside its source name, but must not trigger a fallback source, modify the user's selection, erase local install receipts, or block DSH/Desktop startup.

## Reporting a vulnerability

Please report a suspected vulnerability privately to [t4wefan@qq.com](mailto:t4wefan@qq.com). Include the affected version or commit, operating system, reproduction steps, expected impact, and any proof of concept that can be shared safely.

Do not include secrets or personal data. Please do not open a public issue for an unpatched vulnerability. Ordinary bugs, catalog metadata corrections, and feature requests can use the repository's public issue tracker.

## Dependency and catalog reports

A vulnerability in a listed third-party plugin should normally be reported to that plugin's maintainer. A bad or misleading catalog entry should also be reported to the catalog provider, whether it is a cooperating provider or a source added by the user. Report it here as well only when the market shell itself mishandles the entry or presents an unsafe action.
