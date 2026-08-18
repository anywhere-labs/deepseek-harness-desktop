<h1 align="center">DeepSeek Harness Desktop (DSH Desktop)</h1>

<p align="center">
  <strong>An open-source DeepSeek Harness desktop client for Windows and macOS.</strong><br>
  One-click download, ready to use out of the box.<br>
  Everything is a plugin — the desktop itself is a plugin.
</p>

<p align="center"><sub>Community maintained and not an official DeepSeek product. <a href="README.md">中文</a> · English</sub></p>

<p align="center">
  <img src="assets/desktop-hero-en.jpg" alt="DeepSeek Harness Desktop" width="100%">
</p>

<p align="center">
  <a href="https://github.com/anywhere-labs/deepseek-harness-desktop/releases/latest"><img src="https://img.shields.io/github/v/release/anywhere-labs/deepseek-harness-desktop?style=flat&amp;label=release&amp;color=4D6BFE" alt="Latest release"></a>
  <a href="https://github.com/anywhere-labs/deepseek-harness-desktop/releases"><img src="https://img.shields.io/github/downloads/anywhere-labs/deepseek-harness-desktop/total?style=flat&amp;label=downloads&amp;color=4D6BFE" alt="Total downloads"></a>
  <a href="https://github.com/anywhere-labs/deepseek-harness-desktop"><img src="https://img.shields.io/github/stars/anywhere-labs/deepseek-harness-desktop?style=flat&amp;label=%E2%98%85&amp;color=08C" alt="GitHub stars"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2EA44F?style=flat" alt="MIT License"></a>
  <a href="https://discord.gg/TJeGqKRNM"><img src="https://img.shields.io/badge/Discord-5865F2?style=flat&amp;logo=discord&amp;logoColor=white" alt="Join Discord"></a>
  <img src="https://img.shields.io/badge/macOS%20%7C%20Windows-4493F8?style=flat-square" alt="Supported platforms: macOS and Windows">
</p>

<p align="center">
  <img src="assets/desktop-preview.png" alt="DeepSeek Harness Desktop preview" width="100%">
</p>

DSH Desktop packages the local Web UI, Host service, and plugin system from [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) into a native desktop application. Official Harness runs unchanged at a pinned version; Desktop provides the window, tray, terminal, updates, and work profiles through the official plugin composition.

<a id="run"></a>

## Download and install

Current release installers support Windows x64 and Apple Silicon macOS. Ordinary users do not need to install Node.js, pnpm, or DSH separately.

