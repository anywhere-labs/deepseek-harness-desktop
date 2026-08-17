# RFC 0002：Runtime、Presentation、Control、Transport 与 Invocation

[English](0002-runtime-presentation-invocation-transport.md) | 中文

| 字段 | 内容 |
| --- | --- |
| 状态 | Draft / 征求意见 |
| 目标 | v0.1 之后的协议探索 |
| 范围 | 插件 Runtime 与用户侧 Presentation 之间的交互 |
| 依赖 | [RFC 0001](0001-plugin-manifest-capabilities-events.zh.md) |
| 参考实现 | DSH Community Fabric（尚未实现） |
| 讨论方式 | [社区 Issue #23](https://github.com/omdsh-dev/community/issues/23) 或修改本文档的 PR |

## 0. 一句话摘要

把本地单体设计中容易混在一起的五个概念拆开：

- **Runtime** 执行插件；
- **Presentation** 与用户交互；
- **Control** 负责 attachment 认证、策略与 invocation 协调；
- **Transport** 只传递协议消息，不改变插件语义；
- **Invocation** 是一个获准 Presentation 对某个 Runtime 发起的一次有边界请求。

Presentation capability 是每次 invocation 的不可变输入，绝不能成为 activation 阶段的全局状态。插件不能依据 `isRemote`、`hostType`、Transport 名称或记住的“当前客户端”分支。同一个 Runtime 可以并发服务多个 Presentation；一个 Presentation 也可以 attach 或切换多个 Runtime，而不改变插件 contract。

## 1. 状态及与 RFC 0001 的关系

本文是由 [Remote SSH 反例](https://github.com/omdsh-dev/community/issues/23#issuecomment-5306386927)及后续 [Runtime / Presentation / Control 分层建议](https://github.com/omdsh-dev/community/issues/23#issuecomment-5306670321)推动的讨论草案，不是开发者今天就能使用的 API。

[RFC 0001](0001-plugin-manifest-capabilities-events.zh.md) 有意把实验性 v0.1 限定为单一 Host-side Node.js runtime face。本 RFC 不扩大 v0.1 runtime 范围。Descriptor schema、协议 schema、经过评审的 Control 实现、Transport adapter 与一致性 fixtures 全部存在前，任何实现都不能宣称支持本 RFC。

RFC 0001 的 activation 决策也保持不变：实验性 v0.1 **不采用按需激活**。Runtime generation 组装时激活已选插件；Presentation attach、发现 command 或执行 command 都不会激活 inactive plugin。

本文中的“必须”“应该”“可以”表示 Draft 的提案强度；RFC 被接受并拥有 schema 与测试前，不构成兼容承诺。

## 2. Remote SSH 反例

社区报告描述了这样一个场景：远端 profile 负责执行插件，本地 TUI 或 Web UI 展示其 command。三个失败揭示出缺失的边界：

1. 根 command 能进入远端 command catalog，但保存在 TUI-only service 中的子命令无法到达远端。可移植命令语法被错误地交给了某一个 Presentation 实现。
2. 登录 handler 在插件注册阶段选择 browser 模式；远端 Runtime 可能因此尝试在错误的机器上打开浏览器。同一 Runtime 上另一个 Presentation 的能力还可能完全不同。
3. Device authorization URI 与 user code 被放入持久化 command/session 结果，尽管它们短期有效且敏感。

增加 `isRemote: true` 不能解决这些问题。本地或远端不是 Presentation capability；同一个 Runtime 可能对某个客户端是远端，同时并发服务许多客户端。增加 `hostType: "tui"` 也同样失败，因为执行与呈现是两个独立维度。

因此协议需要可移植 command tree、逐 invocation 的 Presentation capability，以及非持久化 Presentation channel。

## 3. 目标

1. 为 Runtime、Presentation、Control、Transport 与 Invocation 分别给出唯一、精确的含义。
2. 允许多个 Presentation attach 同一个 Runtime，且不存在共享的“当前客户端”状态。
3. 允许一个 Presentation attach 或切换多个 Runtime，身份与授权相互隔离。
4. 让 command 发现、typed invocation、取消与短期用户交互在 GUI、Web UI、TUI、CLI 和 headless 测试客户端之间可移植。
5. 让插件行为与 SSH、WebSocket、local IPC、container exec 或未来 Transport 无关。
6. 让授权、敏感数据处理、attachment 生命周期与故障行为在无图形环境中同样可观察、可测试。

## 4. 非目标

- 本 RFC 不进入 RFC 0001 实验性 v0.1 runtime 范围。
- 不引入按需激活，也不改变以 generation 为 scope 的 eager activation。
- 不是集群调度器、workflow engine、profile manager、部署系统、service discovery 或 fleet control plane。
- 不统一 GUI、Web UI、TUI 或 CLI 的渲染技术、布局、导航、样式或组件库。
- 不让任意 rich UI 自动跨端可移植；Rich View 与 Renderer extension 需要独立 capability RFC。
- 不要求使用 SSH，也不选择首选 Transport。
- 不把 trusted in-process plugin 变成安全沙箱。
- 不定义持久 session history 格式，也不允许短期 secret 进入其中。

## 5. 术语与不变量

### 5.1 Runtime

**Runtime** 是插件实际执行的位置及其 trust/resource boundary；一次 Runtime generation 会在其中激活已选中的 plugin entrypoint。它拥有 activation instance、Runtime capability、command handler、storage binding 与业务事件 subscription。

Runtime 不是“UI”，也不由另一台机器认为它是本地还是远端来定义。其 descriptor 可以公开与执行有关的事实，例如操作系统、架构、API version 与 trust mode，但不能向插件公开 `isRemote` 这种捷径。

### 5.2 Presentation

**Presentation** 是某次 invocation 可用的用户交互界面。Presentation endpoint 可以持续 attached，并负责发现 command、收集输入、呈现输出或提供短期交互 affordance，但其 capability 只有通过 invocation snapshot 才对插件有意义。桌面窗口、browser client、TUI、CLI 与确定性的 headless test client 都可以是 Presentation。

Presentation 声明带版本的 capability，而不是供插件分支的产品标签。插件只能在协商后的 capability 中选择。产品身份可以用于诊断和一致性证据，但 `hostType`、`clientType` 或产品名不能代替 capability 检查。

### 5.3 Control

**Control** 是 Presentation 与 Runtime 之间的策略和协调平面。它负责选择适用的 plugin/runtime generation、对端认证、Runtime 访问授权、descriptor 协商、attachment 创建与撤销、把 Presentation 声明绑定到 invocation、路由请求与取消、限制配额，以及记录不泄露来源数据的诊断信息。

Control 可以嵌入本地产品，也可以跨进程拆分。它在逻辑上的职责不意味着必须存在一个中心化互联网服务。

### 5.4 Transport

**Transport** 在 Control 端点之间传输带版本的协议 envelope，例如 in-memory call、local IPC、SSH channel、WebSocket、HTTP stream、container exec 或 Kubernetes exec。

Transport 会影响连接、延迟、framing 与故障信号，但不能改变 command ID、payload schema、Presentation capability 语义、授权规则或插件 API。普通插件代码看不到 Transport 细节。

### 5.5 Invocation

**Invocation** 是针对某一 Runtime generation，对一个已声明 command 或 Provider operation 进行的一次获准、可取消且有边界的执行。它携带本次请求可用 Presentation capability 的不可变快照。

### 5.6 规范性不变量

1. Plugin activation 以 Runtime generation 为 scope；Presentation attachment 不等于 activation。
2. Presentation 状态以 attachment 为 scope，并在每次 invocation 中形成快照。
3. Runtime 与插件都不能保存全局 `currentPresentation`、`hostType` 或 `isRemote` 供后续请求使用。
4. 一个 attachment 声明的 capability 绝不能泄漏到另一个 attachment 或 invocation。
5. Transport 可以转发标准 envelope，但不能重新解释其业务语义。
6. Control 对 attachment identity、grant、deadline 与 revoke 具有权威性；仅凭不受信客户端的声明不够。
7. Invocation 指向不可变的 `runtimeId` 与 `generationId`；重连或切换不能静默改变目标。
8. Attach、detach、command discovery 与 invocation 都不会按需激活插件。

## 6. 拓扑与 ownership

它们之间是多对多关系：

```text
Presentation A ─┐                 ┌─ Runtime 1 / generation X
                ├─ Control plane ┤
Presentation B ─┘                 └─ Runtime 2 / generation Y
```

一个远端 Runtime 可以同时服务本地 TUI 与 browser Presentation，其 capability snapshot 和 grant 彼此独立。一个 TUI 可以 attach Runtime 1、attach Runtime 2，或切换当前视图，但不能在 Runtime 之间转移 invocation ID、grant、ephemeral message 或 cancellation handle。

同一个产品可以实现多个角色。例如桌面应用可以在一个进程树内同时包含 Runtime、Control、Presentation 与 local IPC。一致性测试仍然检查这些逻辑边界；进程共置不等于允许用全局状态替代显式 context。

## 7. Descriptor 与 invocation context

本节所有例子都只是讨论结构，并非已发布 schema。正式文档必须拒绝未知的安全敏感字段、规定大小上限，并提供合法与非法 fixtures。

### 7.1 RuntimeDescriptor

Control 为一个存活的 Runtime generation 获取 `RuntimeDescriptor`：

```json
{
  "descriptorVersion": "0.1.0",
  "runtimeId": "runtime:01K3EXAMPLE",
  "generationId": "generation:01K3EXAMPLE",
  "product": {
    "id": "org.example.dsh-runtime",
    "version": "2.0.0"
  },
  "execution": {
    "environment": "node",
    "trustMode": "trusted-in-process"
  },
  "platform": {
    "os": "linux",
    "arch": "x64"
  },
  "apiVersions": ["0.1.0"],
  "capabilities": {
    "commands": "0.1.0",
    "storage.local": "0.1.0"
  }
}
```

`runtimeId` 在对应 Control authority 中唯一，但不是 hostname。Profile composition 或 active plugin binding 被替换时，`generationId` 必须改变。两个 ID 都是不透明值，不能被解析以推断拓扑或产品行为。指向过期 generation 的请求应被拒绝，不能被重定向。

RFC 0001 的 Host Descriptor 与这里的 Runtime Descriptor 具有不同生命周期。Host Descriptor 是在 generation 组装前用于安装与 composition planning 的产品/integration 证据；Runtime Descriptor 描述一个已经组装并正在运行的 generation。Live descriptor 必须能从 Host/Adapter implementation 与实际 generation 推导，不能公布对应 Host Descriptor 和已协商 contract 不支持的 capability。

Runtime Descriptor 描述 Runtime 能执行什么，不描述当前用户是否有浏览器、clipboard、QR renderer 或 prompt surface。

### 7.2 PresentationDescriptor

Control 在 attach Presentation 时校验 `PresentationDescriptor`：

```json
{
  "descriptorVersion": "0.1.0",
  "product": {
    "id": "org.example.dsh-tui",
    "version": "1.4.0"
  },
  "locale": "zh-CN",
  "capabilities": {
    "presentation.text": "0.1.0",
    "presentation.link.show": "0.1.0",
    "presentation.clipboard.copy": "0.1.0"
  }
}
```

Client 提交的 descriptor 不包含可信 `presentationId`。完成认证后，Control 在 attachment authority 内分配该 ID，并只把它加入 invocation 使用的已认证 descriptor snapshot。它不能由稳定硬件指纹提供或派生。这个 ID 是不透明值，不能驱动插件行为。Capability value 是带版本的 contract；字段缺失表示不可用。产品名、locale、screen size 或 TUI/GUI 标签都不会隐含某项 capability。

候选 capability contract 包括：

| Capability | 含义 |
| --- | --- |
| `presentation.text` | 在明确处理控制字符的前提下呈现有界纯文本。 |
| `presentation.prompt.select` | 从有界 typed choice set 中收集一个选择。 |
| `presentation.link.show` | 显示经过审计的 HTTPS URI，但不自动打开。 |
| `presentation.link.open` | 在用户明确操作后，提供打开已审计 URI 的能力。 |
| `presentation.clipboard.copy` | 提供用户明确触发的操作，复制指定字段。 |
| `presentation.qr.render` | 把经过审计的字段渲染为 QR。 |

每项 contract 仍需规定 accessibility、timeout、大小、scheme、gesture、错误与隐私规则。声明 capability 不会绕过用户确认或平台策略。

### 7.3 InvocationContext

Control 为每次 invocation 新建 context：

```json
{
  "protocolVersion": "0.1.0",
  "invocationId": "invocation:01K3EXAMPLE",
  "attachmentId": "attachment:01K3EXAMPLE",
  "runtime": {
    "runtimeId": "runtime:01K3EXAMPLE",
    "generationId": "generation:01K3EXAMPLE"
  },
  "presentation": {
    "descriptorVersion": "0.1.0",
    "presentationId": "presentation:01K3EXAMPLE",
    "capabilities": {
      "presentation.text": "0.1.0",
      "presentation.link.show": "0.1.0"
    }
  },
  "authority": {
    "subject": "subject:opaque-user-reference",
    "grantId": "grant:01K3EXAMPLE"
  },
  "deadline": "2026-08-17T12:00:00Z",
  "trace": {
    "correlationId": "correlation:01K3EXAMPLE"
  },
  "command": {
    "id": "com.example.codex.login.device",
    "input": {}
  }
}
```

序列化 context 只保留授权、路由、capability 协商、取消和诊断所需的最少数据。SDK 可以公开更窄的 typed facade，并以 `AbortSignal` 代替 raw envelope。

Presentation capability map 会被复制到 invocation 并与之一起认证，不能从插件的可变状态中读取。即使 Presentation 没有任何交互能力，也要显式发送空 map。

## 8. Attach 与 detach 生命周期

每个 attachment 都有独立状态机：

```text
connecting → authenticating → negotiating → attached
    → draining → detached
```

Attachment 流程如下：

1. Transport 建立 channel，并把经过认证的 peer evidence 报告给 Control。
2. Control 认证 principal，并授权其访问一个特定 Runtime generation。
3. 校验 Runtime / Presentation descriptor 并进行版本协商。
4. Control 分配新的 `attachmentId`，将 descriptor evidence 与 grant 绑定到它，并开放 command discovery。
5. 每次 invocation 都重新确认 attachment、generation、command、grant、deadline 与 capability snapshot 仍然有效。
6. Detach 阻止新 invocation，按声明的策略处理进行中工作，撤销 attachment-scoped handle，并清理 ephemeral message。

Attach 不会激活插件、创建全局 current Presentation，也不能转移另一个 Runtime 的 grant。除非未来的 resume protocol 能证明连续性与 replay safety，否则 reconnect 必须创建新 attachment。

Runtime shutdown 会 detach 该 generation 的所有 Presentation。Presentation shutdown 只 detach 自己的 attachment；共享 Runtime 继续服务其他已授权 Presentation。

## 9. Invocation 协议与取消

一次 invocation 只允许沿单调状态机前进：

```text
accepted → running → succeeded
                   ├→ failed
                   └→ cancelling → cancelled
```

只能有一个 terminal state。Control 与 Runtime 必须按 `invocationId` 去重；除非某项 operation contract 明确允许，否则重试不能让 non-idempotent handler 再执行一次。

Invocation input / output 在 Control 边界做 schema 校验，到 Runtime 边界后再次校验。错误使用稳定的 machine code 与安全的用户提示；Transport error 不作为插件业务错误暴露。

取消规则如下：

- SDK 为每次 invocation 提供 cancellation signal；
- deadline 与明确获准的 cancel request 进入同一条取消路径；
- 除非 isolated execution mode 定义了更强终止机制，否则取消是协作式的；
- Control 在有界 drain timeout 内等待 terminal acknowledgement；
- Transport 断开不能被静默解释为“取消”或“继续”；每类 operation 都要声明并测试 disconnect policy；
- terminal state 之后到达的延迟输出会被丢弃并进入诊断，不能展示给另一个 attachment。

## 10. 可移植 Command Descriptor 与 command tree

可移植 command 语法属于 Runtime command catalog，不属于某个 TUI-only 或 GUI-only registry。一份 `CommandDescriptor` 包含 discovery 与 invocation 所需的完整树：

```json
{
  "descriptorVersion": "0.1.0",
  "id": "com.example.codex",
  "name": "codex",
  "title": "Codex",
  "description": "Manage Codex integration",
  "children": [
    {
      "id": "com.example.codex.login",
      "name": "login",
      "description": "Authenticate Codex",
      "children": [
        {
          "id": "com.example.codex.login.browser",
          "name": "browser",
          "description": "Use browser authentication",
          "inputSchema": {
            "type": "object",
            "additionalProperties": false
          }
        },
        {
          "id": "com.example.codex.login.device",
          "name": "device",
          "description": "Use device-code authentication",
          "inputSchema": {
            "type": "object",
            "additionalProperties": false
          }
        }
      ]
    },
    {
      "id": "com.example.codex.set",
      "name": "set",
      "description": "Change a Codex setting",
      "children": [
        {
          "id": "com.example.codex.set.native-compaction",
          "name": "native-compaction",
          "arguments": [
            {
              "id": "value",
              "position": 0,
              "required": true,
              "type": "string",
              "enum": ["on", "off"]
            }
          ],
          "options": [],
          "inputSchema": {
            "type": "object",
            "required": ["value"],
            "properties": {
              "value": { "enum": ["on", "off"] }
            },
            "additionalProperties": false
          }
        }
      ]
    }
  ]
}
```

`inputSchema` 校验 InvocationContext 中的 `command.input`。Argument / option declaration 把 Presentation 语法映射为稳定 input property name；raw command token 永远不会跨过 Runtime 协议边界。

正式 contract 必须定义：

- 全局命名空间 command ID 与 sibling-unique syntax token；
- ordered positional argument、named option、subcommand、default、enum、validation、敏感输入标记，以及它们到稳定 input property 的映射；
- terminal node input / output 使用的有界 JSON Schema vocabulary；
- localization 与 alias 只作为 display/input metadata，永远不替换稳定 ID；
- 重复 ID、重复 token、shadowing、深度、大小与 cycle 拒绝规则；
- 每个 terminal operation 的 authorization、timeout、concurrency、disconnect 与 cancellation policy；
- intermediate tree node 被执行时的确定行为。

TUI 可以解析 `/codex login device`，Web UI 可以呈现嵌套控件，但两者最终都生成对 `com.example.codex.login.device` 的同一种 typed invocation。Raw shell command string 不是 Runtime 协议 payload。

当 `login browser` 与 `login device` 代表用户选择时，应优先提供这些明确 command。通用 `login` command 可以协商 flow，但只能检查当前 invocation 的 Presentation capability。

## 11. Ephemeral Presentation channel

短期用户交互不能被塞进持久 session result。在获准 invocation 执行期间，插件可以通过 invocation-scoped Presentation facade 请求一条有界 transient message：

```json
{
  "messageVersion": "0.1.0",
  "messageId": "ephemeral:01K3EXAMPLE",
  "invocationId": "invocation:01K3EXAMPLE",
  "kind": "auth.device-code",
  "sensitivity": "secret",
  "noPersist": true,
  "expiresAt": "2026-08-17T11:55:00Z",
  "content": {
    "verificationUri": "https://example.com/device",
    "userCode": "ABCD-EFGH"
  },
  "affordances": [
    { "type": "link.show", "field": "verificationUri" },
    { "type": "clipboard.copy", "field": "userCode" },
    { "type": "qr.render", "field": "verificationUri" }
  ]
}
```

`noPersist` 永远是 `true`；缺失或为 false 都应拒绝。`expiresAt` 必填，并受对应 message-kind contract 的上限约束。消息到期、detach、取消或 invocation 终止时，都要释放该消息，并要求所有 Presentation 副本清除内容。

初始 sensitivity level 如下：

| 等级 | 最低处理要求 |
| --- | --- |
| `public` | 仍是 transient 且不得进入 session history；只可记录有界诊断 metadata。 |
| `private` | 日志、trace、analytics、crash report 与 notification 都必须裁剪 content。 |
| `secret` | 在 private 规则上，进一步禁止 content cache、offline queue、preview 与 unattended action。 |

`public` 这个名称不会取消 `noPersist`，它只影响诊断裁剪规则。

每种已登记 message kind 都规定最低 sensitivity。Plugin 可以要求更严格处理，但不能降低这一下限；例如无论插件代码填写什么值，`auth.device-code` 永远属于 `secret`。

Affordance 是交互请求，不是无人值守操作指令。`link.open` 与 `clipboard.copy` 既要求匹配的已协商 capability，也要求用户明确操作。QR 只能编码已经审计的字段；Runtime 不发送任意图片或脚本 payload。第一版 URI policy 应只允许 HTTPS，其他 scheme 必须单独评审。

若当前 invocation 无法安全呈现必要消息，handler 应返回 typed `presentation-unavailable` outcome，或走明确规定的 fallback。它不能在 Runtime 侧打开浏览器、把 secret 写入 session log，或借用另一个 attachment 的 Presentation。

## 12. 授权、隐私与安全

Runtime capability、Presentation capability、permission 与 trust evidence 是四件不同的事：

- Runtime capability 表示 Runtime 实现了某项操作；
- Presentation capability 表示已 attach 端点可以按明确 contract 提供某种交互；
- grant 表示已认证 subject 可以在指定 Runtime scope 使用某项操作；
- enforcement 表示 Control 与 execution mode 能阻止未获准路径。

最低要求如下：

1. Control 认证两端，并把 Presentation descriptor、Runtime generation、principal 与 grant 绑定到每次 invocation。
2. Runtime 在执行插件代码前再次授权 command 与 scope；只凭 client 提供的 capability JSON 不可信。
3. Grant 以 Runtime 为 scope 且遵循最小权限；切换 Runtime 需要独立授权决定。
4. Revoke 立即阻止新工作，并按声明策略取消或 drain 现有工作。
5. Dispatch 前校验 invocation ID、attachment ID、generation ID、deadline 与 replay protection。
6. Descriptor 与 context 尽量减少稳定设备标识和个人信息；插件通常只拿到 typed capability facade，看不到认证凭据或 raw Transport metadata。
7. 跨机器 Transport 必须提供 confidentiality、integrity、peer authentication、有界 frame，并抵抗 replay 与资源耗尽。
8. Presentation surface 应标注请求来源插件与 Runtime、清理文本、校验 URI scheme，并把打开链接和写 clipboard 放在用户操作之后。
9. Ephemeral content 不进入 session history、log、telemetry、analytics、crash report、持久 queue 或 reconnect replay。
10. Provenance record 可以包含 ID、时间、状态变化、大小与已裁剪 error code，但不能包含 transient secret content。

这些控制无法阻止 trusted in-process plugin 直接访问 Node.js。RFC 0001 的 execution-mode 限制仍须向用户展示，并写入一致性证据。

## 13. 故障、detach 与恢复语义

故障必须被限制在 scope 内，不能让一个 attachment 破坏另一个：

- **Presentation failure**：detach 它自己的 attachment、清理 transient message，并按每次 invocation 的 disconnect policy 处理；其他 Presentation 保持连接。
- **Transport interruption**：把 attachment 标记为 unavailable、停止新 dispatch，并按已声明策略 drain 或取消进行中工作；不做隐式 replay。
- **Control restart**：拒绝过期 attachment / invocation credential，除非独立定义的 resume protocol 能安全恢复。
- **Runtime generation replacement**：拒绝旧 `generationId` 的 invocation，通过正常 plugin deactivation 清理旧 handler，并重新协商 descriptor。
- **Plugin handler failure**：为该 invocation 返回 typed、已裁剪 failure；在 execution mode 允许时保留 Runtime 与其他无关 handler。
- **Slow consumer**：使用有界 queue 与 backpressure，不能把 transient secret channel 变成持久 backlog。

Cleanup 必须幂等。Detach 与 cancellation 可能产生竞态，因此正式协议必须定义哪个组件拥有 terminal transition，以及重复 cleanup 如何确认。

## 14. 预期开发体验

插件代码在正常 generation activation 期间绑定 handler，随后为每次调用接收 invocation context：

```ts
ctx.commands.handle('com.example.codex.login.browser', async (_input, invocation) => {
  if (invocation.presentation.has('presentation.link.open')) {
    const challenge = await createBrowserChallenge()

    await invocation.presentation.show({
      kind: 'auth.browser-link',
      sensitivity: 'secret',
      noPersist: true,
      expiresAt: challenge.expiresAt,
      content: { verificationUri: challenge.verificationUri },
      affordances: [{ type: 'link.open', field: 'verificationUri' }],
    })

    return await challenge.wait({ signal: invocation.signal })
  }

  return { code: 'presentation-unavailable' }
})
```

Package name 与签名只是示意，关键属性是：

- command metadata 与 tree 是声明式的，invocation 前即可读取；
- handler 已处于 active 状态，每次调用单独收到 typed context；
- capability check 针对本次调用，而非 activation state；
- cancellation 使用 invocation signal；
- transient interaction 走受限 facade，绝不进入 session result；
- 普通 plugin API 不暴露 SSH、WebSocket、local IPC 或“remote”。

Tooling 应从 command input/output schema 生成 TypeScript type，提供 fake Presentation 用于 unit test，并对 undeclared command、缺少 capability check、持久化 transient payload 或 attachment-global state 报错。

## 15. Headless 一致性要求

首个参考 harness 必须在无图形 session 的环境中运行。它使用 fake Runtime、Control、Presentation、Transport 与确定性 clock。

一致性测试至少包括：

1. RuntimeDescriptor、PresentationDescriptor、CommandDescriptor、InvocationContext、result、cancellation 与 ephemeral-message 的 schema fixtures。
2. 两个 capability 不同的 Presentation 并发调用同一个 active handler，且 capability 不泄漏。
3. 一个 Presentation attach 两个 Runtime，grant、generation、cancellation 与 command catalog 彼此独立。
4. 证明 attach、command discovery 与 invocation 都不会激活 inactive plugin。
5. 完整 command tree round trip、typed validation、重复/非法树拒绝，以及不同 renderer 使用相同 command ID。
6. Dispatch 前、执行中、完成后、deadline 与 detach 期间的 cancellation。
7. Transport 丢失、重复、允许 framing 内的乱序、过期 generation、replay 与有界 backpressure fixtures。
8. Ephemeral expiry、裁剪、no persistence、no reconnect replay、gesture gate 与 capability fallback fixtures。
9. 插件代码执行前的 authorization denial、跨 attachment 隔离、grant revoke 与已裁剪 provenance report。
10. 零 capability 的 headless Presentation 得到 typed unavailable，而不是 crash 或尝试打开 browser。

通过 in-memory 测试不能证明 SSH 或 WebSocket adapter。每个 adapter 都要针对同一 semantic suite 发布自身带版本的 Transport 证据。

## 16. Remote SSH 一致性矩阵

Remote SSH 是第一个必须验证的端到端反例，但不是享有特权的架构。

| 场景 | Presentation capability snapshot | 必须成立的断言 |
| --- | --- | --- |
| Remote Runtime + local TUI | text、link display、可选 clipboard；无 browser open | Device flow 在本地呈现；Runtime 不打开 browser。 |
| Remote Runtime + local GUI | text、link display/open、可选 QR | GUI 在用户操作后提供打开动作；Transport 只转发标准消息。 |
| 一个 Runtime + TUI 与 Web UI 并发 | 不同 capability map 与 grant | 每次 invocation 只看到自己的不可变 snapshot；message 与 cancellation 不跨 attachment。 |
| 一个 TUI attach Runtime A 与 Runtime B | 不同 Runtime generation 与 grant | 切换视图不重定向 invocation，也不复用 grant、ephemeral handle 或 cancellation token。 |
| 完整 `/codex` command tree 通过 SSH | Typed command catalog | Root、嵌套 `login browser`、`login device`、option 与 help metadata 完整往返。 |
| Command 期间 SSH 断开 | Operation-specific disconnect policy | Control 在有界时间内进入唯一 terminal outcome；无隐式 replay 与 transient-secret backlog。 |
| Presentation 以不同 capability 重连 | 新 attachment 与 descriptor snapshot | 旧 invocation 保留旧 snapshot；新 invocation 只使用重新协商后的 capability。 |
| 未授权 Presentation 或过期 generation | 任意 | 插件代码执行前拒绝，只产生已裁剪诊断。 |
| Headless client | 空 capability map | Handler 返回 typed unavailable/fallback；不假设 GUI，也不 crash。 |

之后还必须通过 local IPC 与至少一种非 SSH remote Transport 的等价 semantic case，避免标准意外编码 SSH 行为。

## 17. 落地与兼容路径

本 RFC 与 RFC 0001 v0.1 分开推进：

### Phase A：协议文档

- 冻结术语与 ownership 边界；
- 发布带版本的 schema 与合法/非法 fixtures；
- 定义 command tree、invocation、cancellation、attachment 与 ephemeral-message 状态机；
- 定义授权与隐私 threat model。

### Phase B：Headless reference broker

- 实现确定性的 in-memory Control 与 Transport；
- 实现 fake Runtime / Presentation adapter；
- 发布 typed SDK facade 与不泄露来源数据的诊断；
- 通过 multi-Presentation 与 multi-Runtime 隔离测试。

### Phase C：Remote SSH 反例

- 实现一套经过评审、且不改变 plugin API 的 SSH Transport adapter；
- 证明完整 command tree 传输、逐 invocation capability snapshot、cancellation、detach 与 transient device authorization；
- 使用同一 semantic fixtures 对比 local IPC adapter。

### Phase D：独立 Presentation 证据

- 至少两个独立实现的 Presentation product 运行相同 suite；
- 对 capability gap 做明确记录，不伪装实现不支持的行为；
- 发布与版本绑定的一致性证据和已知限制。

任何阶段都不能只凭发布这份 Draft 就创建 package entrypoint 或兼容声明。

## 18. 开放问题

1. Runtime / Presentation descriptor 由哪一方签名或 attestation？如何轮换 key？
2. 哪些 Presentation capability 构成最小可移植初始 registry？
3. `presentation.prompt.select` 应属于本协议，还是单独的 interactive-prompt RFC？
4. 哪类 operation 在 detach 后默认 cancel 或 continue？用户能否覆盖该策略？
5. Retry invocation 前需要什么 deduplication 与 idempotency 证据？
6. 每类 ephemeral message 的最大生命周期、大小与允许 URI scheme 是什么？
7. Reconnect 能否安全恢复 attachment，还是 v0 必须始终新建？
8. 在不形成跨设备跟踪 ID 的前提下，最少可以保留哪些 provenance？
9. Attachment 处于 draining 时如何处理 capability downgrade？
10. 哪些 Control 职责必须集中在一个 trust authority，哪些可以 federation？

## 19. 参考资料与讨论输入

- [RFC 0001：Plugin Manifest、Capability 与事件模型](0001-plugin-manifest-capabilities-events.zh.md)
- [社区 Issue #23：统一插件 API、事件与 SDK 讨论](https://github.com/omdsh-dev/community/issues/23)
- [Remote SSH 反例与 command / presentation 缺口](https://github.com/omdsh-dev/community/issues/23#issuecomment-5306386927)
- [Runtime、Presentation、Control 与 Transport 分层建议](https://github.com/omdsh-dev/community/issues/23#issuecomment-5306670321)
