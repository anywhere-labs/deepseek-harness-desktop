# DSH Community Market 市场壳设计

[English](market-shell.md)

状态：已完成并内置于 AI Buddy，包括 Host/Client 市场、有限 npm 安装、基于 receipt 的卸载及 direct-bundle 启用/禁用

本文定义 `dsh-community-market` 已交付的实现边界。它刻意比完整的插件市场更小：package 只负责产品内的市场壳和适配器，不负责社区目录、包 registry 或 DSH profile 格式。

## 产品目标

- 给用户一个安静、清晰的入口，用来发现、搜索和了解社区插件。
- 在用户明确选择操作前，目录浏览始终保持只读。
- 只安装到当前 profile，并在确认前展示插件来源和目标 profile。
- 为每次 Market 安装，以及通过 Desktop 内置 DSH 终端运行的 `dsh plugin add`，提供配置级快照，并要求下一次启动通过健康验证。
- 只移除当前 profile 中拥有合法 Market receipt 的安装，即使原来源已经不可用也能卸载。
- 复用现有 DSH 插件与 Desktop profile 行为，不创建平行状态。
- 让用户保存和添加目录来源，再明确选择同一时间只浏览其中一个，避免界面永久绑定某一个服务。
- 不依赖 Electron 私有访问也能工作；Desktop 集成是可选能力，不是 renderer 全局对象。

## 第一版不做什么

- 运营目录后台、GitHub 爬虫、投稿队列或审核系统。
- 账号、付费、评论、排行榜、广告或遥测。
- 宣称被收录插件安全、经过审核、兼容或得到推荐。
- 静默安装、自动安装、插件自动更新或后台修改 profile。
- 执行目录响应中的安装命令、HTML、脚本或链接。
- 从 GitHub 或其他仓库目标安装、接受可变版本，或运行声明了安装 lifecycle script 的目标 package。
- 修改未激活 profile，或在 profile 之间迁移插件。
- 备份或主动回滚 `node_modules`、保护直接执行的 `pnpm`/`npm` 命令，或恢复在外部系统终端运行的命令。

## 已实现边界

```mermaid
flowchart LR
    Selection["用户选择来源<br/>没有或恰好一个当前来源"] --> Registry["已保存来源 registry"]
    Partner["经审查的合作方适配器"] --> Registry
    Standard["用户添加的标准来源"] --> Registry
    Registry --> Host["Market Host 插件<br/>请求、隔离、校验、标准化"]
    Host --> Route["普通 DSH route 或 RPC"]
    Route --> Client["Market Client 插件<br/>搜索、详情、确认"]
    Profiles["desktopProfiles<br/>当前 profile"] --> Host
    Pnpm["desktopPnpm<br/>受管插件操作"] --> Host
    Host -. "没有 Desktop 服务" .-> Browse["仍可只读浏览"]
```

renderer 只通过普通 DSH route 或 RPC 接收标准化纯数据，不会获得 Electron、文件系统、进程、`desktopRuntime` 或包管理器访问。Host 负责目录 I/O、校验、安装编排、取消和操作串行化。

Client 会贡献一个名为**插件市场**的 `settings.plugins.tab`，同时提供一个侧边栏按钮，用 shell overlay 打开同一套 Market 界面。设置页仍然是规范的管理入口；侧边栏只是便捷入口，不是第二份实现，也不是独立 workspace。只有任一 Market 界面真正挂载后才会开始目录请求，两处界面共用相同的 Host routes 与标准化数据合同。

## 目录来源与适配器

市场不设默认目录。用户可以保存多个来源记录，但浏览会话只能没有选择，或恰好选择一个来源。没有选择来源时要展示明确的空状态且不发出目录请求，不能悄悄退回到某个合作方。选择另一个来源时，必须先取消旧请求并重置当前列表、搜索、分类选择和分页，再读取新来源。

Host 支持两条来源路径：

1. 用户添加的来源实现公开 HTTPS JSON 合同，由标准适配器处理。
2. 接口不同的合作方，通过随 Market 代码发布且经过审查的适配器接入。

DSH Community Market 以开放方式与各种插件数据源合作。任何人都可以发布实现公开标准合同的插件目录，任何用户也都可以添加和使用这样的来源。使用不同 API 的提供方可以提出经过审查的内置适配器；符合标准合同的来源则可以通过公开合同直接接入。

