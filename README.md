<h1 align="center">DSH Desktop</h1>

<p align="center">
  <strong>基于 DeepSeek Harness 构建的 Windows 和 macOS 开源桌面客户端。</strong><br>
  一键下载，开箱即用。<br>
  万物皆「插件」，桌面本身也是「插件」。
</p>

<p align="center"><sub>独立的社区开源项目，与深度求索不存在隶属、合作、授权或背书关系。<br>本仓库目前无深度求索员工或 DeepSeek Harness 上游官方团队成员参与；GitHub Contributors 中显示的上游贡献者来自 fork 继承和同步的提交历史。<br>中文 · <a href="README.en.md">English</a></sub></p>

<p align="center">
  <img src="assets/desktop-hero-zh.png" alt="DSH Desktop：基于 DeepSeek Harness 构建的开源桌面客户端" width="100%">
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
  <img src="assets/desktop-preview.png" alt="DSH Desktop 界面预览" width="100%">
</p>

DSH Desktop 将 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的本地 Web UI、Host 服务和插件系统集成到原生桌面应用中。项目固定并原样运行特定上游版本；DSH Desktop 提供窗口、托盘、终端、更新和工作配置，并通过 DeepSeek Harness 提供的插件机制与上游能力组合。

<a id="run"></a>

## 下载与安装

当前正式安装包支持 Windows x64 和 macOS Universal。无需额外环境，下载安装，一键使用。

