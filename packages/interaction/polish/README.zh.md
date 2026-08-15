# @deepseek-ai/dsh-polish

[English](README.md) | 中文

基于会话自身 agent 通道的输入润色：使用会话当前正在使用的 provider、模型与凭据，在保持原意不变的前提下润色并扩展用户消息。润色请求作为 plugin 来源的 `user/message` 投递，模型回复作为普通 `assistant/message` 落入日志，因此整个操作可从会话日志完整重建，不引入任何新协议——调用方（Web 输入区的润色按钮）把返回文本替换到草稿中，供用户确认后再发送。

## Remote API

服务在 `polish` 命名空间注册两个 Typert Remote 方法，由 Client 组装（`@deepseek-ai/dsh-api-remotes`）挂载：

| 方法 | 请求 | 结果 |
|---|---|---|
| `polish` | `{ sessionId, message }` | `{ ok: true, value: { text } }` 或一个闭集失败 |
| `model` | `{ sessionId }` | `{ label }` — 会话当前模型标签，用于按钮文案 |

`polish` 要求 `sessionId` 对应的 **live** agent；冷会话不会为润色轮次恢复（否则返回 `session-not-found`）。草稿会先去除首尾空白，必须非空（`message-blank`），且不得超过配置的 `maxMessageChars`（`message-too-long`）。followup 之后服务等待 agent 达到静止，返回请求之后追加的第一条非空 assistant 消息；回复没有文本时报告 `no-result`。

## Config

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxMessageChars` | `20000` | 输入草稿的最大字符数。 |

## Model Experience

### 润色提示词

#### 模型看到什么

一条包含润色指令与原文逐字内容的用户消息。指令固定原意、要求用原文语言写出更清晰完整的版本，并要求答案只能是润色后的文本——不带任何解释、前缀、引号或工具调用。返回文本绝不会被自动发送；调用方将其放入输入区供用户确认。

#### Token 影响

一次模型请求，加上留在会话日志中的草稿与回复。与任何 assistant 消息一样，回复保留在历史中直到压缩。

#### KV Cache 影响

追加式：新的用户消息跟随可复用的请求前缀，不会使既有缓存条目失效。

## Known Limitations and Deferred Work

- **并发人类回合与结果读取存在竞态** —— 润色回复是请求之后的第一条非空 assistant 消息；在润色回合运行期间被接收的人类回合追加在其后，因此不会遮蔽润色结果；但在润色回合之前被接收、之后才完成的人类消息可能先于润色回复出现在日志中。输入区在润色进行中禁用按钮，使得该竞态在已发布的 UI 上不可达。
- **冷会话不润色** —— 为润色回合恢复持久化会话是刻意排除的范围；Web GUI 始终操作 live 会话。
