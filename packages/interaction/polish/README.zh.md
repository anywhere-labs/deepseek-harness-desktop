# @deepseek-ai/dsh-polish

[English](README.md) | 中文

以直接模型调用的方式润色输入：使用目标会话已有的同一 provider/模型/凭据解析，在保持原意不变的前提下润色并扩展用户消息。润色请求通过 `ctx.llm.prepareCall` 发起一次流式模型调用——不创建任何会话、不写入任何日志、完全不触碰可见会话。调用方（Web 输入区的润色按钮）把返回文本替换到输入区草稿中，供用户确认后再发送。

## Remote API

服务在 `polish` 命名空间注册一个 Typert Remote 方法，由 Client 组装（`@deepseek-ai/dsh-api-remotes`）挂载：

| 方法 | 请求 | 结果 |
|---|---|---|
| `polish` | `{ sessionId, message }` | `{ ok: true, value: { text } }` 或一个闭集失败 |

`polish` 解析目标 `sessionId` 的 agent 以读取其 provider/模型选择；没有 live agent 的会话返回 `session-not-found`（刻意不为润色恢复冷会话的选择）。草稿会先去除首尾空白，必须非空（`message-blank`），且不得超过配置的 `maxMessageChars`（`message-too-long`）。流式回复按文本累积；回复没有文本时报告 `no-result`，调用失败时报告 `polish-failed` 并附底层消息。

## Config

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxMessageChars` | `20000` | 输入草稿的最大字符数。 |

## Model Experience

### 润色提示词

#### 模型看到什么

一条包含润色指令与原文逐字内容的用户消息，作为一次直接请求发送到目标会话的 provider/模型选择上。指令固定原意、要求用原文语言写出更清晰完整的版本，并要求答案只能是润色后的文本——不带任何解释、前缀、引号或工具调用。返回文本绝不会被自动发送；调用方将其放入输入区供用户确认。

#### Token 影响

每次点击一次模型请求，由已配置凭据计费；目标会话日志中不保留任何内容。

#### KV Cache 影响

直接调用使用全新请求上下文，不复用目标会话的前缀缓存；也因为目标日志未被触碰，绝不会使其失效。

## Known Limitations and Deferred Work

- **会话日志中没有润色回合的记录** —— 直接调用不写任何持久数据，润色无法从任何会话日志重建。目标会话日志保持逐字节不变，这正是目的；如果可审计性将来重于干净性，需要新增事件种类来持久记录。
- **冷会话不润色** —— 不恢复持久化会话就解析其选择是刻意排除的范围；Web GUI 始终操作 live 会话。