远程 manifest 可以描述数据，但不能提供适配器代码、凭据、命令、启用状态或优先级。每个适配器都必须先把私有响应转成同一套标准化页面，才能交给 renderer；来源私有字段不能变成 UI 假设。

标准 adapter 只序列化来源 manifest 的 `query.supported` 清单中声明的字段。尤其是，来源没有声明支持 `category` 时，adapter 会针对该来源省略该字段，而不是模拟该能力或把筛选广播给该来源。

[DSH 1024Store](https://github.com/imsai-sh/awesome-deepseek-harness-plugins) 是目前与项目合作的提供方之一，市场已包含针对其公开 API、经过审查的内置适配器。它不是默认、优先或兜底来源，合作关系也不表示其收录内容经过我们审核或推荐。它的接口和 schema 继续归该独立项目所有。

[dshfind](https://dshfind.com) 是另一个通过经审查内置 adapter 接入的可选合作来源。它不会被默认选择、优先排序、推荐或用作兜底。它的目录收录、分数、等级、`official`/精选标记、风险标记和安装探测仍是 provider claim，不是 Anywhere Labs 作出的信任判断。

**公司插件目录**（`company-store`）是可选的合作内置来源，复用经审查的 1024Store 风格 adapter factory，对接公司目录 apex。它不是默认、优先来源，也不会在 `dsh-1024store` 失败时作为兜底。选中后 Market 界面会显示免责声明：`公司目录，收录≠安全审核`。

已发布的规范合同是[目录提供方合同](catalog-provider-contract.zh.md)，其中包含来源 manifest、query、不可信 provider page 和 Host 标准化响应的机器可读 Schema。远程字段只是展示数据，不是可执行指令；文本只能按文本渲染，不能作为原始 HTML。

## 完整本地索引与 cache

Host 会先针对已选来源和当前 locale 完成一次全量标准化扫描，再提供目录交互。标准来源按照声明的 cursor 和有效 page limit 扫描到结束；经过审核的 1024Store adapter 则只执行一次 registry GET，索引当前发布的首页切片，并按每块最多 100 条的 Schema 上限输出。之后的搜索可以发送 provider 的 `q` 参数，以便解析切片之外的包。dshfind adapter 会遍历每页最多 100 条的 REST 数据，并在所有后续分页中固定首页的 `data_version`。由于其公布的匿名配额低于当前首次同步所需的 page 数，首次扫描会主动节流，可能明显更慢；版本过期或限流失败时不会发布部分索引。10,000 条 Host 上限、来源身份、取消、provenance 和同源检查覆盖整次扫描。

搜索、排序、多分类 OR 筛选、分类枚举和分页只在这份完整本地索引上运行。UI 每页最多展示 50 条匹配结果；**加载更多**推进 Host 拥有的本地 cursor，不会再次向 provider 发出带筛选的请求。分类列表是索引中存在的完整分类集合。**可安装**是同一索引上 fail-closed 的结构子集，不是第二个 provider feed，也不是逐包请求 registry 得出的结果。它的目录成员资格与本地安装、receipt、卸载历史及启用/禁用状态无关。

完成的索引会在有界时间内复用，当前默认五分钟。可选 response metadata 可以提供：`scannedAt`（扫描完成时间）、`expiresAt`（cache 截止时间）、可选 `providerRevision`（所有分块中一致观察到的 revision），以及 `cacheStatus`（完成新扫描时为 `fresh`，复用索引时为 `cached`）。明确刷新会使旧索引失效，并绕过底层目录 HTTP cache 后重新建立。选择另一个来源会取消旧扫描并建立独立索引。

## 四个视图与插件操作

Market 界面包含四个视图：

- **发现**对当前已选来源完整本地索引中的全部标准化条目进行分页。点击卡片会立即打开统一操作弹窗；Host 会让合格条目进入受管 preview，否则弹窗保持为详情。
- **可安装**从已选来源的完整索引中以 fail-closed 方式生成。条目必须具有经过审核的 provider 验证与 `repository_backlink`、精确稳定的 npm 目标和规范仓库，同时排除产品 blocklist 中的 package。只要已选目录仍然包含条目，已经安装、已有 receipt、处于禁用状态或后来已卸载的 package 都会继续显示。这里的卡片使用同一个弹窗。结构候选身份不等于 npm 复核、本地操作许可、代码审核或推荐。dshfind 条目只有通过唯一、无歧义且经过复核的结构化 npm method 才会进入这一子集；缺少该证据的条目仍然只能在**发现**中浏览。
- **已安装**会核对当前 profile 的 Host 清单与合法 Market receipt，绝不会根据目录猜测安装状态。
- **来源**管理已保存来源和唯一的当前选择。

目录浏览提供：

- 来源选择、已保存来源管理和添加符合规范的来源；
- 每个浏览会话只有一个已选来源，不暗中请求或退回其他已保存来源；
- 对唯一已选来源执行一次完整扫描；标准来源的网络 page 服从 manifest 和 Schema 最大值 100，经过审核的 1024Store adapter 只读取一次当前发布页；
- 页面底部的**加载更多**按每页最多 50 条推进本地匹配结果；
- 加载、空目录、离线、非法响应和重试状态；
- 在完整索引的全部标准化名称与描述上进行本地搜索；
- 采用 OR 语义的多选分类筛选：条目匹配任一已选分类即可；
- 分类选项来自完整本地索引中的全部条目；
- 包含源码仓库和目录来源的详情页；
- 缺少安装能力时的不可用说明。

加载目录时不会调用包管理器、解析本地 executable、修改 profile 或记录安装事件。目录错误也不会阻止 DSH 或 Desktop 启动。

## 安装边界

点击卡片表示用户明确要求检查该条目。弹窗会同步打开，同时由 Host 判断这个精确的标准化来源/条目能否进入受管 preview。目录推导的结构候选身份与本地操作是否可用是两件事：Host 可以因为当前 profile、receipt 或其他本地状态拒绝安装，但不会因此移除目录卡片。候选身份由 Host 而不是 renderer 掌握；Host 会首次针对该 package 访问官方 npm registry，并结合当前 profile 做权威复核。只有 preview 成功后，同一个弹窗才会切换成确认框并展示：

- 插件名称；
- Host 解析出的精确 npm package 名与稳定版本；
- 当前 profile 名称；
- 短时确认的过期时间；以及
- 插件会以用户权限作为本地代码运行、而且该复核不等于代码审计的提示。

目录中的 `install` 字段、文档命令、provider 命令和任意字符串都会失去执行授权，绝不会被执行，也不会作为 Host 手动提示展示。当标准化条目具有精确稳定的 npm 身份时，Host 可以另行重建一条有界、只用于展示的命令。该文本可能与仓库文档中的命令不同，会明确标为未完成全部验证，而且绝不会发送给 package manager 或 Desktop action。dshfind adapter 会明确丢弃 `install.cmd`，绝不解析或转发它。内置受管安装器会拒绝 GitHub 与其他仓库安装目标、range、tag、prerelease、deprecated 版本、目标 manifest 中包含 `preinstall`、`install`、`postinstall` 或 `prepare` 的 package、与内置 DSH `0.1.1-rc.1`/Cordis/Node.js runtime 不兼容的 package、仓库身份不匹配的 package，以及缺少官方 npm SHA-512/tarball 或有效 DSH bundle 证据的 package。

Preview 会针对这一个 package 完整检查 npm registry、规范仓库、deprecated 状态、lifecycle script、runtime、integrity、tarball、DSH bundle 和当前 profile，并用一次性不透明 preview 绑定已验证事实。用户确认后、真正修改前，执行阶段会立即重新获取或检查可变的 registry、候选和 profile 证据；候选、当前 profile、tarball、integrity 或 bundle 路径发生变化时会拒绝执行。受管操作中，renderer 只提交不透明身份，绝不会提交 package-manager spec 或命令。

在 Desktop 中，Market Host 使用 `dsh-plugin-desktop` 已提供的公开服务：

1. 从 `desktopProfiles.current` 读取当前身份。
2. 调用 Desktop 的可恢复安装能力，使用固定构造的 `add --save-exact` 参数、官方 npm registry、明确的绝对 profile 目录和 `AbortSignal`。Child 启动前只为 `package.json`、`pnpm-lock.yaml` 和 `pnpm-workspace.yaml` 创建快照；操作报告完成前会封存成功结果或已识别的部分结果。
3. 不把 stdout、stderr、环境变量、本地路径或命令内部细节交给 renderer；唯一允许交付的命令文本，是上面定义的有界、只展示指引。
4. 同一时间只允许一个修改操作，并拒绝已变化的 profile。
5. 保存 receipt 前验证 profile dependency 和没有越出 package 的 DSH bundle；安装结果非法或无法记录，并且文件状态可识别时，恢复白名单配置快照。
6. 成功后签发短时、一次性重启许可，让用户选择**立即重启**或**稍后重启**；绝不静默重启。恢复记录继续保持 pending，直到下一次 Desktop generation 验证启动健康或完成回滚 reconcile；此前拒绝另一次受保护的插件添加。

没有 Desktop 服务时，目录浏览仍可使用，package 操作则会说明需要 AI Buddy。受管安装不会退回 ambient `pnpm`、shell 命令、猜测的 `dsh` executable 或未激活 profile。**打开 AI Buddy 终端**是独立的用户控制入口：请求不携带命令、路径或 profile，只负责打开 Desktop 内置终端；是否复制并运行展示文本完全由用户决定。之后通过该内置终端运行的 `dsh plugin add` 会获得相同的配置恢复 handoff；在其中直接执行 `pnpm`、`npm`，或在外部系统终端运行命令，都不会获得这项保护。

## 安装恢复边界

恢复记录是针对一次受保护 `plugin add` 的 Desktop 私有 write-ahead log，不是完整 profile 或插件备份。它保存 metadata，以及当前 profile 的 `package.json`、`pnpm-lock.yaml` 和 `pnpm-workspace.yaml` 私有前镜像。它不会备份或主动移除 `node_modules`，不会收集环境变量或独立凭据存储，也不适用于卸载或 direct-bundle 启用/禁用。三个白名单文件会按原内容复制，因此其中不得嵌入凭据。

Add 成功后，系统会在开放重启许可前封存白名单文件的结果 hash 和 Market receipt 标识。下一次 Desktop generation 会在准备 profile 前认领这条 pending 记录。Host 成功启动，并且 Renderer 在 30 秒期限内报告健康后，安装才会提交并清除恢复材料。如果发生 Host 故障、主 frame 加载失败、Renderer 故障、超时或验证中断，系统会先保存本地诊断归档，再仅恢复当前 hash 与已记录前镜像或后镜像匹配的文件。未知第三方漂移会 fail closed 到手动恢复，不会被覆盖。自动恢复成功后最多重新启动 Desktop 一次，绝不会形成循环。

诊断归档只保留在本地，其中可能包含日志、系统信息和 crash 证据；产品不能宣称每一种 artifact 都已经彻底脱敏。如果启动恢复回滚了一次已经保存 Market receipt 的安装，Market 会在确认恢复记录前只移除这条精确 receipt。Receipt store 更新失败时，记录保持 pending，等待之后重试。只要记录仍然存在，write-ahead-log 边界就会拒绝下一次受保护的插件添加；这不是针对外部工具或其他文件系统修改的全局 gate。

## 卸载边界

**已安装**视图来自当前 profile 的 direct-bundle 清单与合法本地 receipt，不依赖已选来源。因此，即使安装来源后来被禁用、删除或离线，通过 Market 安装的插件仍然可以卸载。

卸载预览只接受 `receiptId`。Host 会确认 receipt 仍然存在，并且当前 profile 仍包含 receipt 记录的精确 package 版本和 DSH bundle。执行阶段只接受由此生成的不透明一次性 preview，调用受管 `remove` 操作，确认 package 已移除后再删除 receipt。内置 Market 不会移除通过其他方式安装的 package、其他 profile 的 receipt，或安装后已经发生变化的 package。成功后同样显示**立即重启**与**稍后重启**。

可变 direct bundle 还会暴露 generation-scoped 不透明启用/禁用能力。已禁用的 Market 受管 bundle 会保留基于 receipt 的“卸载”，并可独立选择“启用”。Host 与 Desktop 会在 preview 和执行时重验精确 bundle 状态、可变性、profile generation 与 receipt 所有权；renderer 绝不会提交 package 名或文件系统目标。

## Profile 行为

- 当前 profile 是唯一安装目标。
- 已安装状态查询也按当前 profile 隔离。
- 确认框再次显示 profile 名称，目标不能隐含。
- 切换 profile 继续由 `desktopProfiles.select()` 管理，并通过已有的受控重启生效。
- 市场不会在后台修改未激活 profile。
- profile 切换或服务释放时，必须先取消或等待自己拥有的操作，再结束插件 generation。
- 受保护的插件添加会保留一条 pending 恢复记录，直到下一次 Desktop generation 验证 Host 与 Renderer 健康；记录仍在时拒绝第二次受保护添加。

安装 receipt 保存在本地并记录所属 profile；界面只列出当前 profile 的 receipt。它只说明 Market 完成并验证过一次受管安装，不表示 provider 仍然可用，也不表示插件代码安全。会话不属于市场职责。市场不会承诺任意自定义 profile 共享存储，只负责报告和修改当前 profile 中由 receipt 持有的插件成员。

## 失败处理

| 情况 | 用户看到什么 | 副作用 |
| --- | --- | --- |
| 离线、超时、非 200、响应过大或格式非法 | 目录暂不可用，并提供重试 | 无 |
| 安装 preview 无法验证 npm metadata，或发现 package deprecated、带安装脚本、不兼容、身份不匹配或缺少证据 | 不生成确认；在本地输入变化前，该结构候选仍可能可见 | 无 |
| Preview 成功后 registry、候选或当前 profile 发生变化 | Host 拒绝已经确认的执行 | 无 |
| 缺少 Desktop package 能力 | 可以浏览，但安装和卸载不可用 | 无 |
| 用户取消确认 | 返回详情页 | 无 |
| 安装取消，或在产生可识别的部分修改后失败 | 有界错误摘要和重试入口 | 封存部分镜像后恢复三个白名单配置文件；不会主动回滚 `node_modules` |
| 安装成功 | 提示需要重启 | 当前 profile 与本地 receipt 已更新；恢复记录等待下一次启动健康验证 |
| 下一次启动时 Host 失败，或 Renderer 失败、未在 30 秒内报告健康 | 自动重启后显示恢复说明 | 保存本地诊断，恢复已识别配置状态，并且最多自动重启 Desktop 一次 |
| 白名单文件出现未知第三方漂移 | 要求手动恢复 | 不进行部分自动覆盖 |
| 已经存在 Market receipt 的安装被启动恢复回滚 | Reconcile 后该安装从界面消失 | 确认恢复记录前先移除精确 receipt |
| Receipt 或已安装 bundle 不再匹配 | 拒绝卸载 | 无 |
| 卸载成功 | 提示需要重启 | 已从当前 profile 移除 package 与 receipt |

面向用户的错误或遥测中，不得包含原始响应 body、文件路径、token、环境变量或命令字符串。

## 交付状态与后续工作

### Phase 0：package 与信任基础——已交付

- npm 名称和 monorepo package 边界已经确立。
- 目录来源、信任规则和集成决策已经记录。
- Host/Client package 已作为 AI Buddy 内置实现交付。

### Phase 1：目录市场壳——已交付并内置

- Host 与 Client 插件入口。
- 用户拥有的来源选择、标准来源、经审查的合作方适配器与严格标准化。
- 一次一个来源的完整索引、本地 50 条分页、provenance、cache metadata、强制刷新，以及不做兜底的明确失败处理。
- 搜索、分类、详情和完整状态处理。
- headless 单元测试与 Loader smoke。

### Phase 2：确认后的当前 profile 操作——已交付并内置

- Desktop 能力检测和不可用状态。
- 精确稳定 npm 目标复核和两步用户意图。
- 受管、串行化且带验证 receipt 的安装；读取和预览可取消，已接受的 mutation 则由 Host 持有。
- 为 Market 安装和内置终端中的 `dsh plugin add` 提供配置级 write-ahead 恢复，并在下一次启动验证 Host/Renderer 健康。
- 不依赖目录来源、基于 receipt 的卸载，以及针对可变 direct bundle 的不透明启用/禁用。
- profile 修改成功后的重启说明。

### 交付后的增强

- 更新与发布加固。
- 基于独立规范证据的更强验证信号。

## 来源与独立性

本设计参考了多个社区目录项目，其中包括 [imsai-sh/awesome-deepseek-harness-plugins](https://github.com/imsai-sh/awesome-deepseek-harness-plugins)，该项目也以 DSH 1024Store 展示。DSH 1024Store 是当前合作的提供方，并另行发布 `dsh-1024store` 插件。DSH Community Market 不是该插件的 fork、重新打包版本或官方客户端。其应用代码使用 MIT，目录元数据使用 CC0-1.0。Market 没有复制其代码或素材，也没有打包目录快照。

DSH Community Market 是 Anywhere Labs 的独立项目。目录收录不表示 Anywhere Labs、DSH 1024Store、DeepSeek 或插件作者对项目作出推荐。
