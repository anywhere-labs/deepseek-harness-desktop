# Security policy

[中文](SECURITY.zh.md)

## Current status

`dsh-community-market` remains private. Its read-only Host/Client runtime validates and normalizes catalog data, persists user-owned source choices, and performs constrained HTTPS requests only after a source is explicitly enabled. It has no installer or package-manager access.

## Trust model

Future catalog responses are untrusted remote input. A catalog listing is not a security review, compatibility promise, maintainer verification, or endorsement. Plugin repository links and display metadata must be validated and rendered as inert data.

Installing a plugin is a higher-risk action than browsing. A plugin runs locally with the user's permissions, and its package installation may execute lifecycle scripts. The future installer must therefore preserve all of these rules:

- installation starts only after an explicit user gesture and confirmation;
- the exact canonical source, derived install target, and active profile are visible before execution;
- no command string, script, or HTML from a catalog response is executed;
- Desktop installation goes through the managed `desktopPnpm.runPlugin()` capability;
- operations are cancellable, serialized, and joined during service teardown;
- credentials, environment variables, raw response bodies, and local paths are not exposed to the UI or logs;
- a catalog failure never blocks DSH or Desktop startup.

Any implementation that weakens these rules needs an explicit security review before merge.

## User-added catalog sources

Adding a source is a separate, explicit user action; a remote manifest cannot enable itself or choose its priority. The production client accepts HTTPS catalog endpoints only. It must reject URL credentials, fragments, unsafe schemes, and redirects to loopback, private, link-local, or cloud-metadata addresses. Every redirect and DNS resolution is checked again so an initially public URL cannot become a private-network request.

Source requests use no ambient cookies or credentials. They have bounded redirects, timeouts, concurrency, decoded response size, item count, nesting, and string lengths. The response must be JSON and pass the published schema before normalization. Remote adapter code, scripts, HTML, install commands, headers, and secrets are never accepted from a source manifest. A development-only loopback exception must be visibly enabled and must never change production defaults.

Each selected source fails independently. Failure of one source may be shown beside its source name, but must not hide successful results from other sources, trigger a fallback source, modify the user's selection, or block DSH/Desktop startup.

## Reporting a vulnerability

Please report a suspected vulnerability privately to [t4wefan@qq.com](mailto:t4wefan@qq.com). Include the affected version or commit, operating system, reproduction steps, expected impact, and any proof of concept that can be shared safely.

Do not include secrets or personal data. Please do not open a public issue for an unpatched vulnerability. Ordinary bugs, catalog metadata corrections, and feature requests can use the repository's public issue tracker.

## Dependency and catalog reports

A vulnerability in a listed third-party plugin should normally be reported to that plugin's maintainer. A bad or misleading catalog entry should also be reported to the catalog provider, whether it is a cooperating provider or a source added by the user. Report it here as well only when the market shell itself mishandles the entry or presents an unsafe action.
