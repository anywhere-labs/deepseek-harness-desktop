# DSH Community Market 市场壳设计

[English](market-shell.md)

状态：设计提案；当前只有文档初始化工程

本文定义 `dsh-community-market` 第一阶段的实现边界。它刻意比完整的插件市场更小：package 只负责产品内的市场壳和适配器，不负责社区目录、包 registry 或 DSH profile 格式。

## 产品目标

- 给用户一个安静、清晰的入口，用来发现、搜索和了解社区插件。
- 在用户明确选择操作前，目录浏览始终保持只读。
- 只安装到当前 profile，并在确认前展示插件来源和目标 profile。
- 复用现有 DSH 插件与 Desktop profile 行为，不创建平行状态。
- 让目录 provider 可以替换，避免界面永久绑定某一个服务。
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
    Catalog["远程目录 provider"] --> Host["Market Host 插件<br/>请求、限流、校验、标准化"]
    Host --> Route["普通 DSH route 或 RPC"]
    Route --> Client["Market Client 插件<br/>搜索、详情、确认"]
    Profiles["desktopProfiles<br/>当前 profile"] --> Host
    Pnpm["desktopPnpm<br/>受管插件操作"] --> Host
    Host -. "没有 Desktop 服务" .-> Browse["仍可只读浏览"]
```

renderer 只通过普通 DSH route 或 RPC 接收标准化纯数据，不会获得 Electron、文件系统、进程、`desktopRuntime` 或包管理器访问。Host 负责目录 I/O、校验、安装编排、取消和操作串行化。

## 目录 provider

第一个适配器计划接入 [DSH 1024Store](https://github.com/imsai-sh/awesome-deepseek-harness-plugins) 公开文档中的 registry 接口：

```text
GET https://deepseek1024.com/api/v1/registry
```

接口及其 schema 属于该独立项目，必须放在 provider 接口之后，不能变成 UI 的隐含假设。标准化快照只需要：

- 来源身份与来源页面；
- 目录更新时间；
- 带本地化名称和顺序的分类；
- 插件身份、名称、作者、仓库 URL、分类和本地化描述；
- stars 等可选展示信息。

远程字段只是展示数据，不是可执行指令。provider 必须限制为 HTTPS，设置超时和响应大小上限，校验 JSON 与严格 schema，保证 ID 唯一、字符串有界、仓库 URL 规范。未知字段直接忽略；文本只能按文本渲染，不能作为原始 HTML。

精简 registry 无法证明 package 所有权、安全审核、兼容性或维护者身份。界面必须始终展示目录来源，并明显说明“收录不等于推荐”。

## 只读浏览

Phase 1 提供：

- 加载、空目录、离线、非法响应和重试状态；
- 基于标准化名称与描述的本地搜索；
- 分类筛选；
- 包含源码仓库和目录来源的详情页；
- 缺少安装能力时的不可用说明。

加载目录时不会调用包管理器、解析本地 executable、修改 profile 或记录安装事件。目录错误也不会阻止 DSH 或 Desktop 启动。

## 安装边界

安装属于 Phase 2，并且只能由用户操作开始。执行前的确认必须展示：

- 插件名称；
- 规范化源码仓库；
- 精确推导出的安装目标；
- 当前 profile 名称；
- 插件会以用户权限在本地运行的提示；
- 安装时可能执行 package lifecycle script 的提示。

目录中的 `install` 字段、文档命令或任意命令字符串都不会被执行。对最初的 GitHub 目录，Host 会从经过校验的 `owner/repository[/sub/directory]` 身份推导唯一受支持的 GitHub dependency 形式。启用安装前，推导和引用规则必须由测试锁定。

在 Desktop 中，最初的适配器会使用 `dsh-plugin-desktop` 已提供的公开服务：

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
- 可替换目录 provider 与严格标准化。
- 搜索、分类、详情和完整状态处理。
- headless 单元测试与 Loader smoke；不包含安装器。

### Phase 2：确认后安装到当前 profile

- 可选 Desktop 能力检测。
- 精确目标推导和两步用户意图。
- 受管、可取消、串行化的操作与重启说明。

### 后续工作

- 已安装状态详情、卸载、更新与失败恢复。
- 多个目录 provider 和来源选择。
- 基于独立规范证据的更强验证信号。

## 来源与独立性

本设计参考 [imsai-sh/awesome-deepseek-harness-plugins](https://github.com/imsai-sh/awesome-deepseek-harness-plugins)，该项目也以 DSH 1024Store 展示，并另行发布 `dsh-1024store` 插件。DSH Community Market 不是该插件的 fork、重新打包版本或官方客户端。其应用代码使用 MIT，目录元数据使用 CC0-1.0。当前初始化工程没有复制其代码或素材，也没有打包目录快照。

DSH Community Market 是 Anywhere Labs 的独立项目。目录收录不表示 Anywhere Labs、DSH 1024Store、DeepSeek 或插件作者对项目作出推荐。
