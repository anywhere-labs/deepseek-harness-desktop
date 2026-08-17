# RFC 0001：DSH 统一插件 contract——Manifest、Capability 与事件模型

[English](0001-plugin-manifest-capabilities-events.md) | 中文

| 字段 | 内容 |
| --- | --- |
| 状态 | Draft / 征求意见 |
| 目标版本 | 实验性 v0.1 |
| 范围 | 插件与 Host 的互操作 contract |
| 参考实现 | DSH Community Fabric（尚未实现） |
| 讨论方式 | [社区 Issue #23](https://github.com/omdsh-dev/community/issues/23)、相关 discussion 或修改本文档的 PR |

## 0. 一句话摘要

为 DSH 社区定义一套由社区治理、可被静态分析的插件互操作标准：插件通过 manifest 声明身份与能力需求，Host 通过机器可读描述、能力协商和统一生命周期决定是否以及如何激活插件。

它借鉴浏览器扩展“manifest + capability + 统一 API”的思路，也借鉴 Forge/Fabric 把扩展挂在稳定生命周期上的经验，但不会宣称已经具备浏览器级沙箱，也不会另造一套与现有 DSH/Cordis 平行的插件加载生态。

## 1. Draft 边界

这是一份社区讨论稿，不是 DeepSeek 或 DSH 官方标准，也不是当前可用的开发 API。

当前 DSH 插件继续通过已有 package manifest、Cordis service、slot 与 patch 组合。Fabric 的第一步是建立由 Host integration 装配、位于版本化 DSH Adapter 之上的互操作层，不要求上游立即修改，也不要求 Host 移除 legacy 或内置扩展。

本 RFC 使用“必须”“应该”“可以”表达提案强度，但在 RFC 被接受、schema 发布且一致性测试存在前，这些词不构成稳定兼容承诺。

本次修订中的文件命名、运行拓扑、组合和溯源边界，来自[社区 Issue #23](https://github.com/omdsh-dev/community/issues/23) 收集的反例。它们是这份 Draft 当前采用的设计，不代表社区讨论已经形成正式共识。

## 2. 背景

社区正在形成 GUI、Web UI、TUI、启动器、组合包和不同分发渠道。增长带来了几类共同问题：

- **兼容信息缺失**：安装前无法可靠知道插件需要图形界面、会话读写、托盘或其他能力。
- **实现耦合**：直接依赖 loader、内部函数或源码 patch 的扩展容易随上游变化失效。
- **接口重复**：不同 Host 为同一需求提供不同路径，插件作者需要维护多套适配。
- **组合冲突**：多个插件修改同一行为时，缺少声明、顺序和冲突规则。
- **分发困难**：市场与启动器缺少可静态读取的兼容元数据，只能依赖人工组合和锁版本。

本提案把上游特有变化集中到版本化 DSH Adapter，产品策略与用户体验由 Host integration 负责。插件侧 contract 与治理不绑定某个 DSH 版本；上游变化时，Adapter 与 Host 负责适配、明确降级或拒载，不能伪装成仍支持原有语义。

这并不意味着标准可以完全不受上游影响。若上游不再暴露实现某项能力所需的观察点或操作点，对应 Host capability 就必须暂时下线。

## 3. 目标

1. **静态声明**：工具无需执行插件代码即可读取身份、版本、入口、能力需求与声明式贡献。
2. **兼容协商**：required capability 缺失时明确拒载；optional capability 缺失时允许可预测降级。
3. **统一 contract**：标准范围内的同一件事只有一个规范接口和一套行为语义。
4. **适配现有生态**：Host 可以在 DSH/Cordis 等原生机制之上实现 adapter，不新增必须并行维护的加载体系。
5. **可验证**：manifest、Host Descriptor、协商器和生命周期具备 schema、fixtures 与 headless 一致性测试。
6. **降低用户摩擦**：市场和启动器能在安装前展示兼容、不兼容、待授权、已实测和未知。

## 4. 非目标

- 不要求 DSH 上游立即采纳本提案。
- 不统一 GUI、Web UI 与 TUI 的内部渲染技术。
- 不在本 RFC 中实现包管理器、市场后台、排行榜或账号系统。
- 不把“静态声明通过”描述为代码安全审核。
- 不承诺任意复杂 UI 一份代码无损运行在所有 Host。
- 不在 v0.1 中定义可修改的全套 `before-*` 事件。
- 不要求 Host 删除内置、legacy 或非标准插件路径；这些路径只是不参与 Fabric 一致性声明。

## 5. 信任与执行档位

Capability 需要区分四件事：

1. **support**：Host 声明能够提供某项能力。
2. **request**：插件在 manifest 中申请该能力。
3. **grant**：用户或策略允许该插件使用它。
4. **enforcement**：Host 通过隔离和受控边界真正阻止绕过。

v0.1 的参考实现可以采用 **trusted in-process** 档位：插件作为受信任代码运行，capability 用于兼容、授权和审计，不构成安全沙箱。Host 必须显著声明这个事实。

未来的 **isolated** 档位必须另行规定进程或 realm 隔离、模块白名单、受控 IPC、资源限制、文件与网络 scope、崩溃恢复和平台差异。没有这些证据的 Host 不得声称权限被强制执行。

## 6. 版本模型

以下版本不能混为一个字段：

| 名称 | 含义 |
| --- | --- |
| `version` | 插件自己的 SemVer 版本。 |
| `manifestVersion` | manifest JSON 结构版本。 |
| `apiVersion` | 插件要求的社区 Host API 兼容范围。 |
| capability / event version | 某项能力或事件 payload 的 contract 版本；v0.1 可暂时跟随 API 版本。 |
| Host version | 某个 GUI、Web UI、TUI 或启动器自己的产品版本。 |
| SDK version | 类型与开发工具 package 的发布版本，不自动等于标准版本。 |

标准的 breaking change 必须进入新的不兼容 API 范围。v0 阶段若采用 `0.x`，仍按“minor 可能 breaking”的实验规则明确标注，不能对外伪装成稳定 `1.x`。

### 6.1 术语

- **Host product**：承载插件的 GUI、Web UI、TUI 或启动器产品。
- **Host-side runtime face**：Host product 中实际执行 v0.1 插件 entrypoint 的 Node.js 环境。
- **Activation instance**：某个插件 entrypoint 的一次有界激活；生命周期与资源 ownership 都以它为 scope。
- **Adapter**：把 Fabric capability 映射到具体 DSH/Cordis 版本的实现。
- **Runtime**：插件代码实际执行的位置，以及对应的信任与资源边界。
- **Presentation**：附着在某次交互上的用户界面能力，例如 GUI 窗口、浏览器、TUI 或 headless 调用方。
- **Control**：选择插件、执行策略、路由调用并持有取消权的控制方。
- **Transport**：在这些参与方之间传递 contract 消息的机制，例如进程内调用、IPC、WebSocket 或 SSH 转发。

v0.1 只规范 Host-side Node.js entrypoint 与 activation instance。浏览器 Client、原生界面或隔离 Worker 等 executable face，以及它们之间的通信协议，留给后续 RFC。TUI 在本文中是 Host product，不是 runtime face 名称。

### 6.2 Runtime 拓扑不是 Host 类型

Runtime、Presentation、Control 与 Transport 是四个独立维度，不能压缩为 `hostType: "gui"` 或 `isRemote: true` 之类的字段：同一次调用中，插件可能在远端 Node.js Runtime 执行，由服务端 session 控制，通过本地 GUI 呈现，并同时跨越 SSH 与 WebSocket transport。Transport 不能证明代码在哪里执行、当前有哪些界面，也不能证明谁有权批准操作。

Host Descriptor 可以声明它可能路由到哪些 presentation 类型，但这既不是授权，也不能证明某一次调用确实存在对应界面。未来的 presentation capability 必须是 **invocation-scoped**：Control plane 在每次调用时提供版本化、不可修改的 invocation snapshot，描述当前附着的界面与授权；插件不能把这次 offer 缓存成 activation-global 状态。[RFC 0002](0002-runtime-presentation-invocation-transport.zh.md)在不扩大 v0.1 的前提下提议身份、路由、认证、取消、重连、重放和失败边界。实验性 v0.1 不提供通用 presentation channel。

## 7. 核心模型

```text
Manifest（插件是谁、依赖什么、提供什么、贡献什么）
    ↓
Host Descriptor（Host 支持什么、以何种执行档位支持）
    ↓
Negotiation + Authorization（能否运行、用户是否授权）
    ↓
Lifecycle + Events（何时激活、能观察什么）
    ↓
Capability-scoped Host API（激活后如何调用）
```

### 7.1 Manifest

v0.1 将 manifest 冻结为 package 根目录中的静态 JSON 文件 **`dsh-plugin.json`**，不支持运行 JavaScript 动态生成。使用独立名称是有意为之：[Agent Plugins Specification](https://agent-plugins.org/specification) Working Draft 已经把根目录 `plugin.json` 保留给它自己的 manifest contract。一个 package 可以用两个文件同时支持两套生态，但两者不能互相覆盖或隐式扩展。

Phase 0 schema 必须要求顶层 `$schema` canonical identifier。Host 根据它选择本地已支持、随 Host 提供的 schema，加载插件时不能从网络获取 schema 或其他校验策略。正式 schema 发布后，其 canonical identifier 不得被重新赋予其他内容。`$schema` 负责选择 manifest 解析与校验规则；如果最终结构继续保留 `manifestVersion`，它必须与 `$schema` 选中的 schema 版本一致，不能成为另一个协商轴。独立的 `apiVersion` 仍表示插件要求的 runtime Host API 范围。所以下面的占位值只用于讨论，不是已发布 identifier，也不是合法 fixture。

```json
{
  "$schema": "<canonical v0.1 dsh-plugin.json schema identifier>",
  "manifestVersion": "0.1.0",
  "id": "com.example.message-memory",
  "name": "Message Memory",
  "version": "1.2.0",
  "apiVersion": ">=0.1.0 <0.2.0",
  "entrypoints": {
    "host": "dist/host.js"
  },
  "capabilities": {
    "required": {
      "messages.observe": ">=0.1.0 <0.2.0",
      "commands": ">=0.1.0 <0.2.0",
      "storage.local": ">=0.1.0 <0.2.0"
    },
    "optional": {
      "ui.panel.basic": ">=0.1.0 <0.2.0"
    }
  },
  "subscriptions": [
    { "event": "messages.observe", "version": ">=0.1.0 <0.2.0" }
  ],
  "contributes": {
    "commands": [
      { "id": "com.example.message-memory.show-last", "title": "Show Last Message" }
    ]
  }
}
```

正式 schema 还必须定义：

- `id` 的语法、命名空间所有权和冲突处理；
- entrypoint 必须位于 package 根目录内，以及其模块格式和执行环境；
- Host / renderer / worker 等多个 entrypoint 是否允许及其通信边界；
- capability 版本范围和敏感 scope；
- 插件更新新增 capability 时的重新确认；
- `contributes` ID 的命名空间与冲突规则；
- manifest 与 npm package metadata 重复字段的权威来源。

Schema 与工具必须在语义上区分五类声明，即使最终 JSON 层级还要结合 fixtures 继续细化：

| 声明 | 含义 |
| --- | --- |
| `requires` | 插件依赖的版本化 Host capability 或 service contract，包括 required 与 optional 依赖。 |
| `permissions` | 需要用户或策略授权的敏感 scope；Host 支持不等于已经授权。 |
| `provides` | 向其他插件或 Host 导出的版本化 service / Provider contract。 |
| `contributes` | 插件代码执行前即可发现的声明式产品元数据。 |
| `subscriptions` | eager activation 后控制事件投递的订阅，不是 activation trigger。 |

这五个名称只为标准 roadmap 保留彼此独立的语义，并不表示每一类都能在 v0.1 执行。在 service-composition contract 与带版本 schema revision 被接受前，v0.1 schema 必须拒绝 `provides` 和 `requires.services`。Host 不能把不支持的字段静默保存后展示成“已经生效”。首版 schema 只接受已有具体 v0.1 contract 的 requirement、permission、subscription 与 contribution 形式。

它们不能仅因为都写在 manifest 中就被当成同一种兼容或安全对象。消费者依赖的是 `provides` contract ID 与版本，不能直接依赖被选中实现它的具体 package。v0.1 只保留这类声明的语义，不提供通用 plugin-provided service runtime；[RFC 0003](0003-service-providers-and-composition.zh.md)为后续 runtime 提议 cardinality、多实例、用户选择、替换和依赖环。

在讨论用示例中，`capabilities.required` / `optional` 是 v0.1 暂定的 Host capability requirement 写法，`subscriptions` 则单独申请事件投递。最终 schema 可以把前者放入 `requires`，但不能把两者与 permission、export 或 contribution 混在一起。

借鉴 VS Code 的 Contribution Point 模型，`contributes` 只描述 Host 在插件运行前即可发现的元数据，不等同于 capability、授权、运行时实现或 activation 触发器。插件激活后只能为 manifest 已声明的 ID 绑定 handler / Provider；“声明但未绑定”和“绑定但未声明”都应由开发工具和一致性测试报告。

标准不规定某一种 loader 或源码转换实现。Host 通过 manifest 找到 entrypoint，再用自己的原生机制按标准生命周期激活。Fabric-managed 插件必须走这条入口；Host 的其他扩展路径必须明确标为非标准。

符合标准的 Fabric entrypoint 运行时不依赖 DSH、Cordis、Desktop 或 Adapter package。Package inspection、依赖规则和 conformance fixtures 会阻止意外耦合；trusted in-process 模式仍不能把这条受支持边界变成恶意代码沙箱。

### 7.2 Host Descriptor

每个兼容 Host 必须发布机器可读描述。以下同样是讨论草案：

```json
{
  "descriptorVersion": "0.1.0",
  "id": "org.example.dsh-webui",
  "version": "1.4.0",
  "apiVersions": ["0.1.0"],
  "execution": {
    "environment": "node",
    "trustMode": "trusted-in-process"
  },
  "capabilities": {
    "messages.observe": "0.1.0",
    "commands": "0.1.0",
    "storage.local": "0.1.0"
  },
  "platforms": ["darwin-arm64", "win32-x64", "linux-x64"]
}
```

兼容判断优先依据 API 与 capability，而不是 `gui>=2.0` 这样的模糊产品名称。必须限制具体 Host 时，应使用稳定、带组织命名空间的 Host ID。

Descriptor 只报告 Host 实际提供的 Runtime 与 trust mode，不能用 `hostType` 或 `isRemote` 代替 Runtime、Presentation、Control 或 Transport。静态声明可能存在的 presentation 类型，也不会因此成为 activation-wide capability。

市场展示至少区分：

- **声明兼容**：静态协商通过；
- **等待授权**：Host 支持，但敏感能力未获用户授权；
- **已实测**：明确的 Host、系统、插件和测试套件组合通过；
- **不兼容**：required capability 或 API 范围无法满足；
- **未知**：信息不足。

声明兼容不等于实测，更不等于安全审核。

默认交互应展示但禁用不兼容插件，并列出缺少的 capability；直接隐藏会让跨设备或跨 profile 的插件看起来凭空消失。

### 7.3 Capability

Capability 是带版本的 Host service contract。v0.1 候选命名空间包括：

| 名称 | 目的 | v0.1 状态 |
| --- | --- | --- |
| `storage.local` | 插件私有、受 Host 管理的持久化。 | v0.1 协商 capability |
| `commands` | 为 manifest 中声明的命令绑定 handler。 | v0.1 协商 capability |
| `messages.observe` | 观察不可变的消息事件。 | v0.1 协商 capability |
| `sessions.read` | 读取经过版本化和裁剪的会话视图。 | 后续设计 |
| `ui.panel.basic` | 极小、版本化的声明式 UI 公共子集。 | 后续原型 |
| `sessions.actions`、`net.*`、`fs.*` | 修改会话、网络与文件能力。 | 暂缓 |

每项 capability 都必须单独规定方法、输入输出 schema、错误、取消、生命周期、隐私、资源限制和测试。私有扩展使用组织命名空间，例如 `x-org.example.tui.keymap`，不能使用容易冲突的短名称。

标准必须发布版本化、机器可读的 Capability Registry，不能要求实现方从 RFC 正文中抓取名称。每条记录至少包含 canonical ID 与版本、状态、owning RFC、输入/输出/错误 schema identifier 及不可变 hash、敏感级别与授权类型、生命周期 scope，以及弃用或替代信息。Host Descriptor 只能声明自己实际实现的 registry 精确条目；私有能力继续使用显式命名空间，不能伪装成标准 capability。

每项 contribution / Provider contract 还必须明确 cardinality、selector、priority、merge / first-result / pipeline / user-choice、同优先级 tie-break、错误隔离、timeout、重复注册和热替换。加载顺序不能成为未写明的冲突解决规则。

“标准接口唯一”只约束 Fabric contract：标准插件不能为同一项标准能力发明旁路。它不声称能够阻止 trusted in-process 代码直接使用 Node.js API。

声明式 contribution 不会隐含运行时访问或授权。Manifest 中的命令元数据是权威来源；命令 contribution 还要申请 `commands`，插件代码只按 ID 绑定 handler。Required API 在协商后一定存在；optional API 必须先经过显式 capability 检查与类型收窄。

v0.1 的 `commands` contract 刻意只支持 **flat action leaf**：一个全局命名空间 command ID 对应一个已声明 action 与一个归 activation 所有的 handler。Host 可以把同一 action 放进 palette、菜单、按钮或 TUI，但不能改变其身份。嵌套 command tree、subcommand、CLI 风格 option parser、交互式 prompt、流式输出与后台 command session 都不属于 v0.1。

Device code、临时 URL、二维码、确认请求等短期交互不能被塞进持久 session message。[RFC 0002](0002-runtime-presentation-invocation-transport.zh.md)为后续协议提议带过期时间、敏感等级和投递确认的 presentation item。在此之前，v0.1 command 不能要求这类 channel。

### 7.4 Lifecycle 与事件

Host product 状态与插件 activation 是两套独立状态机。Host 通常经历：

```text
starting → ready → stopping → stopped
```

Host ready 后，每个 activation instance 独立经历：

```text
discover → validate → negotiate → authorize
→ activating → active → deactivating → disposed
```

实验性 v0.1 不采用按需激活。完成 discover、negotiate 与 authorize 后，Host 在组装一次 runtime generation 时激活所有已选中的插件。Contribution 负责描述可发现功能，subscription 只控制事件投递；执行 command、请求 Provider 或匹配 subscription 都不能激活 inactive 插件。未来 interceptor 仍需要独立授权、顺序和失败 contract。

Host 必须为正常 activation 保证顺序，并在正常关闭时 best-effort deactivate，但不能在进程崩溃、断电或强制终止时保证 `deactivate` 送达。Plugin 必须把清理设计为可重复，并假设下一次启动可能需要恢复残留状态。Host 保持 ready 时，同一插件也可能因 HMR 或 profile 重新组合而重复 activate/dispose。

`activate` / `deactivate` 是 Host 调用的 activation-instance hook，不是插件自行订阅的普通业务事件。v0.1 的同一个 Host-side entrypoint 可以被重复激活；正式 lifecycle contract 必须定义重复激活、HMR 与 provider 替换行为。Client 或 isolated Worker 等其他 face 的 scope 与跨 face 通信另写 RFC。

v0.1 首先规范生命周期和一个不可修改的 `messages.observe` 事件。它使用带版本的最小 envelope，至少包含：

- `envelopeVersion`、`eventType` 与 `eventVersion`；
- 唯一 `eventId`、来源 `runtimeId` 与 `occurredAt` 时间；
- `scopeType`、`scopeId`，以及在该 scope 内单调递增的 `scopeSequence`；
- 同一操作链可选的 `correlationId` 与 `causationId`；
- `privacyClass` 与明确的 `redactions` 摘要；
- canonical `payloadSchema` identifier 与不可修改的 `payload`。

Payload contract 仍要冻结具体消息字段、敏感字段规则、并发、回压、错误隔离、取消信号和关闭行为。时间戳与投递顺序都不隐含跨 scope 的全局顺序。

标准还必须发布机器可读的 Event Registry。每条记录把 canonical event ID 与版本绑定到 envelope / payload schema identifier 及不可变 hash，并记录 scope 与顺序规则、隐私/裁剪级别、投递/回压 contract、错误策略、状态、owning RFC 和弃用信息。`subscriptions` 与 Host Descriptor 引用这些 registry 条目；实现方不能从正文中自行发明“等价”事件名。

可修改或取消的 `before-*` 事件暂不进入 v0.1。后续 RFC 必须先回答：

- 多插件执行顺序与优先级；
- 多次修改的合并方式；
- cancel 后是否继续调用；
- timeout、异常、回滚和重入；
- 每 session 的顺序与跨 session 并发；
- 隐私与敏感数据裁剪。

### 7.5 Host API

未来 SDK 可能提供类似下面的开发体验，但 package 名称和签名尚未冻结：

```ts
export default definePlugin((ctx) => {
  ctx.commands.handle('com.example.message-memory.show-last', async () => {
    const lastMessageId = await ctx.storage.local.get('lastMessageId')
    ctx.log.info('Last observed message', { lastMessageId })
  })

  ctx.messages.onReceived(async (message) => {
    await ctx.storage.local.set('lastMessageId', message.id)
  })

  return {
    deactivate() {
      // release resources owned by this activation
    },
  }
})
```

`ctx` 只暴露协商后获准的标准 capability。required 缺失时插件不会激活；optional 缺失时对应 API 不存在，插件必须走明确降级路径。

在 trusted in-process 档位中，这仍然只是受支持 contract facade，不是 JavaScript 安全边界。

### 7.6 Broker 归属与 effect ledger

所有标准注册都必须经过 Host API Broker，由 Broker 把资源归属到当前 activation instance。从 v0.1 开始，Broker 必须维护机器可读的 effect ledger，让诊断与清理能够回答“哪个插件创建、替换或未能释放了这项资源”。最小记录包含：

- `ledgerVersion`、`recordId`、单调递增的 `sequence` 与 `recordedAt`；
- owner `pluginId`、`pluginVersion` 或 `manifestDigest`、`activationId` 与 `runtimeId`；
- `effectId`、`effectKind`、canonical contract ID/version，以及存在时的 `resourceId`；
- `operation` 与结果 `state`，至少覆盖 `create`、`bind`、`replace`、`release` 和 `cleanup-failed`；
- 可选的 `correlationId`、用于替换的旧/新 owner 或关联 effect ID，以及不含敏感数据的 `outcome` 或 canonical `errorCode`；
- `sensitivityClass` 与实际采用的裁剪策略。

Command handler、subscription、Provider、UI contribution 以及未来其他归 activation 所有的注册，在对应 contract 存在时都使用同一套 ownership 规则。Broker 与 Host 原生 lifecycle 协作释放资源，并记录结果。Ledger 默认不能写入消息正文、secret、command argument 或任意插件 payload。它改善溯源与诊断，但 trusted in-process 代码仍可绕过 Broker，所以 ledger 不是沙箱强制执行的证明。

## 8. Host 的义务

兼容 Host 应当：

1. 对 Fabric-managed 插件只读取静态 manifest，不执行动态 manifest 代码。
2. 发布真实的 Host Descriptor，不声明无法保持语义的 capability。
3. 在执行插件代码前完成 schema 校验、API 与 capability 协商和必要授权。
4. 对 required 缺失给出用户能理解的拒载原因，对 optional 缺失提供确定的降级结果。
5. 保证正常生命周期顺序，并捕获跨越标准 callback / Promise 边界的普通异常；trusted in-process 无法隔离 `process.exit`、native crash 或死循环。
6. 公开执行档位与限制，不能把 trusted in-process 描述成沙箱。
7. 通过已发布的机器可读 registry 解析标准 capability 与 event，不能使用产品本地别名替代。
8. 把每项标准注册归属到具体插件与 activation，维护最小 effect ledger，并在 dispose 时尝试有界清理。
9. 运行与版本绑定的一致性测试，并发布测试环境和结果。

## 9. 与现有 DSH/Cordis 的关系

Fabric 不能通过重新发明 loader 来解决 loader 割裂。参考 adapter 应把 Fabric contract 映射到现有 DSH/Cordis composition：

- manifest 负责静态发现与协商；
- Host integration 通过版本化 DSH Adapter，把获准 capability 映射到已有 service、slot、route 或事件；
- 原生 Cordis lifecycle 继续拥有实际资源释放；
- 无法等价映射的能力必须报告不支持，不能偷偷使用内部接口近似；
- 现有插件可以通过迁移工具补 manifest，但不会因为 Fabric 出现而立即失效。

可移植 v0.1 contract 拒绝把修改上游源码、猴子补丁和私有函数 hook 当作插件 API。现有 `cordis.patch.yml` 是 DSH 官方的声明式 profile 组合层，不是源码 patch；Fabric Adapter 本身也可能通过标准 bundle patch 进入现有 composition。单独标记、固定版本的 Adapter 实验可以研究经过审查的私有兼容桥，但不能把 patch target 暴露给普通插件、宣传成可移植 capability，或凭此通过 portable conformance。

本仓库当前公开的 `desktopProfiles` 与 `desktopPnpm` 是 Desktop 特定 Host service，不会自动成为跨 Host 标准。若社区希望标准化其中某一用途，应另写 capability RFC，并由多个 Host 共同证明语义可移植。

## 10. 市场、组合包与兼容证据

市场可以索引 manifest 和 Host Descriptor，在安装前计算静态兼容性，但不能把目录收录描述为审核或安全认证。

组合包继续是一等公民：它可以锁定标准版本、Host 版本、插件版本、平台和测试结果。锁版本从“对抗不稳定”转化为可复现发行策略，但不能替代每个 contract 的 SemVer 与兼容窗口。

任何“已实测”记录都应绑定：

- 标准与 schema 版本；
- Host ID、版本、平台与架构；
- 插件 ID 与版本；
- 一致性测试套件版本和 commit；
- 测试时间与结果。

## 11. 最小落地路径

实验性 v0.1 只有在 Phase 0–2 的最小 contract 都有规范和测试后才完成；阶段编号表示实现顺序，不是三个相互矛盾的版本范围。

它的精确 runtime 范围是：基础 `host.info`、`log` 和生命周期取消，再加需要协商的 `storage.local`、`commands` 与一个不可修改的 `messages.observe` 事件。本文中的其他名称都是后续候选。

### Phase 0：标准基础

- RFC 0000：治理、状态与变更流程；
- package 根目录 `dsh-plugin.json` Manifest Schema，并要求 canonical `$schema` identifier；
- Host Descriptor Schema；
- 带不可变 schema hash 的机器可读 Capability / Event Registry；
- 合法/非法 fixtures；
- 纯函数 capability 协商器；
- headless 一致性测试骨架。

### Phase 1：受信任参考 adapter

- 只支持一个明确的 Node.js Host 执行环境；
- 实现 discover / validate / negotiate / activate / deactivate；
- 首批 capability 保持低风险且不修改业务状态；敏感只读数据仍需授权与裁剪；
- Broker 分配的插件/activation ownership 与最小 effect ledger；

### Phase 2：事件与最小贡献点

- 一个带最小版本化 envelope 的不可修改 `messages.observe` 事件；
- `storage.local`；
- `commands` 只提供 flat action leaf 与同 ID runtime binding，不包含 command tree 或交互式 presentation；
- activation-scoped Disposable / AsyncDisposable、有界 drain 与重复 activation；
- 故障插件、重复 ID、未声明/未绑定 contribution、timeout、取消和关闭 fixtures。
- 完整 v0.1 能力存在后，由至少两个不同 Host product 或 integration 提供互操作证据；它们可以共享同一个版本化 DSH Adapter。

### 后续独立 RFC

- 可修改的 `before-*` 事件；
- [Runtime / Presentation / Control / Transport 身份、invocation routing、command tree 与 ephemeral presentation](0002-runtime-presentation-invocation-transport.zh.md)；
- [Service Provider contract、`provides` 组合、cardinality、选择与依赖环](0003-service-providers-and-composition.zh.md)；
- UI Contribution、Provider、Renderer、Rich View、条件系统与最小跨 Host UI IR；
- Project/Profile Trust 与 experimental capability 晋级流程；
- 多 scope storage 与 Secret capability；
- 文件、网络与会话写入权限；
- 隔离执行与受控 IPC；
- [安装影响预览，以及超出最小 effect ledger 的完整溯源、验证与诊断交换](0004-provenance-validation-and-diagnostics.zh.md)；
- 市场兼容标签与一致性结果交换格式。

## 12. 治理要求

在本 RFC 进入 Accepted 前，应先通过 RFC 0000 明确：

- Draft、Review、Accepted、Final、Deprecated、Superseded、Withdrawn、Rejected 等状态；
- 最短公开评审期、决策方式、异议与申诉；
- capability/event 命名登记；
- breaking change、弃用窗口与勘误；
- 安全问题的非公开披露渠道；
- 规范与参考实现许可证；
- “社区标准”与“官方标准”的表述边界。

参考实现不能反向决定规范。一个行为只有在规范文本、fixtures 和一致性测试中被定义，才属于标准 contract。

## 13. v0.1 验收与一致性证据

实验性 v0.1 把证据分成四类：

1. **Schema validation**：公开 `dsh-plugin.json` / Host Descriptor Schema、required 且已识别的 `$schema`、完整 SemVer 规则、registry，以及合法/非法 fixtures。
2. **Host conformance**：required / optional 协商、未知版本、授权拒绝、activation 顺序、best-effort 关闭、标准 callback 异常、真实 Runtime/trust 描述，以及插件/activation effect ownership。
3. **Plugin validation**：manifest 与 entrypoint 一致、只使用已声明 capability、contribution 声明/绑定一致且 ID 无冲突、optional 降级路径、重复 activation 后同步/异步资源可释放、错误可理解。
4. **Interop evidence**：两个独立 Host product 或 integration 与三个示例插件完成同一组场景，作为 v0.1 从 Draft 晋级的标准证据。两个 Host 可以共享 DSH Adapter，但 integration 与 descriptor 证据必须独立。

由于 Events 属于 RFC 标题与 v0.1 范围，至少一个不可变观察事件必须拥有最小版本化 envelope、payload schema、隐私裁剪、scope 内顺序、回压/timeout、异常处理、关闭语义和 headless contract tests。

Host 只能声称“该 Host 通过 v0.1 Host conformance suite”；插件只能声称“该插件通过 v0.1 plugin validation”。两者都不能称为“安全插件”或“官方认证”。

## 14. 开放问题

1. Canonical `$schema` identifier 与离线兼容映射由谁持有和发布？
2. 插件 ID 的发布者命名空间如何证明所有权并处理转移？
3. v0.1 应支持哪个 Node.js 版本、模块格式和 entrypoint 加载边界？
4. 已定义的 v0.1 `messages.observe` envelope 内应包含哪些消息正文字段与裁剪规则？
5. capability 版本是独立 SemVer，还是在 v0 阶段跟随 `apiVersion`？
6. 需要什么证据才能证明 flat `commands` action 在 GUI、Web UI 与 TUI Host 中语义一致？
7. Host 一致性结果由谁签发、保存和撤销？
8. RFC 评审期、merge 权限和争议解决如何由社区共同治理？

## 15. 为什么现在做

生态已经出现多个 Host、插件作者和分发渠道。此时建立静态、可测试的互操作 contract，比等接口进一步碎片化后再统一成本更低。

真正要复用的不是某个 loader，而是长期稳定的声明、协商、生命周期与验证方法。我们希望 Fabric 成为社区共同维护的适配层和实验场，而不是另一家单方面宣布的平行插件系统。

下一步不是“一周后自动成为标准”，而是公开收集反例、先完成治理 RFC 与 schema fixtures，再用两个 Host 和真实插件验证最小 contract。
