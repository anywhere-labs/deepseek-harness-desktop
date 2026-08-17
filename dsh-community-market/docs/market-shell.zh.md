# DSH Community Market 市场壳设计

[English](market-shell.md)

状态：设计提案；只读 Host/Client 市场 MVP 已实现并进入集成测试，安装器尚未实现

本文定义 `dsh-community-market` 第一阶段的实现边界。它刻意比完整的插件市场更小：package 只负责产品内的市场壳和适配器，不负责社区目录、包 registry 或 DSH profile 格式。

## 产品目标

- 给用户一个安静、清晰的入口，用来发现、搜索和了解社区插件。
- 在用户明确选择操作前，目录浏览始终保持只读。
- 只安装到当前 profile，并在确认前展示插件来源和目标 profile。
- 复用现有 DSH 插件与 Desktop profile 行为，不创建平行状态。
- 让用户明确选择、排序和添加目录来源，避免界面永久绑定某一个服务。
- 不依赖 Electron 私有访问也能工作；Desktop 集成是可选能力，不是 renderer 全局对象。

## 第一版不做什么

- 运营目录后台、GitHub 爬虫、投稿队列或审核系统。
- 账号、付费、评论、排行榜、广告或遥测。
- 宣称被收录插件安全、经过审核、兼容或得到推荐。
- 静默安装、自动安装、插件自动更新或后台修改 profile。
- 执行目录响应中的安装命令、HTML、脚本或链接。
- 修改未激活 profile，或在 profile 之间迁移插件。

## 规划边界

