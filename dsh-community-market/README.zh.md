# DSH Community Market

[English](README.md)

DSH Community Market 是为 [DSH Desktop](../README.md) 规划的插件市场壳。它将帮助用户发现社区插件、了解插件用途，并通过一次清晰的确认操作，把插件安装到当前正在使用的工作配置中。

> **当前状态：文档优先的初始化工程。** 这个 workspace 还没有市场页面、目录客户端或安装器，在首个可用实现完成前保持 monorepo 私有。现在不要把它加入 DSH profile。

## 我们要做什么

第一个可用版本只需要完成一条简单、容易理解的流程：

1. 浏览和搜索社区插件目录。
2. 打开插件详情，查看用途、源码仓库和安全提示。
3. 点击“安装”，确认准确的插件与当前工作配置。
4. 由 Desktop 调用已有的受管 DSH 插件命令。
5. 配置修改完成后，提示用户重启 Desktop。

市场只是现有 DSH 能力之上的产品壳，不会再发明一套插件格式、包管理器、profile 存储或高权限安装器。

## 目录来源

最初的目录适配器计划参考 [DSH 1024Store](https://github.com/imsai-sh/awesome-deepseek-harness-plugins) 发布的公开 registry。该项目独立维护插件发现、格式校验、网站、API，以及另行发布的 `dsh-1024store` 插件。DSH Community Market 是面向 Desktop 的独立市场壳，不是该插件的 fork、重新打包版本或官方客户端，也不代表其维护者、DeepSeek 或目录中的插件作者。

远程目录数据是可替换、且不可信的输入。一个项目被目录收录，只表示它符合目录的元数据规则；这**不表示** Anywhere Labs 已经审核、推荐或保证该插件。

## 安全承诺

- 后台浏览不会安装任何包，也不会执行仓库代码。
- 只有用户明确点击并确认后，安装才会开始。
- 市场会从经过校验的仓库身份推导安装目标，绝不执行目录返回的命令字符串。
- 确认框会展示准确来源和当前工作配置。
- 插件变更使用 Desktop 已有的受管 DSH 插件服务，并且一次只执行一个操作。
- 第一版不包含账号、遥测、静默安装、插件自动更新或自建目录后台。

插件会以用户权限作为本地代码运行，安装过程中还可能执行 package lifecycle script。实现或审核安装功能前，请先阅读[安全说明](SECURITY.zh.md)。

## 文档

- [市场壳设计](docs/market-shell.zh.md)：产品边界、架构、profile、失败处理和交付阶段。
- [安全说明](SECURITY.zh.md)：信任模型、漏洞反馈和不可妥协的安装规则。
- [Desktop 插件服务](../dsh-plugin-desktop/docs/plugin-services.zh.md)：未来实现会使用的 `desktopProfiles` 与 `desktopPnpm` 合同。
- [DSH 插件开发](../docs/plugin-development.md)：普通 DSH 与 Desktop 共用的插件模型。

## 交付计划

- **Phase 0 — 当前：** 确认包归属，写清产品与信任边界，建立 headless 检查。
- **Phase 1：** 只读目录 provider、搜索、分类、插件详情，以及加载、空白和错误状态。
- **Phase 2：** 通过 Desktop 受管服务，明确安装到当前 profile。
- **后续：** 卸载、更新、失败恢复、更丰富的验证信号和多个目录 provider。

目录采集、投稿审核、账号、排行榜和托管仍由目录 provider 负责，不属于这个 package。

## 许可证与来源说明

package 代码与文档遵循 [MIT License](LICENSE)。当前初始化工程没有打包 DSH 1024Store 的代码、素材或目录快照。它的公开目录元数据采用 CC0-1.0，具体来源与历史由[上游目录项目](https://github.com/imsai-sh/awesome-deepseek-harness-plugins)记录。
