# 调研：成熟插件框架的设计模式

[English](mature-plugin-frameworks.md) | 中文

状态：研究记录，2026-08-17。本文是 DSH Community Fabric 的设计输入，不是已经发布的 Fabric API。

## 1. 问题与方法

Fabric 不能只有一份 manifest。它还要长期解决生命周期所有权、依赖协商、UI 扩展、业务事件、权限、多运行环境和开发工具。

我们阅读了三类成熟系统的一手文档：

- [Koishi 插件生命周期](https://koishi.chat/zh-CN/guide/plugin/lifecycle)、[服务与依赖](https://koishi.chat/zh-CN/guide/plugin/service)和[事件分发](https://koishi.chat/zh-CN/api/service/events.html)；
- [Chrome 扩展权限声明](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions)、[运行时可选授权](https://developer.chrome.com/docs/extensions/reference/api/permissions)、[消息通信](https://developer.chrome.com/docs/extensions/develop/concepts/messaging)、[Service Worker 生命周期](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)和[扩展 UI](https://developer.chrome.com/docs/extensions/develop/ui)；
- [VS Code 扩展结构](https://code.visualstudio.com/api/get-started/extension-anatomy)、[Contribution Points](https://code.visualstudio.com/api/references/contribution-points)、[扩展能力](https://code.visualstudio.com/api/extension-capabilities/overview)、[Web 扩展](https://code.visualstudio.com/api/extension-guides/web-extensions)和[Webview](https://code.visualstudio.com/api/extension-guides/webview)。

它们解决的问题并不相同。我们的目标不是照抄某一个框架，而是找出对 DSH GUI、Web UI、TUI、启动器和未来隔离运行时都成立的模式。

## 2. 每个框架最值得借鉴的部分

### 2.1 Koishi：Context 同时管理依赖和副作用

Koishi 最值得借鉴的不是某个具体事件名，而是每次插件激活都会得到一个拥有注册项和副作用的 Context。

- `ctx.on()`、命令、中间件和子插件会随这次激活一起释放。
- 插件可以动态启用、停用、重载，也可以反复激活。
- 必需服务未就绪时插件不会提前运行；必需服务更换时，相关功能会回滚后重新激活。
- 可选服务不会绑住整个插件的生命周期。
- `ctx.inject()` 可以让插件中的某一项功能拥有比整个插件更窄的依赖范围。
- 服务提供者和消费者相互分离，同一个服务 contract 可以由不同插件实现。
- 并行、串行和取第一个结果是不同的事件分发方式，并没有假设所有事件都具备相同语义。

这正好解决生态里的真实问题：HMR、profile 重组、服务替换或应用退出后，插件不能遗留监听器、路由、定时器、工具或 UI 注册项。

Fabric 应直接吸收：

1. 激活范围内的资源所有权；
2. 必需与可选服务协商；
3. 把服务替换视为明确的生命周期变化；
4. 更窄的子激活范围；
5. 为观察和决策流程定义不同的分发 contract。

Fabric 不应直接暴露：

- 可以任意查询服务的 Cordis/Koishi 原始 Context；
- 把 TypeScript declaration merging 当成公开兼容 contract；
- 把同进程服务访问描述成安全权限。

Fabric 应根据 manifest 生成最小的强类型上下文。Broker 内部可以使用 Cordis，但插件面对的 contract 必须独立于 Cordis 和 DSH 版本。

### 2.2 Chrome：静态意图、运行环境分离、受控通信

Chrome 扩展把身份、入口、UI、权限和站点访问写进 `manifest.json`，工具无需执行代码就能检查。必需权限和可选权限是两件事；可选访问可以等用户真正触发功能时再申请，让宿主有机会解释为什么需要它。

Chrome 还把一个扩展拆成多个协作运行环境：

- 事件驱动的 Service Worker；
- 运行在符合条件页面上的 Content Script；
- Popup、设置页、Side Panel 等扩展页面；
- 这些环境之间的一次性消息或长连接。

Service Worker 空闲时可能被终止，因此持久状态必须放在 storage，而不是全局变量。这种纪律即使在第一版常驻插件中也很有价值：代码天然更容易重启、重连，并为未来隔离做好准备。

Fabric 应直接吸收：

1. 用一份静态 manifest 作为检查和授权的唯一信源；
2. 区分必需授权与可选授权；
3. 明确定义不同运行 face，并用可序列化消息通信；
4. 将持久状态放在短生命周期运行时之外；
5. 敏感或打扰用户的操作必须靠近用户动作；
6. UI 位置由宿主管理，插件不能任意修改产品外壳。

Fabric 必须说明：

- capability 声明只是请求，宿主支持、用户授权和技术强制执行是三个额外事实；
- Chrome 的安全性来自浏览器进程与 Origin 隔离。只复制 manifest 字段，不会让同进程 Node 插件得到相同保护；
- Fabric 需要的是 session、workspace、工具执行、模型和 profile 等 DSH scope，而不是网址匹配规则。

### 2.3 VS Code：先声明贡献，再绑定实现

VS Code 把三件事分开：

1. **Contribution Points** 静态声明命令、设置、视图、菜单、主题等可发现对象；
2. **Activation** 决定何时真的加载扩展代码；
3. **运行时 API** 把 handler 或 provider 绑定到声明过的 ID。

例如命令标题和身份只声明一次，代码只为这个 ID 注册 handler。市场、设置页、命令面板和运行时就不会各自维护一份容易漂移的元数据。

VS Code 的 UI 也有不同层级：

- 命令、设置、通知、状态项、树和文件选择器等受限的原生界面；
- 为更复杂的产品界面提供强类型 provider；
- 原生 API 不够时才使用能显示任意 HTML 的 Webview。

Webview 在独立上下文中运行，通过消息与扩展通信。VS Code 明确建议谨慎使用，因为它消耗更多资源，也很容易破坏产品一致性、无障碍和主题体验。扩展不能直接操作 Workbench DOM。

Web 扩展还有一个重要经验：`main` 和 `browser` 是不同运行 face。只有声明式贡献的扩展甚至可以不包含可执行代码；浏览器入口也不能使用 Node API。

Fabric 应直接吸收：

1. 静态贡献元数据 + 按稳定 ID 绑定运行时实现；
2. 优先使用宿主拥有的强类型 UI，再开放自定义富 UI；
3. 富 UI 使用隔离视图、消息通信、主题、无障碍和资源策略；
4. Host 与 Client/Worker 分开入口，而不是一个 bundle 假设所有环境都一样。

Fabric 明确不在 v0.1 采用 VS Code 的按需激活策略。Host 在组装一次 runtime generation 时激活所有已选中、已授权的插件；contribution 只负责静态发现，subscription 只控制事件投递，两者都不会成为首次使用时的隐式激活触发器。

Fabric 不应照抄：

- VS Code 的 Workbench 布局和编辑器对象模型；
- 把任意 HTML 当作所有 UI 功能的默认答案；
- 把某个产品的 `when` 条件词汇直接当成跨宿主标准。
- 在没有真实需求和确定跨 Host 语义前引入按需激活。

## 3. Fabric 的组合设计结论

| 问题 | 借鉴模式 | Fabric 中的含义 |
| --- | --- | --- |
| 身份与兼容性 | Chrome/VS Code 静态 manifest | 用 schema 描述身份、API 范围、face、依赖、权限、订阅和贡献。 |
| 依赖 | Koishi 必需/可选服务 | capability 协商和窄激活范围，不提供通用服务定位器。 |
| 清理与 HMR | Koishi Context/Fork | 所有注册和操作都属于一次激活，自动释放或取消。 |
| UI 发现 | VS Code Contribution Points | manifest 统一拥有 ID、标题、位置请求、设置 schema 和兼容信息。 |
| 富 UI | VS Code Webview + Chrome 扩展页 | 隔离的 view face、消息协议、CSP/资源策略、主题 token、无障碍和宿主位置。 |
| 多运行环境 | Chrome scripts/pages + VS Code main/browser | 分离 Host、Client 和未来 Worker face，由 Broker 管理跨 face 通信。 |
| 敏感访问 | Chrome 必需/可选权限 | 把支持、请求、授权和强制执行分开，并在用户意图附近申请最小 scope。 |
| 可重启性 | Chrome 短生命周期 Worker | 持久状态进入宿主 storage；事件处理能应对重启、重连和 replay。 |
| 业务事件 | Koishi 的多种分发模式 | 分开观察流、命令、拦截器和上下文贡献流程。 |

## 4. UI 应有四层，而不是一个万能 renderer

一个 `panel.render()` 无法同时承载设置开关、Diff renderer、命令面板、文件上传、完整侧栏工作台、富交互回复和 TUI。

Fabric 应定义四层 UI：

### 第 1 层——声明式贡献

用于命令、设置 schema、菜单、状态项、主题 token、通知和简单表单。宿主负责渲染、国际化、无障碍、顺序和冲突提示。有些插件可以完全没有 Client 代码。

### 第 2 层——强类型 Provider 和命名 Renderer

用于输入输出有稳定业务含义的界面：工具结果 renderer、消息内容 renderer、输入框附件、文件查看器、会话树、模型或设置卡片。Provider 绑定到声明过的 ID，接收标准 DTO，而不是产品内部组件。

每个扩展点都要规定数量、优先级、fallback、冲突、生命周期、错误边界和宿主覆盖范围。替换一个 renderer 和插入一个 panel 不是同一种操作。

### 第 3 层——隔离的富视图

用于看板、GenUI、复杂编辑器、可视化或完整侧栏工作台。插件提供运行在隔离 frame 或等价宿主容器中的 Client/Worker view bundle，只能使用版本化消息桥和被批准的资源。

contract 必须覆盖 CSP、资源 URL、导航、尺寸、焦点、键盘、主题 token、国际化、无障碍、持久化、崩溃恢复和消息 schema。TUI 可以拒绝这个 capability，或只提供自己的宿主扩展。

### 第 4 层——宿主专属扩展

原始 DOM、Electron、原生控件、终端转义协议和宿主特定组合都属于组织命名空间下的 `x-*` capability。它们可以有文档，但市场不能把它们展示成可跨宿主运行。

Fabric 以后可以定义一个非常小的跨宿主 UI 描述，只包含文本、列表、按钮、输入和基础表单；绝不能承诺任意 GUI 都能在 TUI 中无损运行。

## 5. 业务行为需要多种协议，而不是一个事件总线

### 5.1 不可变观察流

例如消息收到、会话创建、工具开始、工具结束。观察者不能改变原操作。每个 contract 都要定义 payload schema、隐私 scope、事件身份、scope 内顺序、replay 边界、背压、错误隔离和退出行为。

### 5.2 命令和动作

例如发送消息、恢复会话、选择模型、打开文件或执行已声明命令。它们是带授权、取消、幂等、稳定错误、审计信息和明确所有者的 request/result 操作，不是伪装成事件的方法调用。

### 5.3 有序拦截器流程

例如工具审批或 `before-send` 策略。拦截器可以允许、拒绝，或返回范围很窄的重写。contract 必须规定确定性顺序、超时、失败策略、冲突、来源、重入以及后续拦截器看到的内容。它需要单独 RFC，不能在没有语义时直接稳定。

### 5.4 上下文贡献流程

例如记忆、系统指令和每轮策略。插件提交带来源、优先级、隐私等级、过期时间和 token 预算的有限片段，由宿主收集、校验、排序并冻结。插件不能共同修改一个共享 prompt 对象，也不能 patch 内部 prompt builder。

### 5.5 持久任务与工作流

长期自动化需要任务 ID、checkpoint、进度、取消、重试策略、所有者和重启重连行为。一个内存 listener 加定时器不能成为工作流 contract。

## 6. 目标开发体验

三个系统最有价值的部分可以组成一个简单的开发模型：

```text
manifest：声明身份、face、依赖、权限、订阅和贡献
代码：    为声明过的 ID 绑定 handler 和 provider
SDK：     只以强类型 API 暴露已协商 capability
Broker：  管理清理、跨 face 消息、授权、错误和审计
Adapter： 把稳定 contract 翻译到固定版本的 DSH runtime
testkit： 校验 manifest，并运行和宿主相同的生命周期/capability fixture
```

对于常见功能，开发者不应再导入 DSH 源码、猜 Cordis 服务名、编辑 patch 文件、创建私有 HTTP 路由或修改产品 DOM。标准流程应该是：创建脚手架 → 声明 → 实现 → 在 fake Host 测试 → 用开发 Adapter 联调 → 打包。

## 7. 这次调研会改变什么

Fabric 仍应保持 v0.1 很小，但架构必须预留正确接缝：

1. 保留当前 manifest、协商、生命周期、`storage.local`、`commands` 和不可变观察基线；
2. 为运行 face 与跨 face 消息单独设计后续规范；
3. 把 UI 拆成贡献、Provider、富视图和宿主扩展四层；
4. 把业务行为拆成观察、动作、拦截器、上下文贡献和任务协议；
5. 权限使用支持/请求/授权/强制执行四阶段模型；
6. 激活范围和自动清理是不可让步的基础；
7. 永远不把上游 Cordis Context 或 DSH 内部对象作为兼容 API 暴露。

独立的 [VS Code 扩展模型调研](vscode-extension-model.zh.md)会根据官方文档与样例，进一步展开 contribution、Provider、UI、运行位置、生命周期和仲裁模式；[DSH 插件需求调研](dsh-plugin-needs.zh.md)再用真实社区插件检验汇总后的结论。
