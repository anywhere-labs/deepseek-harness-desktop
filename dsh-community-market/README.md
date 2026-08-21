# DSH Community Market

[中文说明](README.zh.md)

DSH Community Market is the open plugin market built into [AI Buddy](../README.en.md). It helps people discover community plugins and, on Desktop, install, manage, or remove npm packages that pass the Market Host's checks.

> **Current status: complete and built into AI Buddy.** The package provides loadable Host and Client entries, persisted user-owned source records, a constrained HTTPS client, standard sources and reviewed cooperating-source adapters, an official **Plugin market** tab under **Settings > Plugins**, a sidebar launcher, Host-managed install and receipt-backed uninstall, plus fail-closed enable/disable controls for mutable direct bundles. This is not a claim that listed or installable plugin code is safe.

## Available capabilities

The current interface has four views:

1. **Discover** shows all normalized listings loaded from the selected source. Clicking any card immediately opens the same action dialog, where Desktop checks for a managed installation before falling back to details or a safe, display-only manual hint.
2. **Installable** is a fail-closed structural candidate list derived from the selected source's complete index. It requires reviewed provider verification with a `repository_backlink`, an exact stable npm version, and a canonical repository, and excludes product-blocked packages. Catalog membership is independent of whether a package is installed, receipted, disabled, or was later uninstalled locally, so those states do not remove its card. Building this list does not query npm for every package; preview and execution separately decide whether a local operation is allowed, and its cards use the same action dialog as Discover.
3. **Installed** reconciles valid Market receipts with Desktop's active-profile direct-bundle inventory. Receipt-owned bundles can be uninstalled; mutable bundles can be disabled and enabled again. A disabled receipt-owned bundle keeps both Enable and Uninstall.
4. **Sources** selects and manages catalog sources. Exactly one source is browsed at a time.

Clicking a plugin card opens the dialog synchronously and asks the Host whether that exact source/item can use managed installation. A successful preview verifies it against the official npm registry, including identity, repository, integrity, runtime, lifecycle scripts, DSH bundle evidence, and the active profile, then turns the same dialog into an exact confirmation. The Host repeats mutable checks immediately before execution. If managed preview is unavailable, the dialog remains a details view and may show a display-only exact npm command reconstructed by the Host from normalized identity. It never uses a provider command, never sends that command to a Desktop action, and never executes it: opening DSH Terminal only opens Desktop's built-in terminal so the user can review, copy, and run the command themselves. A `dsh plugin add` launched through that built-in terminal uses Desktop's protected install-recovery boundary; direct `pnpm` or `npm` commands in that terminal and commands run in an external system terminal do not. After a successful managed profile change, the user can restart immediately with a one-time Desktop action or choose to restart later. The market is a shell around existing DSH capabilities; it does not invent a second plugin format, package manager, profile store, or privileged installer.

## Catalog sources

The market remains open to ongoing cooperation with a wide range of plugin data sources. People may save several sources, but browse exactly one selected source at a time. They may switch the selection or add a source that implements the published catalog contract. Switching source starts a fresh browsing session: the visible list, search, category selection, and pagination are reset. Every source is isolated behind an adapter, and the market UI sees only the same validated, normalized data model.

Anyone can provide, integrate, and use a plugin data source. A conforming source only needs to publish a [`catalog-source` manifest](docs/schemas/catalog-source.schema.json) and return data matching the [`catalog-provider-page` schema](docs/schemas/catalog-provider-page.schema.json) from its `/v1/plugins` endpoint, with no custom Market code. An existing API can keep its own format and contact us to join as a cooperating source through a reviewed adapter shipped with Market. A source may provide `media.icon`; Desktop validates and proxies it before display. Sources without an icon remain valid and receive a local fallback.

