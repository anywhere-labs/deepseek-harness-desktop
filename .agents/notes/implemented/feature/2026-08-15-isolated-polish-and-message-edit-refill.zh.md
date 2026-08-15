# Agent Note: Polish runs in a throwaway session; sent user messages refill the composer

Status: implemented

[English](2026-08-15-isolated-polish-and-message-edit-refill.md) | 中文

## Problem

实际使用暴露出两个产品缺口。其一，输入润色把润色请求作为 plugin 来源的 `user/message` 投递到**可见**会话并读取第一条 assistant 回复：会话里多了一个用户从未发送过的真实回合，润色回合可能与并发的人类回合竞态，按钮文案还硬编码了模型标签。用户希望润色按钮就是 `润色`／`Polish`，润色本身发生在一个看不见的地方：单独一个会话接收用户消息、返回润色文本、随后被丢弃——只替换输入区草稿，绝不发送。其二，已发送的用户消息无法编辑：编辑 stub 被刻意移除（[drop-user-message-edit-stub](../../../.agents/notes/implemented/simplification/2026-07-31-drop-user-message-edit-stub.md)），没有任何途径把之前发送的消息取回修改。

## Decision

**润色在一次性会话中运行。** `dsh-polish` 不再向目标会话追加任何内容。`PolishService.polish` 创建一个全新 agent（`ctx.agents.create`，session id 用 `randomUUID`），继承目标 agent 的 `provider`／`model` 选项，把润色指令作为 plugin 来源的 `user/message` 投递给它，等待静止，取第一条非空 assistant 文本，并在 `finally` 中 dispose 句柄——该会话永不持久化，也永不出现于界面。目标会话日志保持逐字节不变；目标仍必须在线（否则 `session-not-found`）。创建或驱动一次性会话失败返回 `polish-session-failed` 并附底层消息；回复无文本返回 `no-result`。`model` Remote 方法与 `PolishModelRequest`／`PolishModelResult` 词汇被删除，按钮文案改为纯 `润色`／`Polish`（进行中为 `润色中…`／`Polishing…`）。

**编辑已发送的用户消息是回填输入区。** `MessageIconActions` 新增 `onEdit` 控件，渲染在复制之前；用户消息渲染器把它接到会话标准套件的 `inputActions.setDraft`，填入消息纯文本（消息无文本时隐藏）。这刻意**不是**就地改写历史：消息被加载进输入区，用户修改后作为新消息发送。对已定稿日志消息的真正变更以及 host 侧重放行为，按先前决策继续延后。

## Alternatives considered

- **让润色回合留在可见会话**（现状）：不予采纳——它会污染用户从未发送过的回合、与人类回合竞态，也无法被描述为"看不见"。
- **服务直接调用 LLM**（绕过 agent 循环）：不予采纳——provider/模型解析、凭据、重试与提示词装配都由 agent 循环拥有；一次性 agent 用一次 `create` 调用全部复用。
- **就地编辑消息**（改写日志中的用户消息并重放后续回合）：不予采纳——事件溯源日志没有廉价的改写路径，重放已消费回合正是先前删除决策延后的、rollback 级别的机制；回填输入区以零日志影响覆盖了真实需求（修改后重发）。

## Consequences

- 可见会话不受润色影响：没有幽灵用户消息、没有与并发回合的竞态、会话日志中没有额外 token。
- 一次性润色回合无法从可见日志重建——接受，并作为 `dsh-polish` 的已知限制记录；持久记录需要新的事件种类。
- 润色按钮语言中立（`润色`／`Polish`），无模型标签；删除的 `model` Remote 缩小了表面积。
- 已发送的用户消息恢复可编辑（回填输入区）；历史保持权威，修改后的消息作为新消息发送。