| Platform | Download | Installation |
| --- | --- | --- |
| Windows x64 | [Download installer](https://www.dshdesktop.cn/api/downloads/windows) | Run the NSIS installer and follow its prompts |
| macOS Apple Silicon | [Download DMG](https://www.dshdesktop.cn/api/downloads/mac) | Open the DMG and drag DSH Desktop into Applications |

Installers and SHA-256 digests are also available from [GitHub Releases](https://github.com/anywhere-labs/deepseek-harness-desktop/releases/latest). The first launch creates the default `desktop` profile and starts the official DSH Web interface locally. See the [user guide](docs/user-guide.en.md) and [FAQ](docs/faq.en.md) for plugin commands, platform details, and troubleshooting.

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
      <p>Bring the official DeepSeek Harness local Web UI to a native desktop application. The app starts and manages the local Harness service, integrates the system tray and desktop window, and requires no Node.js installation or command-line setup.</p>
    </td>
    <td width="50%" valign="top">
      <h3>Mobile Remote Control <img src="https://img.shields.io/badge/COMING_SOON-F59E0B?style=flat-square" alt="Coming Soon"></h3>
      <p>Connect to Desktop from iOS and Android to start tasks, monitor Agent progress, and send follow-ups from your phone.</p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3><a href="dsh-community-market/README.md">Plugin Marketplace</a> <img src="https://img.shields.io/badge/IN_DESIGN-F59E0B?style=flat-square" alt="In design"></h3>
      <p>We are using DSH Community Market to design plugin discovery, details, and confirmed installation. It currently contains product and safety documentation, not a usable market page.</p>
    </td>
    <td width="50%" valign="top">
      <h3>Co-build the Plugin Ecosystem</h3>
      <p>The DSH plugin ecosystem is built by the community. Official, desktop, and third-party plugins follow the same conventions, so they can be installed together and work together without interfering with each other. Join us — read the <a href="docs/plugin-ecosystem.en.md">DSH plugin ecosystem manifesto</a>.</p>
    </td>
  </tr>
</table>

## Plugin Ecosystem

Plugins are extensions that add capabilities to DSH — models, tools, interfaces, and workflows can all be plugins, combined like building blocks.

DSH Desktop does not fork or modify upstream source, and it is not a fixed, hardcoded shell. Official DeepSeek Harness runs unchanged at a pinned version; the desktop shell itself — the window, tray, terminal, updates, and work profiles — is a legitimate DSH plugin, composed into the same runtime through the official plugin mechanism. From the core agent to the desktop shell, the whole product follows the same "everything is a plugin" rule: plugins from the official ecosystem work directly, and desktop capabilities are combined, replaced, and evolve the same way.

We want the plugin ecosystem to work like a phone app store: every plugin is built against the same set of rules, so plugins can be installed together and work together without interfering with each other.

### For developers

Unlike many other projects, this project itself is a DSH [plugin](docs/plugin-development.en.md): the desktop shell composes through the same official path as third-party plugins. Desktop plugin capabilities are now available. We provide Desktop services so plugin developers can integrate their plugins with desktop capabilities: for example, viewing and switching work profiles, or installing, updating, and removing plugins in the active profile. See the [Desktop plugin API](dsh-plugin-desktop/docs/plugin-services.md) for complete usage details. See [Why DSH Desktop](docs/why-desktop.en.md) and [Plugin development](docs/plugin-development.en.md) for the reasoning and the third-party boundary.

## Relationship to the Official Project

This project is built on [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness).

This project is an implementation built on DeepSeek Harness and the Cordis plugin model, intended to provide the foundation for the DSH desktop experience.

The official project provides the core agent capabilities, plugin system, and Web UI. This project primarily provides:

- Desktop application packaging
- Starting, stopping, and recovering the local service
- Desktop window and system tray integration
- macOS and Windows installer builds and releases
- An interface designed for desktop use

If you prefer to run Harness from the command line or contribute to its core functionality, refer to the official repository first.

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
      <th align="center">WeChat Group</th>
      <th align="center">QQ Group</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center"><img src="assets/community-wechat-group.png" alt="DeepSeek Harness Desktop WeChat group QR code" width="180" height="180"></td>
      <td align="center"><img src="assets/community-qq-group.jpg" alt="DeepSeek Harness Desktop QQ group QR code" width="180" height="180"></td>
    </tr>
  </tbody>
</table>

Discord: [Join the DeepSeek Harness Desktop community](https://discord.gg/TJeGqKRNM)

If you would like to join our technical team, contact us at [t4wefan@qq.com](mailto:t4wefan@qq.com).

## Related Links

Ecosystem projects and developer tools around DeepSeek Harness.

| Project | About | Link |
| --- | --- | --- |
| dshfind | The learning & sharing community for DeepSeek Harness (DSH). | [GitHub](https://github.com/hikariming/dshfind) |
| DSH 1024Store | A community plugin directory for the DeepSeek Harness (DSH) ecosystem (4,120 plugins), open-sourcing an online marketplace, a collection pipeline, and a public query API — fork it to deploy your own marketplace. | [GitHub](https://github.com/imsai-sh/awesome-deepseek-harness-plugins) |
| ModLens | Adds OCR, layout, and semantic vision capabilities to DeepSeek Harness and text-only coding agents. | [GitHub](https://github.com/liustack/modlens) · [Website](https://liustack.dev) |
| DeepSeek Harness Orange Book | Community field manual for DeepSeek Harness. | [GitHub](https://github.com/alchaincyf/deepseek-harness-orange-book) |
| dsh-web-ui | DeepSeek Harness Web UI plugins and themes. | [GitHub](https://github.com/zhu1090093659/dsh-web-ui) · [Gallery](https://gallery.dsh-market.com) |
| dsh-TUI | Full-screen interactive terminal interface for DeepSeek Harness. | [GitHub](https://github.com/ccch1mneyyy/dsh-TUI) |
| dsh-tianshu-tui | Minimalist interactive terminal UI plugin for the DSH web client with a self-developed ANSI rendering core for silky-smooth output; adds TDD, evidence gates, and vision/image module workflows on top of the official UI. | [GitHub](https://github.com/huiliyi37/dsh-tianshu-tui) |
| Agents-Anywhere | Remote-control your desktop coding agent from your phone. | [GitHub](https://github.com/anywhere-labs/Agents-Anywhere) |
| DSH-better-sidebar | Sidebar workbench for DeepSeek Harness with files, terminal, Git, and subagents. | [GitHub](https://github.com/omdsh-dev/DSH-better-sidebar) |
| Awesome DeepSeek Harness | Curated list of DeepSeek Harness plugins, tools, and infrastructure. | [GitHub](https://github.com/0xsline/awesome-deepseek-harness) · [Website](https://deepseekdocs.com/) |
| MkSaaS · TanStarter (Sponsor) | Commercial SaaS starter templates for indie developers. MkSaaS is built on Next.js; TanStarter on TanStack Start and Cloudflare, with AI, auth, payments, and admin baked in. | [MkSaaS](https://mksaas.com) · [TanStarter](https://tanstarter.dev) |

<sub>To list your project, join the WeChat group and message @王博升Benson, or contact t4wefan@qq.com, or <a href="https://github.com/anywhere-labs/deepseek-harness-desktop/issues">open an issue</a>.</sub>

## License

This project is licensed under the [MIT License](LICENSE).

> This is a community desktop edition built on DeepSeek Harness. It is not an official DeepSeek product.

> DeepSeek is a trademark of DeepSeek AI. DSH Desktop is an independent community project, not affiliated with or endorsed by DeepSeek.

## Star History

<a href="https://www.star-history.com/?repos=anywhere-labs%2Fdeepseek-harness-desktop&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=anywhere-labs/deepseek-harness-desktop&type=date&theme=dark&legend=top-left&sealed_token=BRTkOyC4czCEkIyFb5-QxrsC-kaDotBJ8tsjxrWs-UGfmBqfRCXSwieZPlVTCYOjJVEZ29uLvmBjAPREB524J5dPN1jk-UA7ajFdLdrbjumJqoOBeGWmig" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=anywhere-labs/deepseek-harness-desktop&type=date&legend=top-left&sealed_token=BRTkOyC4czCEkIyFb5-QxrsC-kaDotBJ8tsjxrWs-UGfmBqfRCXSwieZPlVTCYOjJVEZ29uLvmBjAPREB524J5dPN1jk-UA7ajFdLdrbjumJqoOBeGWmig" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=anywhere-labs/deepseek-harness-desktop&type=date&legend=top-left&sealed_token=BRTkOyC4czCEkIyFb5-QxrsC-kaDotBJ8tsjxrWs-UGfmBqfRCXSwieZPlVTCYOjJVEZ29uLvmBjAPREB524J5dPN1jk-UA7ajFdLdrbjumJqoOBeGWmig" />
 </picture>
</a>