Before presenting a selected source, the Host builds one complete, validated local index. A standard source is scanned through its declared cursor and page limits; the reviewed 1024Store adapter reads the published registry page once, indexes that homepage slice, and normalizes it in Schema-bounded chunks. A later search may send the provider `q` parameter. The reviewed dshfind adapter walks its REST pages with one `data_version` fixed across the complete scan. Search, multi-category OR filtering, category choices, and pagination then run against that complete local index without refetching the provider for each interaction. Every visible page contains at most 50 items, and the category choices cover all categories in the index rather than only pages already shown. **Installable** is a fail-closed structural subset of the same index and does not change with local installed, receipt, or enabled/disabled state; authoritative npm and local-operation verification begin only when the user previews one candidate.

The Host reuses a completed index until its cache expires (currently five minutes by default). When optional index metadata is returned, `scannedAt` identifies the completed scan, `expiresAt` its cache deadline, optional `providerRevision` the source revision observed consistently across the scan, and `cacheStatus` whether the response was freshly scanned or reused. An explicit refresh replaces the index and bypasses the underlying catalog-response cache; it is not merely a repaint of the current 50 items.

[DSH 1024Store](https://github.com/imsai-sh/awesome-deepseek-harness-plugins) is one of the catalog providers currently cooperating with this project. The market ships a reviewed local adapter for its public API, but the cooperation does not make it enabled by default, preferred in sorting, a fallback when no source is selected, or an endorsement of its listings. That project independently maintains its discovery, validation, website, API, and the separately published `dsh-1024store` plugin. DSH Community Market is not a fork, repackaging, or official client of that plugin.

[dshfind](https://dshfind.com) is another optional cooperating catalog source. Its reviewed adapter reads the public REST catalog only after the user adds and selects it. The adapter fixes the first page's `data_version` for every later page, then serves search, categories, and pagination from the completed local index. dshfind's published anonymous quota means the first complete synchronization may be deliberately throttled and take longer than an ordinary page load. It is not selected by default, preferred, recommended, or used as a fallback.

**Company Store** (`company-store`) is an optional partner built-in that shares the 1024Store-style wire shape through a reviewed adapter. It is not selected by default, is never used as a fallback when official `dsh-1024store` fails, and surfaces the product disclaimer `公司目录，收录≠安全审核` when selected. Its placeholder public apex is `https://plugins.company.example`.

dshfind may supply a provider-reviewed npm method containing an exact stable version and `repository_backlink` evidence. The adapter emits `package` and `latestVersion` only when exactly one method is `npm`, `verified`, `repository_backlink`, does not require build allowance, and agrees with a supplied `install.pkg_name`; all other entries remain browse-only. It neither displays nor executes `install.cmd` and never infers identity from command text. A resulting **Installable** card is still only a structural candidate: the Host independently revalidates npm, repository, integrity, runtime, lifecycle, bundle, and profile facts during preview and execution. dshfind scores, grades, featured/official labels, risk labels, and installation probes remain provider claims; none is an Anywhere Labs security review or endorsement.

All catalog data is remote and untrusted. A listing means only that a provider supplied metadata; it does **not** mean that Anywhere Labs reviewed, recommends, or guarantees the plugin.

## Safety promise

- Background browsing never installs a package or executes repository code.
- Installation starts only after an explicit user action and confirmation.
- **Installable** is a Host-produced, fail-closed structural candidate set from the selected catalog, not a renderer guess or proof that npm was checked. A candidate needs reviewed provider verification with `repository_backlink`, an exact stable npm target, and a canonical repository, and must not be product-blocked. Installation, receipt, uninstall history, and enabled/disabled state never grant or remove catalog membership. Preview performs the first authoritative official-registry and local-action check for that one package; execution repeats mutable checks.
- The managed installer accepts exact stable npm versions only. It does not install GitHub URLs, mutable ranges or tags, deprecated packages, packages whose target manifest defines `preinstall`, `install`, `postinstall`, or `prepare`, or packages incompatible with the bundled DSH rc.8 or Node.js runtime.
- Provider-supplied command strings, install snippets, and repository install instructions are discarded, never displayed as a Host manual hint, and never executed. A separate manual hint, when available, is an exact npm command reconstructed by the Host from normalized identity, marked as not fully verified, and displayed for the user to run at their own discretion. For a qualifying dshfind item, that normalized identity comes only from the reviewed structured npm method, never from `install.cmd`.
- The renderer submits only source/item or receipt identifiers for managed operations. The **Open AI Buddy Terminal** action submits an empty request and never receives, copies, or executes the displayed manual command.
- The confirmation shows the exact npm package and version plus the active profile. Plugin changes use the existing Desktop-managed DSH plugin service and run one operation at a time; success offers **Restart later** and **Restart now**.
- Before a Market install or a built-in-terminal `dsh plugin add`, Desktop creates a private recovery snapshot of only the active profile's `package.json`, `pnpm-lock.yaml`, and `pnpm-workspace.yaml`. It does not back up or actively roll back `node_modules`, read environment variables, or collect separate credential stores. The three allowlisted files are copied as-is and therefore must not contain credentials.
- A successful protected install remains pending until the next Desktop generation starts the Host successfully and receives a healthy Renderer report within the 30-second deadline. Another protected plugin add is refused in the meantime. If startup fails, Desktop first saves local diagnostic evidence, restores only a recognized before/after configuration image, and relaunches at most once. Unknown file drift is not overwritten and requires manual repair.
- Uninstall is available only when a valid Market receipt still matches a direct bundle in the active profile. Mutable direct bundles can have their Desktop loading choice disabled or enabled again; this neither changes package ownership nor removes or sandboxes the code.
- The first release will not include accounts, telemetry, silent installs, automatic plugin updates, or a catalog backend.

These checks establish package identity and a narrow compatibility boundary; they do **not** review the plugin or its dependency tree for malicious or unsafe behavior. Installed plugins run as local code with the user's permissions. Read [Install and uninstall](docs/install-and-uninstall.md) and [Security](SECURITY.md) before testing or reviewing package operations.

## Documentation

- [Market shell design](docs/market-shell.md): product boundary, architecture, profiles, failure behavior, and delivery phases.
- [Install and uninstall](docs/install-and-uninstall.md): the four views, user workflow, Host verification, receipts, supported targets, and developer integration boundary.
- [Catalog provider contract](docs/catalog-provider-contract.md): source manifests, query parameters, wire and normalized JSON, selected-source behavior, and the implementation handoff.
- [Catalog adapter guide](docs/catalog-adapter-guide.md): the direct standard-source path, the reviewed adapter path for an existing API, and a mapping template.
- [Security](SECURITY.md): trust model, reporting, and non-negotiable installation rules.
- [Desktop plugin services](../dsh-plugin-desktop/docs/plugin-services.md): the `desktopProfiles` and `desktopPnpm` contracts used by Market package operations.
- [DSH plugin development](../docs/plugin-development.en.md): the shared plugin model used by ordinary DSH and Desktop.

## Delivery plan

- **Phase 0 — complete:** package ownership, documentation, trust boundary, and headless checks.
- **Phase 1 — complete and built in:** source selection, user-added conforming sources, one-source-at-a-time browsing, search, plugin details, and loading/empty/error states.
- **Phase 2 — complete and built in:** exact stable npm installation into the active profile, configuration-level install recovery, and receipt-backed uninstall through the managed Desktop service.
- **Later:** updates and broader compatibility evidence.

Catalog collection, submission review, accounts, rankings, and hosting remain the responsibility of catalog providers rather than this package.

## License and attribution

Package code and documentation are licensed under the [MIT License](LICENSE). No DSH 1024Store or dshfind catalog snapshot, provider command, or artwork is bundled in this package. DSH 1024Store's public catalog metadata is published under CC0-1.0; its source and provenance remain documented by the [upstream catalog project](https://github.com/imsai-sh/awesome-deepseek-harness-plugins). dshfind remains an independent service whose public metadata is read at runtime under its own published API contract.
