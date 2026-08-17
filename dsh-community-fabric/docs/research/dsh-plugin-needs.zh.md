# 调研：DSH 插件开发者真正需要什么

[English](dsh-plugin-needs.md) | 中文

状态：源码调研，2026-08-17。本文记录观察到的需求和设计含义，不代表推荐、代码安全审查、兼容认证或稳定 Fabric API。

## 1. 方法与限制

我们使用了两组证据：

1. 公开的 [DSH 1024Store / awesome DeepSeek Harness 插件目录](https://github.com/imsai-sh/awesome-deepseek-harness-plugins)，快照为 commit [`415a2d0`](https://github.com/imsai-sh/awesome-deepseek-harness-plugins/tree/415a2d0a78c93b3671dc2718721e52f39f06fb96)，其自动生成 README 在 2026-08-17 列出 3,809 个仓库；
2. 对十二个开源插件做静态源码检查，覆盖 UI、工具、会话、记忆、模型、文件、外部集成、包管理和终端。

我们 clone 仓库并阅读 manifest、patch、Host/Client 入口、测试和文档，没有安装依赖或执行第三方插件代码。这是按功能选取的样本，不是随机统计；它可以说明需要哪些 contract，不能说明流行度或代码质量。

目录本身也证明了更强 manifest 的必要性：当前生成分类中有 65 个 UI 插件、81 个工具插件、51 个开发/运行时插件、24 个工作流插件、20 个会话/消息插件、19 个通知/集成插件、17 个记忆插件、7 个模型/provider 插件、6 个主题，以及 3,491 个仍待分类条目。只知道包名和 patch 文件，无法可靠判断兼容性、权限、运行 face、原生依赖或扩展点。

## 2. 代表性插件

| 插件 | 用户功能 | 当前实现方式 | 兼容层需求 |
| --- | --- | --- | --- |
| [DSH Better Sidebar](https://github.com/omdsh-dev/DSH-better-sidebar/tree/a673f2399f14c5cec8e1673511049721512e28ad) | 文件、编辑器、终端、Git 组成的完整工作台，并允许第三方注册 Tab 和文件查看器。 | Host/Client 双 face；私有 HTTP/WS 路由、UI slot、Client 服务注册、结构探测和原生 PTY。 | 版本化侧栏/Tab/文件查看器贡献、跨 face bridge、受控文件、进程/PTY 和冲突规则。 |
| [dsh-stylevault](https://github.com/GptsApp/dsh-stylevault/tree/b627f3a40c86cee9016d3749368479c08b5443b9) | 主题目录与实时外观编辑。 | Client theme API、设置 UI 和 localStorage；语义 token 不足时使用 DOM 观察和生成 class patch。 | 主题/token 贡献、声明式设置、持久 Client storage，以及明确的宿主专属 escape hatch。 |
| [dsh-session-export](https://github.com/bwndlct/dsh-session-export/tree/eb18389192e36934718877fd7c6eb397f5cf1cd4) | 用模型工具或斜杠命令导出会话。 | 读取内部 session event，并通过 Node fs 直接写工作区。 | 标准 transcript 投影、命令/工具、受控 artifact 导出、workspace scope 和用户可见结果。 |
| [dsh-memento](https://github.com/PerryLink/dsh-memento/tree/724ad2ec2853f136d9730858295d4d397f4711fc) | 长期记忆、工具、prompt 注入、审批和管理面板。 | 双 face；storage/tool 服务加内部事件词汇、结构化服务探测和原始 UI。 | 插件私有 storage、上下文贡献流程、工具/拦截器 contract、transcript read 和强类型管理 UI。 |
| [dsh-web-search-exa](https://github.com/TonyDua/dsh-web-search-exa/tree/083706bae60af8e1f3776b02448f17c140c3f571) | Exa 搜索 provider。 | 注册 Host search provider，使用 API key REST 或远端 MCP，provider ID 只能人工避冲突。 | Provider 注册/仲裁、secret reference、网络 scope、设置 schema、健康与 fallback 语义。 |
| [dsh-bash-terminal](https://github.com/MAXeaglet/dsh-bash-terminal/tree/6894913d71098f2ea24120d3a1afd5771f9ccd4a) | 模型 shell 工具和交互终端。 | Host subprocess/sandbox 服务、Client 设置行；官方接缝缺失时直接使用 node-pty。 | 进程、shell 环境、PTY 和 job capability，平台/原生 ABI 描述、进程树取消和明确 fallback 状态。 |
| [dsh-codex-auth](https://github.com/suntianc/dsh-codex-auth/tree/484f5383dc7a80df426ef817daf02a67d9c1dc45) | Codex 登录、模型、搜索、图片工具、用量和设置。 | 注册 LLM/search/tool provider，读取本地 auth，访问 provider，并自建 loopback RPC 给 Client UI。 | 模型/provider SPI、secret vault、网络 scope、媒体/文件、provider 冲突策略、强类型 Host↔Client bridge 和设置。 |
| [dsh-market](https://github.com/dsh-market/dsh-market/tree/5c4d8c25f0860d67755f719f5e149f99219fd79a) | 安装、更新、卸载、备份和管理插件/主题。 | 直接读写 profile manifest、lockfile 和 modules，调用 DSH/pnpm；部分热更新读取 Loader entry。Desktop 已提供更窄的 profile/package 服务。 | 事务化 profile/包管理、进度、锁、build-script 授权、回滚/重启，并禁止 raw Loader/Fiber 访问。 |
| [dsh-genui](https://github.com/omdsh-dev/dsh-genui/tree/4415bef7c15376b0b4cecc895fe26823840d0977) | 在助手回复中显示交互 UI，并把动作回传给模型。 | Host tool/system-prompt/assets；Client fence renderer/slots；旧 Host 上退回内部服务反射和 DOM 观察。 | 强类型内容 renderer、隔离富视图、版本化 action 消息、静态资源、上下文贡献和 feature negotiation。 |
| [dsh-notify-bark](https://github.com/pc439527/dsh-notify-bark/tree/26e229876312b18cc46b7a7ba04daa73e0226603) | 通过 Bark 推送 turn/tool/approval 通知。 | 监听内部 session event 名，保存设置，发出网络请求；第三方设置不对 Client 暴露时自建 RPC。 | 标准观察事件、通知策略、network/secret scope、去重、设置和标准 bridge。 |
| [dsh-files](https://github.com/taxueseek/dsh-files/tree/2c453ab3f74659f91a84a35f71ff270eea77e674) | 文件上传卡片和文档读取工具。 | 双 face；自建上传路由、直接写工作区、注册 tool、conversation slot、全页 DOM 拖放、自定义 CSS、TTL 和去重。 | 文件选择/上传/artifact API、附件贡献、quota、session/workspace scope、tool 和 composer 贡献。 |
| [dsh-sidechain](https://github.com/omdsh-dev/dsh-sidechain/tree/ee6fadd9bae9efb36477ec17c58e1409eeabaf88) | 侧会话与子会话面板。 | Host agents/subagents + Client conversation UI；patch Agent 方法以改变 settlement 和消息投递。 | Session action、子会话身份、delivery/interceptor contract、持久关系和强类型 conversation 贡献。 |

这十二个样本中，两个只需要 Host，一个实质上只需要 Client，另外九个同时需要两个 face。跨 face 行为不是少数特例，而是有一定复杂度的 DSH 插件的常见形态。

## 3. 开发者反复需要的能力

### 3.1 身份、兼容性和服务

有用的 manifest 不能只包含 `dsh.bundle.patch`：

- 稳定 plugin ID、publisher 和插件版本；
- manifest 与 Fabric API 版本；
- Host/Client face、支持的 surface、平台、架构和原生模块；
- 带版本的 required、optional 和 provided capability；
- 声明式贡献、订阅、敏感 scope、外部域名、可执行代码和安装/build script；
- 诚实的兼容证据：仅声明、已授权、已测试、已认证或未知。

运行时需要带版本的服务注册表，包含 required/optional 依赖、provider 唯一性或仲裁、健康、feature negotiation 和 owner-scoped dispose。它应该替代内部反射和任意 `ctx.get()` 探测，而不是把这些 workaround 标准化。

### 3.2 UI 贡献与 Renderer

样本中的 UI 需求结构完全不同：

- 设置 section 和 row；
- 命令面板、菜单动作、状态、通知和对话框；
- conversation header、composer button/dock、tool card、command result、message content 和 fence renderer；
- 主题与语义 token layer；
- 侧栏 Tab 和文件查看器；
- GenUI、看板、编辑器、终端和工作台等完整富视图。

因此 Fabric 需要[成熟框架调研](mature-plugin-frameworks.zh.md)提出的四层 UI：声明式贡献、强类型 Provider/Renderer、隔离富视图、明确标注的宿主扩展。Slot ID 必须有 schema、版本范围、数量、优先级、fallback 和冲突诊断。生成 CSS class、MutationObserver、原始 DOM 或产品内部 React 组件不能成为受支持的可移植路径。

### 3.3 Agent、工具、模型与上下文扩展

开发者需要：

- 注册工具和斜杠/产品命令；
- 注册 LLM、搜索、图片、记忆等 provider；
- 在不接触凭据的情况下读取模型能力；
- 在明确阶段加入有限 system/context 片段；
- 观察工具执行；
- 在工具执行前申请用户批准或实施策略；
- 用声明过的 renderer 展示结果。

这些是不同的注册表和流程，不是一个万能服务。Provider ID 需要所有权和仲裁。工具输入/结果需要 schema、取消、超时、审计和隐私。Prompt 贡献需要来源、确定性顺序和 token 预算。工具审批需要有序拦截器 contract 和明确失败策略。

### 3.4 会话、消息与工作流

插件需要稳定的 session view 和 action，而不是 live Agent 对象：

- 分页 list/get 经过裁剪的 session 和标准 transcript entry；
- 观察 message、turn、tool、approval、child-session 和 job 事件；
- 授权后 send、continue、interrupt、resume、branch 或 create session；
- 通过稳定 operation 选择 model 或 mode；
- 关联子会话、任务及其 owner；
- 宿主支持时追加带 namespace 的自定义持久事件。

观察、动作、拦截、上下文贡献和持久 job 必须是不同协议。事件 DTO 需要 ID、correlation/causation、scope sequence、隐私等级、顺序和 replay 边界。Sidechain 式 monkey patch 和硬编码私有事件词汇说明缺少 contract，不是我们需要保留的 API。

### 3.5 跨 face Bridge

每个双 face 插件都应该获得自动 namespace 的强类型 bridge，而不是自建私有路由：

- 小型操作使用 request/response RPC；
- 进度和实时数据使用有界 stream；
- 宿主负责提供静态/媒体资源；
- 自动带上 plugin/session/workspace scope；
- 宿主统一实现认证、授权、CSRF/Origin、大小/速率限制、取消、断连和 secret 裁剪；
- schema/版本协商和测试 fake。

Broker 可以把它映射到 Cordis、loopback HTTP/WS、IPC 或其他宿主 transport，插件代码不应关心实际传输方式。

### 3.6 文件、网络、Secret、进程与包管理

这些敏感功能很常见，应该有一等的受控 API：

- 感知 sandbox 的文件读写、用户文件选择、上传、附件/媒体和 artifact 导出；
- 声明网络 Origin/Method、有界 fetch、跳转/超时策略，以及永远不进入 Client 的 secret reference；
- subprocess、shell 环境、PTY、后台 job、进度、进程树取消、平台和原生 ABI 约束；
- 当前 profile 身份，以及带锁、备份、回滚的插件 install/update/remove/enable/disable/restart 事务。

在 trusted in-process 模式下，这些 API 能改善兼容、授权和审计，但阻止不了恶意代码直接导入 Node API。强制执行需要隔离运行模式。

## 4. 按真实断点排序

### P0——先消除最常见的私有耦合

1. manifest/schema 与 Host Descriptor；
2. 带版本的服务协商和激活所有权；
3. 带冲突诊断的声明式 UI 贡献；
4. 标准 session/message/tool 观察和范围很窄的 session action；
5. 强类型 Host↔Client bridge 与静态资源；
6. 受控 files/artifacts、network 和 secrets；
7. HMR、provider 替换和 shutdown 的 lifecycle/testkit fixture。

### P1——支持高级插件类别

1. 强类型 renderer 与隔离富视图；
2. tool、model/search 等 provider SPI；
3. 上下文贡献与工具审批拦截器 RFC；
4. process/PTY/job contract；
5. 事务化 profile/包管理。

### P2——分发与更强隔离

1. 签名、provenance、审核/认证证据和漏洞响应；
2. 真正强制模块、文件、网络和资源边界的隔离 Worker/进程；
3. modpack 兼容证据和可复现的跨宿主测试矩阵。

这不意味着所有 P0 API 都必须进入 Fabric v0.1，而是 manifest、Broker、face 模型和 Adapter 必须为它们留出正确位置，不能先把上游内部对象临时暴露成公开 API。

## 5. 目标开发体验

普通插件开发者应该可以写出：

```ts
import { definePlugin } from 'dsh-community-fabric/sdk'

export default definePlugin((ctx) => {
  ctx.tools.register('com.example.export', exportTool)

  ctx.messages.observe('received', event => {
    ctx.log.debug('message received', { id: event.id })
  })

  ctx.ui.toolResults.bind('com.example.export.result', exportResultRenderer)
})
```

准确包名和方法名尚未冻结。目标体验是：

- manifest 只声明一次工具、renderer、事件兴趣、权限和 face；
- 生成类型只暴露协商后的 API；
- 注册项随激活自动释放；
- fake Host 使用与真实 Host 相同的 schema、取消、生命周期和错误行为；
- DSH Adapter 翻译到官方 service 和 slot；
- 无法保持语义时返回带人类说明的 `unsupported`，不默默使用私有 workaround。

高级插件可以同时有 Host 入口和隔离 Client view，但它们使用生成的 bridge，不互相 import 实现，也不发明私有 HTTP 路由。

## 6. 产品结论

Koishi 和 Chrome 是很好的参考，但真实 DSH 插件能告诉我们理论标准会在哪里失效。真正有用的 Fabric 兼容层必须覆盖插件如何扩展 agent，而不只是模块如何加载。

决定性的产品边界是：

> 插件用 Fabric contract 描述并实现自己的意图；宿主拥有位置、授权、生命周期、传输和策略；只有 DSH Adapter 接触与版本相关的上游机制。

这样才能让生态持续演进，同时不虚假承诺所有 UI 都能跨宿主运行，也不把可信 JavaScript 插件假装成已经被 sandbox 隔离。
