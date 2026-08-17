# Security policy

[中文](SECURITY.zh.md)

## Current status

`dsh-community-market` is currently a private, documentation-only scaffold. It has no runtime entry, network request, user interface, or installer. There is no released functional version to add to a DSH profile.

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

## Reporting a vulnerability

Please report a suspected vulnerability privately to [t4wefan@qq.com](mailto:t4wefan@qq.com). Include the affected version or commit, operating system, reproduction steps, expected impact, and any proof of concept that can be shared safely.

Do not include secrets or personal data. Please do not open a public issue for an unpatched vulnerability. Ordinary bugs, catalog metadata corrections, and feature requests can use the repository's public issue tracker.

## Dependency and catalog reports

A vulnerability in a listed third-party plugin should normally be reported to that plugin's maintainer. A bad or misleading catalog entry should also be reported to the catalog provider. Report it here as well only when the market shell itself mishandles the entry or presents an unsafe action.
