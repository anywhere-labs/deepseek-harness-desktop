# DSH Community Market

[English](README.md)

DSH Community Market 是 [DSH Desktop](../README.md) 的插件市场壳，用于发现社区插件；在 Desktop 中，还可以安装或移除少量通过 Market Host 检查的 npm package。

> **当前状态：private 集成测试 MVP。** Package 已有可加载的 Host/Client 入口、用户拥有的来源持久化、受限 HTTPS client、标准与 DSH 1024Store adapter，并在**设置 > 插件**中提供官方的**插件市场**标签页和侧边栏入口；同时已有 Host 受管安装、基于 receipt 的卸载，以及对可变 direct bundle 的 fail-closed 启用/禁用功能。这不表示被收录或显示为可安装的插件代码是安全的。

## 我们要做什么

当前界面分为四个视图：

1. **发现**展示当前来源已经加载并标准化的全部条目。点击任一卡片都会立即打开同一个操作弹窗：Desktop 先检查能否受管安装，不能时再显示详情或安全的只展示手动提示。
2. **可安装**是从完整索引中以 fail-closed 方式生成的本地结构候选列表。条目必须具有经过审核的 provider 验证与 `repository_backlink`、精确稳定的 npm 版本和规范仓库，同时排除被阻止的 package，以及当前 profile 或 Market receipt 中已经存在的 package。生成列表时不会逐包请求 npm；这里的卡片与发现页共用同一个操作弹窗。
3. **已安装**会把有效 Market receipt 与 Desktop 当前 profile 的 direct bundle 清单进行核对。Receipt 持有的 bundle 可以卸载；可变 bundle 可以禁用并重新启用。已禁用且由 receipt 持有的 bundle 会同时保留“启用”和“卸载”。
4. **来源**用于选择和管理目录来源；同一时间只浏览一个来源。

点击插件卡片会同步打开弹窗，并由 Host 判断这个精确的来源/条目能否使用受管安装。Preview 成功时，Host 才会针对它访问官方 npm registry，完整复核身份、仓库、integrity、runtime、lifecycle script、DSH bundle 证据和当前 profile，然后把同一个弹窗切换成精确确认；真正执行前还会再次检查可变状态。如果受管 preview 不可用，弹窗会保留为详情页，并可能展示 Host 根据规范化身份重建的精确 npm 命令。它不是 provider 命令，不会发送给 Desktop action，也不会自动执行；“打开 DSH 终端”只负责打开 Desktop 内置终端，由用户自行检查、复制和执行命令。通过这个内置终端运行的 `dsh plugin add` 会进入 Desktop 的受保护安装恢复边界；在其中直接执行 `pnpm`、`npm`，或在外部系统终端运行命令，都不受该边界保护。受管 profile 修改成功后，用户可以使用一次性 Desktop action 立即重启，也可以选择稍后重启。市场只是现有 DSH 能力之上的产品壳，不会再发明一套插件格式、包管理器、profile 存储或高权限安装器。

## 目录来源

市场不设默认目录。用户可以保存多个来源，但同一时间只浏览一个已选择来源，也可以切换选择或添加符合公开目录合同的来源。切换来源会开始新的浏览会话，并重置当前列表、搜索、分类选择和分页。每个来源都在适配器之后独立运行，市场界面只能看到同一套经过校验和标准化的数据。

符合规范的数据源需要发布一份 [`catalog-source` manifest](docs/schemas/catalog-source.schema.json)，其 `/v1/plugins` 接口返回符合 [`catalog-provider-page` Schema](docs/schemas/catalog-provider-page.schema.json) 的数据。来源可以提供 `media.icon`，Desktop 会先校验并代理图片再显示；没有图标的来源仍然合法，界面会使用本地 fallback。符合标准的数据源不需要为 Market 编写自定义代码。

展示已选来源前，Host 会先建立一份完整、经过校验的本地索引。标准来源按照声明的 cursor 与 page limit 扫描；经过审核的 1024Store adapter 只读取一次完整 registry，再按 Schema 上限分块标准化。之后的搜索、多分类 OR 筛选、分类选项和分页都在这份完整本地索引上进行，不会因为每次交互重新请求 provider。每个可见页面最多展示 50 条，分类选项覆盖索引中的全部分类，而不只是已经显示的页面。**可安装**是同一索引上 fail-closed 的结构子集；只有用户预览某个候选时，才开始权威 npm 复核。

Host 会在 cache 过期前复用已经完成的索引（当前默认五分钟）。如果 response 提供可选索引 metadata，`scannedAt` 表示扫描完成时间，`expiresAt` 表示 cache 截止时间，可选 `providerRevision` 表示整次扫描中一致观察到的来源 revision，`cacheStatus` 表示本次使用新扫描还是复用 cache。用户明确刷新时会替换索引并绕过底层目录 response cache，不只是重新绘制当前 50 条。

