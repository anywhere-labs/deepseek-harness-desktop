<h1 align="center">DSH Desktop</h1>

<p align="center">
  <strong>An open-source desktop client for Windows, macOS, and Linux, built on DeepSeek Harness.</strong><br>
  One-click download, ready to use out of the box.<br>
  Everything is a plugin — the desktop itself is a plugin.
</p>

<p align="center"><sub>An independent community project, not affiliated with, authorized by, or endorsed by DeepSeek.<br>No DeepSeek employee or official upstream DeepSeek Harness team member currently participates in this repository; upstream contributors shown by GitHub are inherited from synchronized fork history.<br><a href="README.md">中文</a> · English</sub></p>

<p align="center">
  <img src="assets/desktop-hero-en.png" alt="DSH Desktop, an open-source desktop client built on DeepSeek Harness" width="100%">
</p>

<p align="center">
  <a href="https://github.com/anywhere-labs/deepseek-harness-desktop/releases/latest"><img src="https://img.shields.io/github/v/release/anywhere-labs/deepseek-harness-desktop?style=flat&amp;label=release&amp;color=4D6BFE" alt="Latest release"></a>
  <a href="https://github.com/anywhere-labs/deepseek-harness-desktop/releases"><img src="https://img.shields.io/github/downloads/anywhere-labs/deepseek-harness-desktop/total?style=flat&amp;label=downloads&amp;color=4D6BFE" alt="Total downloads"></a>
  <a href="https://github.com/anywhere-labs/deepseek-harness-desktop"><img src="https://img.shields.io/github/stars/anywhere-labs/deepseek-harness-desktop?style=flat&amp;label=%E2%98%85&amp;color=08C" alt="GitHub stars"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2EA44F?style=flat" alt="MIT License"></a>
  <a href="https://discord.gg/TJeGqKRNM"><img src="https://img.shields.io/badge/Discord-5865F2?style=flat&amp;logo=discord&amp;logoColor=white" alt="Join Discord"></a>
  <img src="https://img.shields.io/badge/macOS%20%7C%20Windows%20%7C%20Linux-4493F8?style=flat-square" alt="Supported platforms: macOS, Windows, and Linux">
</p>

<p align="center">
  <img src="assets/desktop-preview.png" alt="DSH Desktop preview" width="100%">
</p>

DSH Desktop integrates the local Web UI, Host service, and plugin system from [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) into a native desktop application. It runs a pinned upstream version unchanged, while DSH Desktop provides the window, tray, terminal, updates, and work profiles through the plugin mechanism provided by DeepSeek Harness.

<a id="run"></a>

## Download and install

Current release installers support Windows x64, macOS Universal, and Linux x64. No extra environment is needed — download, install, and start using it with one click.