| 平台 | 下载 | 安装方式 |
| --- | --- | --- |
| Windows x64 | [下载安装程序](https://www.dshdesktop.cn/api/downloads/windows) | 运行 NSIS 安装程序并按提示完成安装 |
| macOS Universal | [下载 DMG](https://www.dshdesktop.cn/api/downloads/mac) | 打开 DMG，将 DSH Desktop 拖入 Applications |

详细步骤、插件命令和故障排查见[用户指南](docs/user-guide.md)与[常见问题](docs/faq.md)。

我们希望和所有插件作者一起，构建一个开放、可组合、可持续的 DSH 插件生态，让每个插件都能与其他插件共同进步：[DSH 插件生态倡议书](docs/plugin-ecosystem.md)。

## 文档

普通用户从[用户指南](docs/user-guide.md)开始即可；开发者文档只在需要扩展或维护时才需要阅读。

### 用户文档

| 目标 | 入口 |
| --- | --- |
| 安装和日常使用 | [用户指南](docs/user-guide.md) |
| 在 Windows 上把完整 Host 运行在 WSL 2 | [托管式 WSL Host](dsh-plugin-desktop/docs/wsl-host.zh.md) |
| 快速确认平台、环境和使用边界 | [常见问题](docs/faq.md) |
| 了解项目为什么存在 | [为什么做 DSH Desktop](docs/why-desktop.md) |
| 查看全部文档与 README 分工 | [文档索引](docs/README.md) |

### 开发者与维护者文档

| 目标 | 入口 |
| --- | --- |
| 阅读插件生态倡议书 | [插件生态倡议书](docs/plugin-ecosystem.md) |
| 编写普通或 Desktop 插件 | [插件开发](docs/plugin-development.md) |
| 参与统一插件 contract 讨论 | [DSH Community Fabric Draft](dsh-community-fabric/README.zh.md) |
| 了解统一插件框架为什么这样设计 | [成熟框架与真实插件调研](dsh-community-fabric/docs/research/mature-plugin-frameworks.zh.md) |
| 查看插件市场的产品与安全设计 | [DSH Community Market](dsh-community-market/README.zh.md) |
| 了解桌面插件可以使用的能力 | [桌面插件接口说明](dsh-plugin-desktop/docs/plugin-services.zh.md) |
| 了解桌面应用如何工作 | [架构说明](docs/architecture.md) |
| 查阅包级构建与发布细节 | [`dsh-plugin-desktop/README.md`](dsh-plugin-desktop/README.md) |

## 主要功能

<table>
  <tr>
    <td width="50%" valign="top">
      <h3>Desktop</h3>
      <p>把上游 DeepSeek Harness 的本地 Web UI 带到原生桌面。应用默认自动管理无需额外 Node.js 的本机 Host；Windows 用户也可把完整 Host、Profile、插件和终端放进指定 WSL 2 发行版，同时保留原生窗口与系统集成。</p>
    </td>
    <td width="50%" valign="top">
      <h3>手机远程控制 <img src="https://img.shields.io/badge/%E5%8D%B3%E5%B0%86%E6%8E%A8%E5%87%BA-F59E0B?style=flat-square" alt="即将推出"></h3>
      <p>通过 iOS 和 Android 远程连接 Desktop，在手机上发起任务、查看 Agent 进度，并在需要时继续跟进。</p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3><a href="dsh-community-market/README.zh.md">插件市场</a> <img src="https://img.shields.io/badge/%E5%B7%B2%E5%86%85%E7%BD%AE-2EA44F?style=flat-square" alt="已内置"></h3>
      <p>DSH Community Market 已完成并内置，提供插件发现、详情、安装与管理。市场以开放方式连接各种插件数据源：任何人都可以提供、接入和使用符合公开 Schema 的来源，已有 API 也可以通过受审 adapter 加入合作数据源。</p>
    </td>
    <td width="50%" valign="top">
      <h3>共建插件生态</h3>
      <p>DSH 的插件生态由社区共同建设。上游插件、DSH Desktop 插件和其他社区插件遵循统一的约定，可以通过相同的组合机制共同工作；欢迎加入共建，详见 <a href="docs/plugin-ecosystem.md">DSH 插件生态倡议书</a>。</p>
    </td>
  </tr>
</table>

## 插件生态

插件是给 DSH 添加能力的扩展包——模型、工具、界面、工作流都可以做成插件，像搭积木一样自由组合。

DSH Desktop 没有修改上游源码，也不是一个固定写死的外壳。固定版本的上游 DeepSeek Harness 原样运行；桌面壳本身——窗口、托盘、终端、更新、工作配置——作为 DSH 插件接入，并通过 DeepSeek Harness 提供的插件机制与上游能力组合进同一个运行时。从核心 agent 到桌面外壳，整个产品遵守同一条"一切皆插件"的规则：与所固定上游版本兼容的插件可以使用，桌面能力也按插件的方式组合、替换和演进。

我们希望插件生态像手机应用一样：每个插件按同一套规则开发，装在一起也能一起工作、互不干扰。

### 给开发者

与许多其他项目不同，这个项目本身就是一个 DSH [插件](docs/plugin-development.md)：桌面壳与第三方插件使用相同的插件组合机制。Desktop 的插件能力已经可以使用。我们提供了 Desktop 服务，让插件开发者能够把插件与桌面能力集成起来：例如查看和切换工作配置，或在当前配置中安装、更新和移除插件。完整用法见[桌面插件接口说明](dsh-plugin-desktop/docs/plugin-services.zh.md)。为什么选择这样的边界、哪些能力不会暴露给第三方插件，见[为什么做 DSH Desktop](docs/why-desktop.md)和[插件开发指南](docs/plugin-development.md)。

## 与 DeepSeek Harness 的关系

DSH Desktop 是基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 和 Cordis 插件思想构建的独立社区项目，旨在提供开放、可组合的 DSH 桌面体验。

本仓库由社区独立维护，目前不存在深度求索员工或 DeepSeek Harness 上游官方团队成员参与本项目开发、维护或治理的情形。GitHub Contributors 页面中可能出现的上游贡献者，来自本仓库 fork 时继承及后续同步的上游提交历史；该署名仅反映提交来源，不代表相关人员参与本仓库，也不构成任何隶属、合作、授权或背书关系。

上游项目提供核心的智能体能力、插件系统和 Web UI；DSH Desktop 主要负责：

- 桌面应用封装
- 本地服务的启动、停止与恢复
- 桌面窗口和系统托盘集成
- macOS、Windows 安装包构建与发布
- 更适合桌面使用的界面体验

如果你希望通过命令行运行 DeepSeek Harness，或者参与其核心功能开发，请优先查看上游仓库。

## 特别感谢

特别感谢 [DeepSeek Harness 原始仓库](https://github.com/deepseek-ai/deepseek-harness) 和 DeepSeek AI 团队。DSH Desktop 基于固定版本的上游源码构建，核心的智能体、模型、工具、会话、Web UI 和插件生态都来自这个项目。

同时感谢 [Cordis](https://github.com/cordiverse/cordis) 项目提供的插件化基础。没有这些开源项目，就不会有 DSH Desktop。

也感谢 [Koishi.js](https://koishi.chat/) 项目和社区长期积累的插件化实践、工具与经验，以及所有参与讨论、测试、反馈和插件开发的社区成员。

以及每一个使用、支持和参与共建的你。

<a id="run-from-source"></a>

## 开发

桌面端代码位于 `dsh-plugin-desktop/`，外层仓库使用 Yarn，固定的 `deepseek-harness/` 子模块继续使用自己的 pnpm workspace。从仓库根目录执行：

```sh
git submodule update --init --recursive
corepack yarn install --immutable
corepack yarn dev
```

headless 检查使用 `corepack yarn check`；完整的构建、测试和发布边界见[架构说明](docs/architecture.md)和包级 [`README`](dsh-plugin-desktop/README.md)。如何参与贡献见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 社区交流

可选择常用的平台参与讨论，交流使用问题、插件开发和项目进展。

<table>
  <thead>
    <tr>
      <th align="center">企业微信</th>
      <th align="center">QQ群</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center"><img src="assets/community-wechat-group.png" alt="DSH Desktop 企业微信二维码" title="扫码添加企业微信" width="180" height="180"></td>
      <td align="center"><img src="assets/community-qq-group.jpg" alt="DSH Desktop QQ群二维码" width="180" height="180"></td>
    </tr>
  </tbody>
</table>

Discord：[加入 DSH Desktop 社区](https://discord.gg/TJeGqKRNM)

如果您希望加入我们的技术团队，也欢迎通过 [t4wefan@qq.com](mailto:t4wefan@qq.com) 联系我们。

## 友情链接

这里收录 DeepSeek Harness 生态项目及开发者工具。

| 项目 | 简介 | 链接 |
| --- | --- | --- |
| dshfind | DeepSeek Harness（DSH）学习与分享社区。 | [GitHub](https://github.com/hikariming/dshfind) |
| DSH 1024Store | 面向 DeepSeek Harness（dsh）生态的社区插件目录（收录 4120 个插件），并开源了在线插件市场、目录流水线与公开查询 API，可 fork 自建市场。 | [GitHub](https://github.com/imsai-sh/awesome-deepseek-harness-plugins) |
| Awesome DSH Plugin | DeepSeek Harness（DSH）插件精选列表。 | [GitHub](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) |
| dsh-market | DeepSeek Harness 内的可视化插件市场，支持浏览、搜索与一键安装插件。 | [GitHub](https://github.com/dsh-market/dsh-market) |
| ModLens | 为 DeepSeek Harness 和纯文本 Coding Agent 提供 OCR、版面与语义识别能力。 | [GitHub](https://github.com/liustack/modlens) · [官网](https://liustack.dev) |
| DeepSeek Harness 橙皮书 | DeepSeek Harness 社区实测手册。 | [GitHub](https://github.com/alchaincyf/deepseek-harness-orange-book) |
| dsh-web-ui | DeepSeek Harness Web UI 插件与皮肤合集。 | [GitHub](https://github.com/zhu1090093659/dsh-web-ui) · [展示站](https://gallery.dsh-market.com) |
| dsh-TUI | DeepSeek Harness 全屏交互式终端界面。 | [GitHub](https://github.com/ccch1mneyyy/dsh-TUI) |
| dsh-tianshu-tui | DSH Web 端交互式终端极简风格 UI 插件，自研 ANSI 渲染核心、极致丝滑流畅；在官方基础上增加了 TDD、证据门、视觉图像模块等工作流。 | [GitHub](https://github.com/huiliyi37/dsh-tianshu-tui) |
| dsh-context | DSH 上下文洞察面板：Context 仪表盘 + /context 命令 + Context 浏览器，一站式查看 Context 的分类组成、内容详情、演进趋势、压缩/注入事件与统计，覆盖 Context 全生命周期管理。 | [GitHub](https://github.com/bowenliang123/dsh-context) · [NPM](https://www.npmjs.com/package/dsh-context) |
| Agents-Anywhere | 从手机远程控制电脑上的 Coding Agent。 | [GitHub](https://github.com/anywhere-labs/Agents-Anywhere) |
| deepseek-harness-remote | 基于 P2P 与 APIProxy 的 DeepSeek Harness 远程控制与多端协同插件。 | [GitHub](https://github.com/liguobao/deepseek-harness-remote) |
| DSH-better-sidebar | DeepSeek Harness 侧边栏工作台，集成文件、终端、Git 和子代理。 | [GitHub](https://github.com/omdsh-dev/DSH-better-sidebar) |
| Awesome DeepSeek Harness | DeepSeek Harness 插件、工具与基础设施精选列表。 | [GitHub](https://github.com/0xsline/awesome-deepseek-harness) · [官网](https://deepseekdocs.com/) |
| MkSaaS · TanStarter | 面向独立开发者的商业 SaaS 启动模板。MkSaaS 基于 Next.js，TanStarter 基于 TanStack Start 与 Cloudflare，内置 AI、认证、支付和后台等常用能力。 | [MkSaaS](https://mksaas.com) · [TanStarter](https://tanstarter.dev) |

<sub>如果希望收录您的项目，欢迎加入微信群并私信 @王博升Benson，或联系 t4wefan@qq.com，或<a href="https://github.com/anywhere-labs/deepseek-harness-desktop/issues">提出 issue</a>。</sub>

## License

本项目遵循 [MIT License](LICENSE)。

> “DeepSeek Harness”是深度求索公司的注册商标。本文仅为准确说明兼容性、技术来源及与上游软件的关系而使用该名称。

> 本项目完全开源免费。如果有人向您以任何形式出售此软件，请拒绝交易。

> DSH Desktop 是独立的社区项目，与深度求索不存在隶属、合作、授权或背书关系。

## Star History

<a href="https://www.star-history.com/?repos=anywhere-labs%2Fdeepseek-harness-desktop&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=anywhere-labs/deepseek-harness-desktop&type=date&theme=dark&legend=top-left&sealed_token=BRTkOyC4czCEkIyFb5-QxrsC-kaDotBJ8tsjxrWs-UGfmBqfRCXSwieZPlVTCYOjJVEZ29uLvmBjAPREB524J5dPN1jk-UA7ajFdLdrbjumJqoOBeGWmig" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=anywhere-labs/deepseek-harness-desktop&type=date&legend=top-left&sealed_token=BRTkOyC4czCEkIyFb5-QxrsC-kaDotBJ8tsjxrWs-UGfmBqfRCXSwieZPlVTCYOjJVEZ29uLvmBjAPREB524J5dPN1jk-UA7ajFdLdrbjumJqoOBeGWmig" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=anywhere-labs/deepseek-harness-desktop&type=date&legend=top-left&sealed_token=BRTkOyC4czCEkIyFb5-QxrsC-kaDotBJ8tsjxrWs-UGfmBqfRCXSwieZPlVTCYOjJVEZ29uLvmBjAPREB524J5dPN1jk-UA7ajFdLdrbjumJqoOBeGWmig" />
 </picture>
</a>
