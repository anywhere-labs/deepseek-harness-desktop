# Agent Note: Polish runs in a throwaway session; sent user messages are edited in place

Status: implemented

[English](2026-08-15-isolated-polish-and-message-edit-refill.md) | 中文

## Problem

实际使用暴露出两个产品缺口。其一，输入润色把润色请求作为 plugin 来源的 `user/message` 投递到**可见**会话并读取第一条 assistant 回复：会话里多了一个用户从未发送过的真实回合，润色回合可能与并发的人类回合竞态，按钮文案还硬编码了模型标签。用户希望润色按钮就是 `润色`／`Polish`，润色本身发生在一个看不见的地方：单独一个会话接收用户消息、返回润色文本、随后被丢弃——只替换输入区草稿，绝不发送。其二，已发送的用户消息无法编辑：编辑 stub 被刻意移除（[drop-user-message-edit-stub](../../../.agents/notes/implemented/simplification/2026-07-31-drop-user-message-edit-stub.md)），没有任何途径把之前发送的消息取回修改。

## Decision

**润色在隐藏的一次性会话中运行。** `dsh-polish` 不再向目标会话追加任何内容。`PolishService.polish` 创建一个全新 agent（`ctx.agents.create`，session id 用 `randomUUID`），继承目标 agent 的 `provider`／`model` 选项，把会话标记为 `meta.hidden`（`session.list` 及一切派生表面因此排除它），把润色指令作为 plugin 来源的 `user/message` 投递给它，等待静止，取第一条非空 assistant 文本，并在 `finally` 中 dispose 句柄——该会话永不持久化，也永不出现于界面。目标会话日志保持逐字节不变；目标仍必须在线（否则 `session-not-found`）。创建或驱动一次性会话失败返回 `polish-session-failed` 并附底层消息；回复无文本返回 `no-result`。`model` Remote 方法与 `PolishModelRequest`／`PolishModelResult` 词汇被删除，按钮文案改为纯 `润色`／`Polish`（进行中为 `润色中…`／`Polishing…`）。

**编辑已发送的用户消息是就地改写。** `MessageIconActions` 新增 `onEdit` 控件，渲染在复制之前；用户消息渲染器把气泡换成预载消息全文的编辑框。保存时调用 `messageEdit` Remote（`dsh-message-edit`），追加一条**复用原消息 id** 的替换 `user/message`，带遮蔽目标的 `replace` surface 操作：surface 折叠（以及其后的每一次模型请求）看到新文本；UI 经消息 Definition 的 `update` 路径把替换折叠进同一条消息节点。日志保持追加式；已经消费旧措辞的回合不会重放。

## Alternatives considered

- **让润色回合留在可见会话**（现状）：不予采纳——它会污染用户从未发送过的回合、与人类回合竞态，也无法被描述为"看不见"。
- **服务直接调用 LLM**（绕过 agent 循环）：不予采纳——provider/模型解析、凭据、重试与提示词装配都由 agent 循环拥有；一次性 agent 用一次 `create` 调用全部复用。
- **回填输入区式编辑**（把消息加载进输入区、修改后作为新消息重发）：在用户澄清意图后不予采纳——编辑后的消息必须仍是**同一条**消息，而不是产生一条重复消息。就地编辑可以复用现有 surface 机制实现：折叠本就支持位置替换（compaction 在用），复用原消息 id 让所有引用保持稳定。
- **就地改写日志事件**：不予采纳——追加式日志是持久契约；替换事件同时保留两个版本且保持重放忠实。

## Consequences

- 可见会话不受润色影响：没有幽灵用户消息、没有与并发回合的竞态、会话日志中没有额外 token，一次性会话经 `meta.hidden` 被排除在 `session.list` 之外。
- 一次性润色回合无法从可见日志重建——接受，并作为 `dsh-polish` 的已知限制记录；持久记录需要新的事件种类。
- 润色按钮语言中立（`润色`／`Polish`），无模型标签；删除的 `model` Remote 缩小了表面积。
- 编辑后的消息保持 id 与位置：没有重复气泡、引用稳定，之后从 surface 重建的模型请求看到新文本。已经回应旧措辞的 assistant 回复不会重放——接受并记录；真正重排受影响回合的能力仍然延后。
