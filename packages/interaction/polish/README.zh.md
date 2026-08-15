# @deepseek-ai/dsh-polish

[English](README.md) | 中文

在隔离的一次性会话中润色输入：使用目标会话已有的同一 provider/模型/凭据解析，在保持原意不变的前提下润色并扩展用户消息。润色请求交给一个只运行一个回合的全新 agent——目标会话的日志永远不会被追加，可见会话保持干净，草稿永远不会变成真实消息——回复落定后该 agent 即被销毁。调用方（Web 输入区的润色按钮）把返回文本替换到输入区草稿中，供用户确认后再发送。

## Remote API

服务在 `polish` 命名空间注册一个 Typert Remote 方法，由 Client 组装（`@deepseek-ai/dsh-api-remotes`）挂载：

| 方法 | 请求 | 结果 |
|---|---|---|
| `polish` | `{ sessionId, message }` | `{ ok: true, value: { text } }` 或一个闭集失败 |

`polish` 要求 `sessionId` 对应的 **live** agent（它镜像该会话的 provider/模型）；冷会话不会为润色回合恢复（否则返回 `session-not-found`）。草稿会先去除首尾空白，必须非空（`message-blank`），且不得超过配置的 `maxMessageChars`（`message-too-long`）。一次性 agent 只运行一个回合；回复没有文本时报告 `no-result`，创建或驱动一次性会话失败时报告 `polish-session-failed` 并附底层消息。

## Config

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxMessageChars` | `20000` | 输入草稿的最大字符数。 |

## Model Experience

### 润色提示词

#### 模型看到什么

一条包含润色指令与原文逐字内容的用户消息，以插件来源的 `user/message` 投递给一次性会话；模型回复以普通 `assistant/message` 落盘于该会话，随后整个会话被销毁。指令固定原意、要求用原文语言写出更清晰完整的版本，并要求答案只能是润色后的文本——不带任何解释、前缀、引号或工具调用。返回文本绝不会被自动发送；调用方将其放入输入区供用户确认。

#### Token 影响

每次点击一次模型请求，由一次性会话的 token 计量支付；目标会话日志中不保留任何内容。

#### KV Cache 影响

一次性会话是全新上下文，润色回合不复用目标会话的前缀缓存；也因为目标日志未被触碰，绝不会使其失效。

## Known Limitations and Deferred Work

- **会话日志中没有润色回合的记录** —— 一次性会话被销毁，润色无法从可见会话重建。目标会话日志保持逐字节不变，这正是目的；如果可审计性将来重于干净性，需要新增事件种类来持久记录。
- **冷会话不润色** —— 恢复持久化会话以镜像其选择是刻意排除的范围；Web GUI 始终操作 live 会话。