```mermaid
flowchart LR
    Selection["用户选择来源<br/>可以不选、选一个或多个"] --> Registry["来源 registry"]
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

## 目录来源与适配器

市场不设默认目录。首次使用时由用户选择不启用来源、启用一个或启用多个，并决定展示顺序。没有选择来源时要展示明确的空状态，不能悄悄退回到某个合作方。

Host 支持两条来源路径：

1. 用户添加的来源实现公开 HTTPS JSON 合同，由标准适配器处理。
2. 接口不同的合作方，通过随 Market 代码发布且经过审查的适配器接入。

远程 manifest 可以描述数据，但不能提供适配器代码、凭据、命令、启用状态或优先级。每个适配器都必须先把私有响应转成同一套标准化页面，才能交给 renderer；来源私有字段不能变成 UI 假设。

[DSH 1024Store](https://github.com/imsai-sh/awesome-deepseek-harness-plugins) 是目前与项目合作的提供方之一，市场已包含针对其公开 API、经过审查的内置适配器。它不是默认、优先或兜底来源，合作关系也不表示其收录内容经过我们审核或推荐。它的接口和 schema 继续归该独立项目所有。

面向实现团队的规范是[目录提供方合同](catalog-provider-contract.zh.md)，其中包含来源 manifest、query、不可信 provider page 和 Host 标准化响应的机器可读 Schema。远程字段只是展示数据，不是可执行指令；文本只能按文本渲染，不能作为原始 HTML。

## 只读浏览

Phase 1 提供：

- 来源选择、来源排序和添加符合规范的来源；
- 多来源隔离查询，其中一个来源失败不会隐藏其他来源的成功结果；
- 加载、空目录、离线、非法响应和重试状态；
- 基于标准化名称与描述的搜索；
- 分类筛选；
- 包含源码仓库和目录来源的详情页；
- 缺少安装能力时的不可用说明。

加载目录时不会调用包管理器、解析本地 executable、修改 profile 或记录安装事件。目录错误也不会阻止 DSH 或 Desktop 启动。

## 安装边界

安装属于 Phase 2，并且只能由用户操作开始。执行前的确认必须展示：

- 插件名称；
- 规范化 package 或源码仓库身份；
- 已锁定的精确 package 版本或不可变 repository commit；
- 当前 profile 名称；
- 插件会以用户权限在本地运行的提示；
- 安装时可能执行 package lifecycle script 的提示。

目录中的 `install` 字段、文档命令或任意命令字符串都不会被执行。Host 会独立把经过校验的 package identity 解析为精确 SemVer 版本，或把规范仓库身份解析为不可变 commit。目标可变、未解析或重新校验时发生变化，安装都保持禁用。启用安装前，解析、重新校验和引用规则必须由测试锁定。

在 Desktop 中，Market Host 会使用 `dsh-plugin-desktop` 已提供的公开服务：

1. 从 `desktopProfiles.current` 读取当前身份。
2. 调用 `desktopPnpm.runPlugin()`，传入 `add` 操作、明确的绝对 invoking directory 和 `AbortSignal`。
3. 向界面输出有界进度，但不暴露环境变量或命令内部细节。
4. 同一时间只允许一个修改操作。
5. 区分非零退出、signal、取消、服务释放和 profile 重启。
6. 成功后明确提示用户：重启 Desktop 后新插件才会加载。

没有 Desktop 服务时，第一版仍可只读浏览，并说明为什么不能安装。它不会退回 ambient `pnpm`、shell 命令或猜测的 `dsh` executable。未来若支持普通 DSH 安装，必须先有同等 profile 与取消语义的正式 Host 能力。

## Profile 行为

- 当前 profile 是唯一安装目标。
- 已安装状态查询也按当前 profile 隔离。
- 确认框再次显示 profile 名称，目标不能隐含。
- 切换 profile 继续由 `desktopProfiles.select()` 管理，并通过已有的受控重启生效。
- 市场不会在后台修改未激活 profile。
- profile 切换或服务释放时，必须先取消或等待自己拥有的操作，再结束插件 generation。

会话和记录不属于市场职责。市场不会承诺任意自定义 profile 共享存储，只负责报告和修改选中 profile 的插件成员。

## 失败处理

| 情况 | 用户看到什么 | 副作用 |
| --- | --- | --- |
| 离线、超时、非 200、响应过大或格式非法 | 目录暂不可用，并提供重试 | 无 |
| 未知或不安全的仓库身份 | 禁用安装并说明原因 | 无 |
| 缺少 Desktop 安装能力 | 可以浏览，但安装不可用 | 无 |
| 用户取消确认 | 返回详情页 | 无 |
| 安装取消或失败 | 有界错误摘要和重试入口 | 不自动进行第二次尝试 |
| 安装成功 | 提示需要重启 | 当前 profile 已由受管服务完成 reconcile |

面向用户的错误或遥测中，不得包含原始响应 body、文件路径、token、环境变量或命令字符串。

## 交付阶段

### Phase 0：文档初始化工程

- 确认 npm 名称和 monorepo package 边界。
- 记录目录来源、信任规则和集成决策。
- package 保持私有且不可加载。

### Phase 1：只读市场壳

- Host 与 Client 插件入口。
- 用户拥有的来源选择、标准来源、经审查的合作方适配器与严格标准化。
- 带来源证据与部分失败处理的多来源隔离查询。
- 搜索、分类、详情和完整状态处理。
- headless 单元测试与 Loader smoke；不包含安装器。

### Phase 2：确认后安装到当前 profile

- 可选 Desktop 能力检测。
- 精确目标推导和两步用户意图。
- 受管、可取消、串行化的操作与重启说明。

### 后续工作

- 已安装状态详情、卸载、更新与失败恢复。
- 基于独立规范证据的更强验证信号。

## 来源与独立性

本设计参考了多个社区目录项目，其中包括 [imsai-sh/awesome-deepseek-harness-plugins](https://github.com/imsai-sh/awesome-deepseek-harness-plugins)，该项目也以 DSH 1024Store 展示。DSH 1024Store 是当前合作的提供方，并另行发布 `dsh-1024store` 插件。DSH Community Market 不是该插件的 fork、重新打包版本或官方客户端。其应用代码使用 MIT，目录元数据使用 CC0-1.0。当前初始化工程没有复制其代码或素材，也没有打包目录快照。

DSH Community Market 是 Anywhere Labs 的独立项目。目录收录不表示 Anywhere Labs、DSH 1024Store、DeepSeek 或插件作者对项目作出推荐。