| Platform | Download | Installation |
| --- | --- | --- |
| Windows x64 | [Download installer](https://www.dshdesktop.cn/api/downloads/windows) | Run the NSIS installer and follow its prompts |
| macOS Universal | [Download DMG](https://www.dshdesktop.cn/api/downloads/mac) | Open the DMG and drag DSH Desktop into Applications |
| Linux x64 | [Download from GitHub Releases](https://github.com/anywhere-labs/deepseek-harness-desktop/releases/latest) | Choose deb, rpm, or AppImage; the AppImage needs `chmod +x` before running it directly |

See the [user guide](docs/user-guide.en.md) and [FAQ](docs/faq.en.md) for plugin commands, platform details, and troubleshooting.

Together with every plugin author, we want to build an open, composable, and sustainable DSH plugin ecosystem where plugins grow alongside each other. Read the [DSH plugin ecosystem manifesto](docs/plugin-ecosystem.en.md).

## Documentation

Ordinary users can start with the [user guide](docs/user-guide.en.md); the developer documentation is only needed when extending or maintaining the application.

### User documentation

| Goal | Entry point |
| --- | --- |
| Install and use the application | [User guide](docs/user-guide.en.md) |
| Check platforms, prerequisites, and product boundaries | [FAQ](docs/faq.en.md) |
| Understand why the project exists | [Why DSH Desktop](docs/why-desktop.en.md) |
| See the full documentation and README map | [Documentation index](docs/README.en.md) |

### Developer and maintainer documentation

| Goal | Entry point |
| --- | --- |
| Read the plugin ecosystem manifesto | [Plugin ecosystem manifesto](docs/plugin-ecosystem.en.md) |
| Build ordinary or Desktop plugins | [Plugin development](docs/plugin-development.en.md) |
| Join the unified plugin-contract discussion | [DSH Community Fabric Draft](dsh-community-fabric/README.md) |
| See the research behind the unified plugin framework | [Framework and real-plugin research](dsh-community-fabric/docs/research/mature-plugin-frameworks.md) |
| Read the plugin market product and safety design | [DSH Community Market](dsh-community-market/README.md) |
| See what Desktop plugins can use | [Desktop plugin API](dsh-plugin-desktop/docs/plugin-services.md) |
| Understand how the desktop works | [Architecture](docs/architecture.en.md) |
| Read package-level build and release details | [`dsh-plugin-desktop/README.md`](dsh-plugin-desktop/README.md) |

## Features

<table>
  <tr>
    <td width="50%" valign="top">
      <h3>Desktop</h3>
      <p>Bring the upstream DeepSeek Harness local Web UI to a native desktop application. The app starts and manages the local Harness service, integrates the system tray and desktop window, and requires no Node.js installation or command-line setup.</p>
    </td>
    <td width="50%" valign="top">
      <h3>Mobile Remote Control <img src="https://img.shields.io/badge/COMING_SOON-F59E0B?style=flat-square" alt="Coming Soon"></h3>
      <p>Connect to Desktop from iOS and Android to start tasks, monitor Agent progress, and send follow-ups from your phone.</p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3><a href="dsh-community-market/README.md">Plugin Marketplace</a> <img src="https://img.shields.io/badge/BUILT_IN-2EA44F?style=flat-square" alt="Built in"></h3>
      <p>DSH Community Market is complete and built in, with plugin discovery, details, installation, and management. The market openly connects to a wide range of plugin data sources: anyone can provide, integrate, and use a source that follows the public schemas, while existing APIs can join as cooperating sources through a reviewed adapter.</p>
    </td>
    <td width="50%" valign="top">
      <h3>Co-build the Plugin Ecosystem</h3>
      <p>The DSH plugin ecosystem is built by the community. Upstream plugins, DSH Desktop plugins, and other community plugins follow shared conventions and can work together through the same composition mechanism. Join us — read the <a href="docs/plugin-ecosystem.en.md">DSH plugin ecosystem manifesto</a>.</p>
    </td>
  </tr>
</table>

## Plugin Ecosystem

Plugins are extensions that add capabilities to DSH — models, tools, interfaces, and workflows can all be plugins, combined like building blocks.

DSH Desktop does not modify upstream source, and it is not a fixed, hardcoded shell. A pinned upstream DeepSeek Harness version runs unchanged; the desktop shell itself — the window, tray, terminal, updates, and work profiles — integrates as a DSH plugin through the plugin mechanism provided by DeepSeek Harness. From the core agent to the desktop shell, the whole product follows the same "everything is a plugin" rule: plugins compatible with the pinned upstream version can be used, while desktop capabilities are composed, replaced, and evolved in the same way.

We want the plugin ecosystem to work like a phone app store: every plugin is built against the same set of rules, so plugins can be installed together and work together without interfering with each other.

### For developers

Unlike many other projects, this project itself is a DSH [plugin](docs/plugin-development.en.md): the desktop shell uses the same plugin composition mechanism as third-party plugins. Desktop plugin capabilities are now available. We provide Desktop services so plugin developers can integrate their plugins with desktop capabilities: for example, viewing and switching work profiles, or installing, updating, and removing plugins in the active profile. See the [Desktop plugin API](dsh-plugin-desktop/docs/plugin-services.md) for complete usage details. See [Why DSH Desktop](docs/why-desktop.en.md) and [Plugin development](docs/plugin-development.en.md) for the reasoning and the third-party boundary.

## Relationship to DeepSeek Harness

DSH Desktop is an independent community project built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) and the Cordis plugin model, intended to provide an open and composable DSH desktop experience.

This repository is independently maintained by the community. No DeepSeek employee or member of the official upstream DeepSeek Harness team currently participates in its development, maintenance, or governance. Contributors from the upstream project may appear on GitHub's Contributors page because this repository inherited and later synchronized upstream commit history when it was forked. Such attribution reflects commit provenance only and does not imply involvement in this repository or any affiliation, partnership, authorization, or endorsement.

The upstream project provides the core agent capabilities, plugin system, and Web UI. DSH Desktop primarily provides:

- Desktop application packaging
- Starting, stopping, and recovering the local service
- Desktop window and system tray integration
- macOS, Windows, and Linux installer builds and releases
- An interface designed for desktop use

If you prefer to run DeepSeek Harness from the command line or contribute to its core functionality, refer to the upstream repository first.

## Special Thanks

Special thanks to the [original DeepSeek Harness repository](https://github.com/deepseek-ai/deepseek-harness) and the DeepSeek AI team. DSH Desktop is built from a pinned upstream checkout, and its core agents, models, tools, sessions, Web UI, and plugin ecosystem come from that project.

We also thank [Cordis](https://github.com/cordiverse/cordis) for the plugin foundation that makes this composition possible. DSH Desktop would not exist without these open-source projects.

We are also grateful to the [Koishi.js](https://koishi.chat/) project and community for their long-standing work on plugin practices, tooling, and shared knowledge, and to everyone who contributes discussions, testing, feedback, and plugins.

Also, and you.

<a id="run-from-source"></a>

## Development

Desktop source lives in `dsh-plugin-desktop/`. The outer repository uses Yarn, while the pinned `deepseek-harness/` submodule keeps its own pnpm workspace. From the repository root:

```sh
git submodule update --init --recursive
corepack yarn install --immutable
corepack yarn dev
```

Use `corepack yarn check` for the headless gate. The [architecture](docs/architecture.en.md) and package [`README`](dsh-plugin-desktop/README.md) describe the full build, test, and release boundaries. See [CONTRIBUTING.en.md](CONTRIBUTING.en.md) for how to contribute.

## Community

Choose whichever platform you prefer to discuss usage, plugin development, and project updates.

<table>
  <thead>
    <tr>
      <th align="center">WeCom</th>
      <th align="center">QQ Group</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center"><img src="assets/community-wechat-group.png" alt="DSH Desktop WeCom QR code" title="Scan to add us on WeCom" width="180" height="180"></td>
      <td align="center"><img src="assets/community-qq-group.jpg" alt="DSH Desktop QQ group QR code" width="180" height="180"></td>
    </tr>
  </tbody>
</table>

Discord: [Join the DSH Desktop community](https://discord.gg/TJeGqKRNM)

If you would like to join our technical team, contact us at [t4wefan@qq.com](mailto:t4wefan@qq.com).

## Related Links

Ecosystem projects and developer tools around DeepSeek Harness.

| Project | About | Link |
| --- | --- | --- |
| dshfind | The learning & sharing community for DeepSeek Harness (DSH). | [GitHub](https://github.com/hikariming/dshfind) |
| DSH 1024Store | A community plugin directory for the DeepSeek Harness (DSH) ecosystem (4,120 plugins), open-sourcing an online marketplace, a collection pipeline, and a public query API — fork it to deploy your own marketplace. | [GitHub](https://github.com/imsai-sh/awesome-deepseek-harness-plugins) |
| Awesome DSH Plugin | Curated list of DeepSeek Harness (DSH) plugins. | [GitHub](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) |
| dsh-market | Visual plugin market for DeepSeek Harness, with browsing, search, and one-click installation. | [GitHub](https://github.com/dsh-market/dsh-market) |
| ModLens | Adds OCR, layout, and semantic vision capabilities to DeepSeek Harness and text-only coding agents. | [GitHub](https://github.com/liustack/modlens) · [Website](https://liustack.dev) |
| DeepSeek Harness Orange Book | Community field manual for DeepSeek Harness. | [GitHub](https://github.com/alchaincyf/deepseek-harness-orange-book) |
| dsh-web-ui | DeepSeek Harness Web UI plugins and themes. | [GitHub](https://github.com/zhu1090093659/dsh-web-ui) · [Gallery](https://gallery.dsh-market.com) |
| dsh-TUI | Full-screen interactive terminal interface for DeepSeek Harness. | [GitHub](https://github.com/ccch1mneyyy/dsh-TUI) |
| dsh-tianshu-tui | Minimalist interactive terminal UI plugin for the DSH web client with a self-developed ANSI rendering core for silky-smooth output; adds TDD, evidence gates, and vision/image module workflows on top of the official UI. | [GitHub](https://github.com/huiliyi37/dsh-tianshu-tui) |
| dsh-context | DSH context insight panel: Context dashboard + `/context` command + Context browser for one-stop context lifecycle management — category composition, content details, evolution trends, compaction/injection events, and statistics. | [GitHub](https://github.com/bowenliang123/dsh-context) · [NPM](https://www.npmjs.com/package/dsh-context) |
| Agents-Anywhere | Remote-control your desktop coding agent from your phone. | [GitHub](https://github.com/anywhere-labs/Agents-Anywhere) |
| deepseek-harness-remote | Remote control and multi-device collaboration plugin for DeepSeek Harness based on P2P and APIProxy. | [GitHub](https://github.com/liguobao/deepseek-harness-remote) |
| DSH-better-sidebar | Sidebar workbench for DeepSeek Harness with files, terminal, Git, and subagents. | [GitHub](https://github.com/omdsh-dev/DSH-better-sidebar) |
| Awesome DeepSeek Harness | Curated list of DeepSeek Harness plugins, tools, and infrastructure. | [GitHub](https://github.com/0xsline/awesome-deepseek-harness) · [Website](https://deepseekdocs.com/) |
| MkSaaS · TanStarter | Commercial SaaS starter templates for indie developers. MkSaaS is built on Next.js; TanStarter on TanStack Start and Cloudflare, with AI, auth, payments, and admin baked in. | [MkSaaS](https://mksaas.com) · [TanStarter](https://tanstarter.dev) |

<sub>To list your project, join the WeChat group and message @王博升Benson, or contact t4wefan@qq.com, or <a href="https://github.com/anywhere-labs/deepseek-harness-desktop/issues">open an issue</a>.</sub>

## License

This project is licensed under the [MIT License](LICENSE).

> “DeepSeek Harness” is a registered trademark of DeepSeek AI. The name is used here solely to accurately describe compatibility, technical origin, and this project's relationship to upstream software.

> DSH Desktop is an independent community project and is not affiliated with, sponsored by, authorized by, or endorsed by DeepSeek.

## Star History

<a href="https://www.star-history.com/?repos=anywhere-labs%2Fdeepseek-harness-desktop&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=anywhere-labs/deepseek-harness-desktop&type=date&theme=dark&legend=top-left&sealed_token=BRTkOyC4czCEkIyFb5-QxrsC-kaDotBJ8tsjxrWs-UGfmBqfRCXSwieZPlVTCYOjJVEZ29uLvmBjAPREB524J5dPN1jk-UA7ajFdLdrbjumJqoOBeGWmig" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=anywhere-labs/deepseek-harness-desktop&type=date&legend=top-left&sealed_token=BRTkOyC4czCEkIyFb5-QxrsC-kaDotBJ8tsjxrWs-UGfmBqfRCXSwieZPlVTCYOjJVEZ29uLvmBjAPREB524J5dPN1jk-UA7ajFdLdrbjumJqoOBeGWmig" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=anywhere-labs/deepseek-harness-desktop&type=date&legend=top-left&sealed_token=BRTkOyC4czCEkIyFb5-QxrsC-kaDotBJ8tsjxrWs-UGfmBqfRCXSwieZPlVTCYOjJVEZ29uLvmBjAPREB524J5dPN1jk-UA7ajFdLdrbjumJqoOBeGWmig" />
 </picture>
</a>
