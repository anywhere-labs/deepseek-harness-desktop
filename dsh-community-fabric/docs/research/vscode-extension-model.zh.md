# 调研：VS Code 扩展模型及其对 Fabric RFC 的价值

[English](vscode-extension-model.md) | 中文

状态：源码与官方文档调研，2026-08-17。本文是 DSH Community Fabric 的设计输入，不代表已经发布的 Fabric API。

## 1. 调研范围

VS Code 值得参考，不是因为 DSH 要变成代码编辑器，而是因为 VS Code 已经长期解决了三类与 DSH 很相似的问题：

1. 如何让插件在不修改产品源码和 DOM 的前提下扩展命令、设置、视图和业务能力；
2. 如何把静态可发现的功能声明与运行时实现分开；
3. 如何让本地、浏览器和远程环境中的扩展使用同一套产品 API，而不共享内部对象。

本次调查只使用微软官方资料：

- [Extension Manifest](https://code.visualstudio.com/api/references/extension-manifest)、[Extension Anatomy](https://code.visualstudio.com/api/get-started/extension-anatomy)与[Contribution Points](https://code.visualstudio.com/api/references/contribution-points)；
- [Extension Capabilities](https://code.visualstudio.com/api/extension-capabilities/overview)、[Extension Host](https://code.visualstudio.com/api/advanced-topics/extension-host)、[Remote Extensions](https://code.visualstudio.com/api/advanced-topics/remote-extensions)与[Web Extensions](https://code.visualstudio.com/api/extension-guides/web-extensions)；
- [Webview](https://code.visualstudio.com/api/extension-guides/webview)、[Workspace Trust](https://code.visualstudio.com/api/extension-guides/workspace-trust)、[Extension Runtime Security](https://code.visualstudio.com/docs/configure/extensions/extension-runtime-security)与[Proposed API](https://code.visualstudio.com/api/advanced-topics/using-proposed-api)；
- 微软官方 [`vscode-extension-samples`](https://github.com/microsoft/vscode-extension-samples/tree/3d8442b16c7f353779e266f16295703b2b4a6dcc) 仓库的固定快照。

我们只阅读文档、manifest 和源码，没有安装依赖或执行样例扩展。

## 2. VS Code 实际提供了哪些功能

VS Code 的扩展能力不是一个万能 API，而是由静态声明、激活、运行时 API 和 Extension Host 四部分组成。

```text
package.json / contributes
  ↓ 静态发现、索引、展示和兼容判断
activation
  ↓ 在真正需要功能时加载代码
register handler / provider
  ↓ 为声明过的 ID 绑定实现
Extension Host
  ↓ 隔离产品 UI，并选择本地、Web 或远程执行位置
```

### 2.1 Manifest 与兼容信息

每个扩展以根目录 `package.json` 为 manifest。除了名称和版本，它还可以声明：

- `engines.vscode`：兼容的 VS Code API/产品范围；
- `main` 与 `browser`：Node 和 Web Worker 入口；
- `contributes`：命令、设置、视图、主题、任务、工具等静态贡献；
- `activationEvents`：何时需要加载扩展；
- `extensionKind`：更适合靠近 UI 还是 workspace 运行；
- `extensionDependencies` 与 `extensionPack`：功能依赖和组合安装；
- `capabilities.untrustedWorkspaces` 与 `virtualWorkspaces`：受限环境中的支持程度。

这使市场和 Host 可以在不执行扩展代码时理解它的大部分外观和运行要求。

### 2.2 静态 Contribution Points

[Contribution Points](https://code.visualstudio.com/api/references/contribution-points)覆盖的能力可以按产品目的归纳为：

| 类别 | 已实现的典型功能 | 设计特点 |
| --- | --- | --- |
| 命令与导航 | `commands`、`menus`、`submenus`、`keybindings` | ID、标题和位置先声明；代码只绑定 handler。 |
| 设置与条件 | `configuration`、`configurationDefaults`、`when` 条件 | Schema 同时驱动校验、编辑器提示和设置 UI。 |
| 产品 UI | `views`、`viewsContainers`、`viewsWelcome`、`customEditors`、主题、颜色与图标 | Host 拥有布局和渲染；插件贡献元数据或 Provider。 |
| 工作执行 | `taskDefinitions`、`terminal`、`debuggers`、`problemMatchers` | 先声明可发现的类型，再由运行时 Provider 创建实例。 |
| 语言与文档 | `languages`、`grammars`、`snippets`、semantic token 类型 | 简单能力可以纯声明，无需可执行代码。 |
| 认证与 Provider | `authentication`、语言模型聊天 Provider | Host 统一展示和选择 Provider。 |
| Agent 与 AI | Agent、instructions、prompt、skill、language model tool 等贡献 | 静态描述名称、输入和用途，再绑定受控执行实现。 |
| 上手与教育 | `walkthroughs` | 安装后由 Host 展示步骤和完成条件。 |

这份列表最重要的结论不是 Fabric 也要一次实现几十个扩展点，而是：每种扩展点都有单独的 schema、ID、生命周期、位置、条件和运行时绑定规则。

### 2.3 运行时 handler 与 Provider

声明只描述“有什么”。真正的行为由运行时 API 提供：

| 模式 | VS Code 示例 | 为什么有价值 |
| --- | --- | --- |
| Handler | `commands.registerCommand(id, handler)` | 一个声明 ID 只有一条明确执行路径。 |
| Data Provider | `registerTreeDataProvider(viewId, provider)` | Host 渲染树；插件只提供结构化数据和刷新事件。 |
| Domain Provider | completion、hover、task、debug、test、SCM、filesystem Provider | 每个领域拥有自己的输入、输出、取消和组合语义。 |
| Controller | Test Controller、Source Control 等 | Host 持有用户体验，插件管理受限的领域对象。 |
| Codec / Controller / Renderer | Notebook Serializer、Controller 与 MIME Renderer | 数据格式、执行和呈现可以由不同 contract 与运行环境承担。 |
| Rich View bridge | Webview `postMessage` / `onDidReceiveMessage` | 自定义 UI 与扩展进程之间只传消息，不共享 DOM 或对象。 |

大量注册 API 返回 `Disposable`，长操作接收 `CancellationToken`。扩展把这些资源加入 `ExtensionContext.subscriptions`，停用时统一释放。

### 2.4 冲突和仲裁按领域定义

VS Code 没有用“后注册覆盖前注册”处理所有冲突，而是根据领域选择不同规则：

- command、authentication provider、filesystem scheme 等要求唯一所有者，重复注册失败；
- 一些语言 Provider 会合并多个结果；
- 一些 Provider 按 selector 匹配度选择最佳实现；
- 多个 Custom Editor 同时匹配时，可以交给用户选择并保存默认项；
- 快捷键由 Host、扩展建议值和用户配置共同决定。

Fabric 不必复制 VS Code 的具体 selector 分数，但每项 capability 或 contribution 都必须明确：cardinality、selector、priority、merge / first-result / pipeline / user-choice、同优先级 tie-break、错误隔离、超时、取消、重复注册和热替换。加载顺序不能成为未写明的仲裁规则。

### 2.5 UI 能力的层次

VS Code 提供了一条明确的 UI 升级路径：

1. 命令、菜单、设置、通知、Quick Pick、状态栏等原生 UI；
2. Tree View、Test Controller、SCM 等由 Host 渲染的 Provider UI；
3. 原生能力不够时才使用 Webview 或 Custom Editor。

官方明确禁止扩展访问 Workbench DOM 或注入自定义样式，并建议仅在必要时使用 Webview。Webview 运行在独立上下文，通过消息与扩展通信，还要处理 CSP、资源 URI、主题、无障碍、状态恢复和释放。

这与 Fabric 已提出的“声明式贡献 → 强类型 Provider/Renderer → 隔离富视图 → Host 私有扩展”四层模型高度一致。

### 2.6 运行位置与多环境

[Extension Host](https://code.visualstudio.com/api/advanced-topics/extension-host)可以是：

- 本地 Node.js Host；
- 远程 Node.js Host；
- 浏览器/Web Worker Host。

扩展通过 `main` 或 `browser` 提供不同入口，通过 `extensionKind` 表达靠近 UI 或 workspace 的运行偏好。远程模式中，UI 和 workspace 可能在不同机器；扩展不能假设本地路径、进程和 UI 位于同一环境。

这个经验直接支持 Fabric 将 Host、Client、Worker 和 Rich View 定义为不同 runtime face，并规定它们只能通过版本化 DTO、RPC、stream 和 asset channel 通信。

VS Code 的 Virtual Workspace 和 FileSystemProvider 还说明，资源不一定是本地绝对路径。Fabric 的 portable resource contract 应使用 URI、opaque resource ID 和 Host-mediated file/artifact capability；只有明确的本地 Host 扩展才可以承诺真实磁盘路径。

### 2.7 生命周期、状态与取消

VS Code 在需要某项功能时才激活扩展。命令、View、语言、文件系统、任务等 contribution 可以触发对应 activation；新版 VS Code 还能从部分 contribution 自动推导激活条件，避免作者重复维护两份声明。

扩展获得 workspace/global state、文件目录和 SecretStorage。它需要把注册资源放进 subscriptions，并在 `deactivate` 中处理额外清理。

Fabric 要借鉴资源 ownership，但不能照搬“一次 Extension Host 会话只激活一次”的假设。DSH profile 重组、Provider 更换、HMR 和恢复都要求同一个插件能够重复 activate/dispose。

### 2.8 信任和安全事实

VS Code 的 Workspace Trust 可以声明扩展在不可信 workspace 中：

- 完全支持；
- 完全禁用；
- 只提供有限功能，并屏蔽危险的 workspace 配置。

但微软同时明确说明：桌面 Node Extension Host 拥有和 VS Code 本身相同的文件、网络和进程权限。Extension Host 能隔离 UI 和部分故障，不等于插件已经进入权限沙箱。

因此 Fabric 必须继续区分：

```text
Host 支持 capability
≠ 插件声明请求
≠ 用户或策略授权
≠ 技术强制隔离
≠ 市场安全审核
```

此外，发布者信任、插件能力授权、profile/workspace 内容信任也应是不同状态。

### 2.9 版本、实验 API 与工具链

VS Code 对稳定 Extension API 尽力保持向后兼容。不稳定 Proposed API 只能在 Insiders/开发环境中显式启用，不能作为普通 Marketplace 扩展依赖。

开发工具覆盖脚手架、类型、Extension Development Host、单元/集成测试、Web 测试、VSIX 打包和发布。Workspace Trust 还要求分别测试 trusted/untrusted 状态。

Fabric 应保留比 VS Code 更清晰的多轴版本：插件、manifest schema、Fabric API、capability/event、Host 产品、SDK 和 Adapter 不能被压成一个产品版本号。

## 3. 官方样例证明了什么

以下样例来自微软官方仓库固定 commit [`3d8442b`](https://github.com/microsoft/vscode-extension-samples/tree/3d8442b16c7f353779e266f16295703b2b4a6dcc)：

| 样例 | 实现模式 | Fabric 可验证的启示 |
| --- | --- | --- |
| [Hello World](https://github.com/microsoft/vscode-extension-samples/tree/3d8442b16c7f353779e266f16295703b2b4a6dcc/helloworld-sample) | Manifest 声明命令，代码按相同 ID 注册 handler 并保存 Disposable。 | contribution 与实现分离应是规范，不是风格建议。 |
| [Tree View](https://github.com/microsoft/vscode-extension-samples/tree/3d8442b16c7f353779e266f16295703b2b4a6dcc/tree-view-sample) | Manifest 声明容器、视图、命令、菜单和设置；代码提供 TreeDataProvider。 | 复杂侧栏不必先开放 DOM；先定义领域 Data Provider。 |
| [Webview View](https://github.com/microsoft/vscode-extension-samples/tree/3d8442b16c7f353779e266f16295703b2b4a6dcc/webview-view-sample) | Manifest 声明 View；代码注册 WebviewViewProvider。 | Rich View 仍有稳定 ID、Host placement 和 Provider 生命周期。 |
| [Custom Editor](https://github.com/microsoft/vscode-extension-samples/tree/3d8442b16c7f353779e266f16295703b2b4a6dcc/custom-editor-sample) | 文档模型与 Webview 分离，通过消息同步并接入 save/undo/redo。 | 富 UI 不能绕过标准领域模型和操作语义。 |
| [File System Provider](https://github.com/microsoft/vscode-extension-samples/tree/3d8442b16c7f353779e266f16295703b2b4a6dcc/fsprovider-sample) | 注册 URI scheme 和受控文件系统 Provider。 | 插件应实现 capability SPI，不应直接把内部存储对象交给其他插件。 |
| [Task Provider](https://github.com/microsoft/vscode-extension-samples/tree/3d8442b16c7f353779e266f16295703b2b4a6dcc/task-provider-sample) | Manifest 定义 task schema，代码发现和解析 task，操作带取消信号。 | 任务定义、实例发现、执行和取消需要独立 contract。 |
| [Test Provider](https://github.com/microsoft/vscode-extension-samples/tree/3d8442b16c7f353779e266f16295703b2b4a6dcc/test-provider-sample) | Host 提供 Test UI，插件维护测试树、运行 profile 和结果。 | Provider 可以承载复杂业务，而无需让插件控制整个 UI。 |
| [Chat 与工具](https://github.com/microsoft/vscode-extension-samples/tree/3d8442b16c7f353779e266f16295703b2b4a6dcc/chat-sample) | Manifest 声明 Chat/Tool 元数据，运行时绑定 handler/tool，并接收取消与确认流程。 | DSH tool、agent、renderer 也应采用静态声明 + typed runtime binding。 |

这些样例共同说明：真正可持续的扩展平台不是提供一个可以拿到所有内部对象的 `ctx`，而是不断积累边界清晰的领域 contract。

## 4. 对 Fabric RFC 的直接参考价值

### 4.1 把 contribution 与实现绑定提升为核心原则

RFC 应明确：

- Manifest 是命令、设置、菜单、View、Renderer、Tool 等可发现元数据的唯一权威来源；
- 插件代码只能为已声明 ID 绑定 handler 或 Provider；
- 每种 contribution 单独定义 schema、ID、冲突、数量、条件、fallback 和生命周期；
- 市场和 Host 不执行插件即可展示功能与兼容性。

当前 RFC 的 `commands` 已经符合这个方向，后续所有标准扩展点都应沿用同一模式。

### 4.2 分开激活策略、业务事件和拦截器

VS Code 的 Activation Event 只回答“何时加载插件”，并不代表插件可以修改业务流程。Fabric 仍应分开：

- `contributes`：插件未运行时 Host 已经知道什么；
- Host activation policy：已选中、已授权插件何时进入 activation scope；
- `subscriptions`：active 插件会收到哪些事件；
- observation：激活后能观察什么；
- action：激活后能请求什么；
- interceptor：激活后能按受控顺序修改什么。

Fabric 明确不在 v0.1 采用按需激活。Host 在组装一次 runtime generation 时激活所有已选中、已授权的插件；已声明的 command、Provider 和 subscription 都不会在首次使用时隐式触发 activation。这样更符合当前 DSH 组合方式，也能避免漏事件、首次调用延迟，以及不同 Host 出现不一致的激活顺序和故障提示。只有后续 RFC 拿出真实启动数据和一致性测试后，才重新讨论按需激活。

### 4.3 Provider 优先于万能事件和万能 Panel

Tree、Task、Test、Debug、SCM、Language、Tool 都使用领域 Provider，而不是让插件监听一个字符串事件后操作产品内部对象。

Fabric 应为真实高频需求逐项定义 Provider/Renderer：

- session tree；
- message/tool result renderer；
- composer attachment；
- file viewer；
- model/search provider；
- task/job；
- package transaction。

每个 Provider 都必须有输入输出 DTO、取消、并发、排序/仲裁、错误和 teardown 语义。

### 4.4 Runtime face 与运行位置必须单独建模

VS Code 的 local/web/remote 经验说明，运行位置不是简单 platform 字段。Fabric 后续 Runtime Faces RFC 应定义：

- 每个 entrypoint 的 runtime 类型；
- capability 在哪个 face 可用；
- 靠近 UI、workspace/profile、DSH runtime 或隔离计算的位置要求；
- 跨 face RPC/stream 的身份、schema、取消、超时、断线和资源限制；
- 不允许跨 face 或跨插件直接传任意 JavaScript 对象。

### 4.5 正式定义同步与异步释放

Fabric 可采用比 VS Code 更严格的释放顺序：

1. `ctx.signal` 先 abort；
2. Broker 停止接受新 operation；
3. 在有界时间内等待 in-flight operation drain；
4. 按逆序执行 Disposable / AsyncDisposable；
5. 调用显式 deactivate；
6. 超时后隔离故障并记录未释放资源。

这应成为 Broker 和 testkit 的一致性要求。

### 4.6 增加内容信任维度

未来的 Project/Profile Trust 不应混入普通 capability grant。例如插件获准使用 `process.run`，不代表它可以自动执行未信任仓库中的脚本。

至少要区分：

- 插件发布者是否可信；
- 插件请求的 capability 是否获批；
- 当前 profile/workspace 内容是否可信；
- 某次敏感操作是否得到用户意图确认。

这不必进入 v0.1，但 manifest、Host Descriptor 和 Broker 不能封死这个维度。

### 4.7 为 experimental API 建立正式通道

建议借鉴 Proposed API：

- experimental capability 必须显式声明；
- 只能由开发 Host 或明确允许实验 API 的 Host 启用；
- 稳定市场渠道默认拒绝；
- 类型和 fixture 固定到具体 proposal 版本；
- 成熟后进入稳定命名空间，不能悄悄改变已有 contract。

## 5. 不应该照搬的部分

| VS Code 设计 | Fabric 不应直接照搬的原因 |
| --- | --- |
| 全局 `vscode` API namespace | Fabric 需要根据 manifest 生成最小 context，未声明 capability 不应出现在标准 SDK 中。 |
| `engines.vscode` 单轴兼容 | Fabric 有多个独立 Host，必须分开 API、capability、Host、SDK 和 Adapter 版本。 |
| 任意字符串 `when` context | 初期只应提供少量、版本化、Host-owned 的条件键，避免形成另一套无法跨 Host 的表达式语言。 |
| `extensionDependencies` 只按扩展 ID | Fabric 的服务依赖需要 required/optional、版本范围、Provider 仲裁和动态生命周期。 |
| Node Extension Host 等同安全隔离 | 它仍拥有文件、网络和进程权限；真正隔离需要受控模块和 IPC。 |
| 编辑器专属布局与对象模型 | Editor Group、文档 selection、调试协议等不能直接成为 DSH 跨 Host 标准。 |
| 所有功能都进入首版 | VS Code 的能力经过多年逐项定义；Fabric v0.1 应继续保持小范围。 |

## 6. 对 RFC 0001 的建议修改

### 现在可以纳入 RFC 0001

1. 将“静态 contribution + 稳定 ID 的运行时绑定”提升为核心不变量；
2. 明确所有已选中、已授权插件在 generation 组装时主动激活；contribution 与 subscription 都不是激活触发器；
3. 区分 Host 激活策略、业务 subscription、observation、action 和 interceptor；
4. 规定 activation-scoped Disposable / AsyncDisposable 和有界 drain；
5. 保留 Fabric 的重复 activation，适配 profile 重组和 Provider 更换；
6. 明确执行进程/Extension Host 是故障边界，不自动等于安全边界；
7. 定义 experimental capability 进入稳定标准的流程；
8. 禁止插件通过标准 contract 导出跨插件任意对象 API。

### 应拆成后续独立 RFC

- Runtime Faces 与跨 face bridge；
- UI Contribution、Provider、Renderer、Rich View 和条件系统；
- Project/Profile Trust；
- Market 打包、签名、扫描和发布规范；
- 多 scope storage 与 Secret capability；
- Tool、Provider、任务和拦截器的领域语义。

### v0.1 仍然保持小范围

VS Code 调研不会把几十个扩展点一次塞进 Fabric v0.1。v0.1 仍只需要证明：

- Manifest、Host Descriptor 和 capability 协商；
- activation scope 与可重复释放；
- `commands` 的静态声明和 handler 绑定；
- `storage.local`；
- 不可修改的 `messages.observe`；
- fake Host 与固定 DSH Adapter 的一致性测试。

但 v0.1 的 schema、Broker 和 testkit 必须为上述后续领域 contract 留出正确位置，不能先暴露 DSH、Cordis、DOM 或 Loader 内部对象作为临时公共 API。

## 7. 结论

VS Code 对 Fabric 最重要的证明是：插件生态可以很强大，同时禁止插件直接修改产品源码和 UI DOM。实现这一点的关键不是一个万能 API，而是长期维护一组职责清楚、可静态声明、可测试、可取消、可释放的领域扩展点。

Fabric 应吸收这套工程纪律，同时保留自己的优势：多 Host capability 协商、重复 activation、版本化 Adapter、比 VS Code 更清晰的授权层次，以及未来可选的强隔离执行档位。
