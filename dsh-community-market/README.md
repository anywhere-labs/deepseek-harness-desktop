# DSH Community Market

[中文说明](README.zh.md)

DSH Community Market is the planned plugin-market shell for [DSH Desktop](../README.en.md). It will help people discover community plugins, understand what they do, and install them into the active work profile through one clear, confirmed action.

> **Current status: documentation-first scaffold.** This workspace does not yet contain a market page, catalog client, or installer. It is private in the monorepo until the first usable implementation is ready. Do not add it to a DSH profile yet.

## What we are building

The first usable version should make a small, understandable journey possible:

1. Browse and search a community catalog.
2. Open a plugin page with its description, source repository, and trust warning.
3. Choose **Install** and confirm the exact plugin and active profile.
4. Let Desktop run the existing managed DSH plugin command.
5. Prompt the user to restart Desktop when the profile change is complete.

The market is a shell around existing DSH capabilities. It does not invent a second plugin format, package manager, profile store, or privileged installer.

## Catalog source

The initial catalog adapter is planned around the public registry published by [DSH 1024Store](https://github.com/imsai-sh/awesome-deepseek-harness-plugins). That project maintains its own discovery, validation, website, API, and the separately published `dsh-1024store` plugin. DSH Community Market is an independent Desktop-specific shell; it is not a fork, repackaging, or official client of that plugin, and does not represent its maintainers, DeepSeek, or the listed plugin authors.

Catalog data is remote, replaceable, and untrusted. A listing means that a project matched the catalog's metadata rules; it does **not** mean that Anywhere Labs reviewed, recommends, or guarantees the plugin.

## Safety promise

- Background browsing never installs a package or executes repository code.
- Installation starts only after an explicit user action and confirmation.
- The market will derive an install target from a validated repository identity; it will never execute a command string returned by a catalog.
- The confirmation will show the exact source and active profile.
- Plugin changes will use the existing Desktop-managed DSH plugin service and run one operation at a time.
- The first release will not include accounts, telemetry, silent installs, automatic plugin updates, or a catalog backend.

Plugins run as local code with the user's permissions and may run package lifecycle scripts during installation. Read [Security](SECURITY.md) before implementing or reviewing installation behavior.

## Documentation

- [Market shell design](docs/market-shell.md): product boundary, architecture, profiles, failure behavior, and delivery phases.
- [Security](SECURITY.md): trust model, reporting, and non-negotiable installation rules.
- [Desktop plugin services](../dsh-plugin-desktop/docs/plugin-services.md): the existing `desktopProfiles` and `desktopPnpm` contracts the future implementation will consume.
- [DSH plugin development](../docs/plugin-development.en.md): the shared plugin model used by ordinary DSH and Desktop.

## Delivery plan

- **Phase 0 — current:** package ownership, documentation, trust boundary, and headless checks.
- **Phase 1:** read-only catalog provider, search, categories, plugin details, loading/empty/error states.
- **Phase 2:** explicit installation into the active profile through the managed Desktop service.
- **Later:** uninstall, update, recovery, richer verification signals, and multiple catalog providers.

Catalog collection, submission review, accounts, rankings, and hosting remain the responsibility of catalog providers rather than this package.

## License and attribution

Package code and documentation are licensed under the [MIT License](LICENSE). No DSH 1024Store code, artwork, or catalog snapshot is bundled in this scaffold. Its public catalog metadata is published under CC0-1.0; the source and provenance remain documented by the [upstream catalog project](https://github.com/imsai-sh/awesome-deepseek-harness-plugins).
