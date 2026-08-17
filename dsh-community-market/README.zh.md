# DSH Community Market

[English](README.md)

DSH Community Market 是 [DSH Desktop](../README.md) 的插件市场壳，用于发现社区插件并了解插件用途。安装属于后续独立开发和安全评审阶段。

> **当前状态：只读市场 MVP 开发阶段。** Package 现在已有可加载的 Host/Client 入口、用户拥有的来源持久化、受限 HTTPS client、标准与 DSH 1024Store adapter，以及从侧边栏打开的独立市场工作区。它继续保持 private，且尚无安装器。

## 我们要做什么

第一个可用版本只需要完成一条简单、容易理解的流程：

1. 浏览和搜索社区插件目录。
2. 打开插件详情，查看用途、源码仓库和安全提示。
3. 点击“安装”，确认准确的插件与当前工作配置。
4. 由 Desktop 调用已有的受管 DSH 插件命令。
5. 配置修改完成后，提示用户重启 Desktop。

市场只是现有 DSH 能力之上的产品壳，不会再发明一套插件格式、包管理器、profile 存储或高权限安装器。

## 目录来源

市场不设默认目录。用户可以选择要启用的来源、调整它们的顺序，也可以添加符合公开目录合同的来源。每个来源都在适配器之后独立运行，市场界面只能看到同一套经过校验和标准化的数据。

[DSH 1024Store](https://github.com/imsai-sh/awesome-deepseek-harness-plugins) 是目前与本项目合作的目录提供方之一。市场随包提供一份针对其公开 API、经过审查的本地 adapter，但合作关系不代表默认启用、排序优先、未选择来源时的兜底，也不代表对其收录内容的推荐。该项目独立维护插件发现、校验、网站、API 和另行发布的 `dsh-1024store` 插件。DSH Community Market 不是该插件的 fork、重新打包版本或官方客户端。

所有目录数据都是远程、且不可信的输入。项目被收录只表示提供方返回了相关元数据；这**不表示** Anywhere Labs 已经审核、推荐或保证该插件。

## 安全承诺

- 后台浏览不会安装任何包，也不会执行仓库代码。
- 只有用户明确点击并确认后，安装才会开始。
- 市场会根据经过校验的 package 或仓库身份，独立解析并锁定安装目标；绝不执行目录返回的命令字符串。
- 确认框会展示准确来源和当前工作配置。
- 插件变更使用 Desktop 已有的受管 DSH 插件服务，并且一次只执行一个操作。
- 第一版不包含账号、遥测、静默安装、插件自动更新或自建目录后台。

插件会以用户权限作为本地代码运行，安装过程中还可能执行 package lifecycle script。实现或审核安装功能前，请先阅读[安全说明](SECURITY.zh.md)。

## 文档

- [市场壳设计](docs/market-shell.zh.md)：产品边界、架构、profile、失败处理和交付阶段。
- [目录提供方合同](docs/catalog-provider-contract.zh.md)：来源 manifest、查询参数、wire/标准化 JSON、多来源行为和实现交接要求。
- [安全说明](SECURITY.zh.md)：信任模型、漏洞反馈和不可妥协的安装规则。
- [Desktop 插件服务](../dsh-plugin-desktop/docs/plugin-services.zh.md)：未来实现会使用的 `desktopProfiles` 与 `desktopPnpm` 合同。
- [DSH 插件开发](../docs/plugin-development.md)：普通 DSH 与 Desktop 共用的插件模型。

## 交付计划

- **Phase 0 — 已完成：** 确认包归属，写清产品与信任边界，建立 headless 检查。
- **Phase 1 — 开发中：** 来源选择、用户添加符合规范的来源、多来源只读浏览、搜索、插件详情，以及加载、空白和错误状态。
- **Phase 2：** 通过 Desktop 受管服务，明确安装到当前 profile。
- **后续：** 卸载、更新、失败恢复和更丰富的验证信号。

目录采集、投稿审核、账号、排行榜和托管仍由目录 provider 负责，不属于这个 package。

## 许可证与来源说明

package 代码与文档遵循 [MIT License](LICENSE)。当前初始化工程没有打包 DSH 1024Store 的代码、素材或目录快照。它的公开目录元数据采用 CC0-1.0，具体来源与历史由[上游目录项目](https://github.com/imsai-sh/awesome-deepseek-harness-plugins)记录。