[DSH 1024Store](https://github.com/imsai-sh/awesome-deepseek-harness-plugins) 是目前与本项目合作的目录提供方之一。市场随包提供一份针对其公开 API、经过审查的本地 adapter，但合作关系不代表默认启用、排序优先、未选择来源时的兜底，也不代表对其收录内容的推荐。该项目独立维护插件发现、校验、网站、API 和另行发布的 `dsh-1024store` 插件。DSH Community Market 不是该插件的 fork、重新打包版本或官方客户端。

所有目录数据都是远程、且不可信的输入。项目被收录只表示提供方返回了相关元数据；这**不表示** Anywhere Labs 已经审核、推荐或保证该插件。

## 安全承诺

- 后台浏览不会安装任何包，也不会执行仓库代码。
- 只有用户明确点击并确认后，安装才会开始。
- **可安装**是 Host 以 fail-closed 方式生成的结构候选集合，不是 renderer 猜测，也不表示 npm 已经复核。候选必须具有经过审核的 provider 验证与 `repository_backlink`、精确稳定的 npm 目标和规范仓库，而且不能已经安装、已有 receipt 或被本地策略阻止。Preview 才会针对这个 package 首次执行官方 registry 权威复核；执行前会再检查可变状态。
- 受管安装器只接受精确、稳定的 npm 版本。GitHub URL、可变版本范围或 tag、deprecated package、目标 manifest 中定义了 `preinstall`、`install`、`postinstall` 或 `prepare` 的 package，以及不兼容内置 DSH rc.7 或 Node.js runtime 的 package，都会被拒绝。
- 目录提供方返回的命令字符串、安装片段和仓库安装指令都会被丢弃，绝不会执行。可用时，Host 会根据规范化身份单独重建一条精确 npm 手动提示；它会明确标为未完成全部验证，只供用户自行决定是否执行。
- 受管操作中，renderer 只提交来源/条目或 receipt 标识。“打开 DSH 终端”提交的是空请求，不会接收、复制或执行界面展示的手动命令。
- 确认框会展示精确 npm package 与版本，以及当前 profile。插件变更使用 Desktop 已有的受管 DSH 插件服务，并且一次只执行一个操作；成功后可以选择**稍后重启**或**立即重启**。
- Market 安装或内置终端中的 `dsh plugin add` 开始前，Desktop 只会为当前 profile 的 `package.json`、`pnpm-lock.yaml` 和 `pnpm-workspace.yaml` 创建私有恢复快照。它不会备份或主动回滚 `node_modules`，也不会读取环境变量或另行收集凭据存储；这三个白名单文件会按原内容复制，因此其中不应写入凭据。
- 受保护安装成功后，要等下一次 Desktop generation 成功启动 Host，并在 30 秒期限内收到 Renderer 的健康报告，才算验证完成；此前会拒绝下一次受保护的插件添加。如果启动失败，Desktop 会先在本地保存诊断证据，再仅对已识别的前后配置状态执行恢复，并且最多自动重启一次。出现未知文件漂移时不会覆盖用户数据，而会要求手动修复。
- 只有合法 Market receipt 仍与当前 profile 的 direct bundle 匹配时才能卸载。可变 direct bundle 可以禁用或重新启用 Desktop 的加载选择；这不会改变 package 所有权，也不会移除 package 或把插件代码放入安全沙箱。
- 第一版不包含账号、遥测、静默安装、插件自动更新或自建目录后台。

这些检查只建立 package 身份和有限的兼容边界，**不代表** Market 审查过插件或依赖树中是否存在恶意或不安全行为。安装后的插件会以用户权限作为本地代码运行。测试或审核 package 操作前，请先阅读[安装与卸载](docs/install-and-uninstall.zh.md)和[安全说明](SECURITY.zh.md)。

## 文档

- [市场壳设计](docs/market-shell.zh.md)：产品边界、架构、profile、失败处理和交付阶段。
- [安装与卸载](docs/install-and-uninstall.zh.md)：四个视图、用户流程、Host 复核、receipt、支持目标和开发集成边界。
- [目录提供方合同](docs/catalog-provider-contract.zh.md)：来源 manifest、查询参数、wire/标准化 JSON、单一已选来源行为和实现交接要求。
- [目录适配器指南](docs/catalog-adapter-guide.zh.md)：标准来源直接接入、已有 API 的受审 adapter 接入路径和映射模板。
- [安全说明](SECURITY.zh.md)：信任模型、漏洞反馈和不可妥协的安装规则。
- [Desktop 插件服务](../dsh-plugin-desktop/docs/plugin-services.zh.md)：Market package 操作正在使用的 `desktopProfiles` 与 `desktopPnpm` 合同。
- [DSH 插件开发](../docs/plugin-development.md)：普通 DSH 与 Desktop 共用的插件模型。

## 交付计划

- **Phase 0 — 已完成：** 确认 package 归属，写清产品与信任边界，建立 headless 检查。
- **Phase 1 — 已实现并进入集成测试：** 来源选择、用户添加符合规范的来源、一次一个来源的浏览、搜索、插件详情，以及加载、空白和错误状态。
- **Phase 2 — 已实现并进入集成测试：** 通过 Desktop 受管服务，把精确稳定 npm package 安装到当前 profile，提供配置级安装恢复，并支持基于 receipt 的卸载。
- **后续：** 更新、更广泛的兼容证据，以及发布评审。

目录采集、投稿审核、账号、排行榜和托管仍由目录 provider 负责，不属于这个 package。

## 许可证与来源说明

package 代码与文档遵循 [MIT License](LICENSE)。当前初始化工程没有打包 DSH 1024Store 的代码、素材或目录快照。它的公开目录元数据采用 CC0-1.0，具体来源与历史由[上游目录项目](https://github.com/imsai-sh/awesome-deepseek-harness-plugins)记录。
