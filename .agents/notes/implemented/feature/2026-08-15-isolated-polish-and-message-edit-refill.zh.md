# Agent Note: Polish is a direct model call; sent user messages are edited in place

Status: implemented

[English](2026-08-15-isolated-polish-and-message-edit-refill.md) | 中文

## Problem

实际使用暴露出两个产品缺口。其一，输入润色把润色请求作为 plugin 来源的 `user/message` 投递到**可见**会话并读取第一条 assistant 回复：会话里多了一个用户从未发送过的真实回合，润色回合可能与并发的人类回合竞态，按钮文案还硬编码了模型标签。用户希望润色按钮就是 `润色`／`Polish`，润色本身在看不见的地方发生：只替换输入区草稿，绝不发送，而且**不创建任何会话**。其二，已发送的用户消息无法编辑：编辑 stub 被刻意移除（[drop-user-message-edit-stub](../../../.agents/notes/implemented/simplification/2026-07-31-drop-user-message-edit-stub.md)），没有任何途径把之前发送的消息取回修改。

## Decision

**润色是一次直接模型调用——不建会话、不写日志。** `dsh-polish` 不再向目标会话追加内容，也不再创建一次性 agent。`PolishService.polish` 解析目标 agent 的 `provider`／`model` 选项，通过 `ctx.llm.prepareCall` 发起一次流式请求，正如"直接问 AI"：指令与原文逐字内容合成一条 `user/message`，把 text-delta 块累积成回复。目标会话日志保持逐字节不变；目标仍必须在线（否则 `session-not-found`）。调用失败返回 `polish-failed` 并附底层消息；回复无文本返回 `no-result`。`model` Remote 方法与 `PolishModelRequest`／`PolishModelResult` 词汇被删除，按钮文案改为纯 `润色`／`Polish`（进行中为 `润色中…`／`Polishing…`）。早先润色尝试遗留的持久化一次性会话由新增的会话删除功能清理。

**编辑已发送的用户消息是就地改写。** `MessageIconActions` 新增 `onEdit` 控件，渲染在复制之前；用户消息渲染器把气泡换成预载消息全文的编辑框（编辑框使用标准输入 token——此前因为引用未定义的主题 token 而丢失了边框）。保存时调用 `messageEdit` Remote（`dsh-message-edit`），追加一条**复用原消息 id** 的替换 `user/message`，带遮蔽目标的 `replace` surface 操作：surface 折叠（以及其后的每一次模型请求）看到新文本；UI 经消息 Definition 的 `update` 路径把替换折叠进同一条消息节点。日志保持追加式；已经消费旧措辞的回合不会重放。**live 与 cold 会话都可编辑**：live 会话经其 agent 追加（事件广播给查看者），cold 持久化会话经 `sessionPersistence` 追加（不为改文本而恢复 agent）。客户端根据返回的 seq 在本地折叠替换事件——cold 会话永无广播，seq 守卫在 live 广播同时到达时丢弃重复（折叠只读替换标记的存在性而非其范围，因此客户端用自己已发出的请求重建事件）。

## Alternatives considered

- **让润色回合留在可见会话**（现状）：不予采纳——它会污染用户从未发送过的回合、与人类回合竞态，也无法被描述为"看不见"。
- **在隐藏的一次性会话中运行润色**（中间实现）：在用户进一步反对后不予采纳——即使是隐藏会话也是真实会话（列表条目、持久化工件、生命周期开销）；用户明确要求根本不建会话。直接调用通过 `ctx.llm.prepareCall` 复用相同的 provider/模型/凭据解析，而一次性文本改写并不需要循环的会话机制。
- **回填输入区式编辑**（把消息加载进输入区、修改后作为新消息重发）：在用户澄清意图后不予采纳——编辑后的消息必须仍是**同一条**消息，而不是产生一条重复消息。就地编辑可以复用现有 surface 机制实现：折叠本就支持位置替换（compaction 在用），复用原消息 id 让所有引用保持稳定。
- **就地改写日志事件**：不予采纳——追加式日志是持久契约；替换事件同时保留两个版本且保持重放忠实。
- **编辑要求 live agent**（最初实现）：在真实使用中从重新打开的（cold）会话编辑失败后不予采纳——用户正是在重开的会话里编辑旧消息；仅为一次文本编辑而恢复 agent 会运行启动指令和标题生成。持久化追加路径直接编辑 cold 日志。

## Consequences

- 可见会话不受润色影响：没有幽灵用户消息、没有与并发回合的竞态、会话日志中没有额外 token，且自始至终不存在任何会话对象。
- 润色回合无法从任何日志重建——接受，并作为 `dsh-polish` 的已知限制记录；持久记录需要新的事件种类。
- 润色按钮语言中立（`润色`／`Polish`），无模型标签；删除的 `model` Remote 缩小了表面积。
- 编辑后的消息保持 id 与位置：没有重复气泡、引用稳定，之后从 surface 重建的模型请求看到新文本。已经回应旧措辞的 assistant 回复不会重放——接受并记录；真正重排受影响回合的能力仍然延后。
- 重新打开的会话无需恢复 agent 即可编辑；返回的事件被本地折叠，cold 会话的气泡立即更新。
- 会话删除（见会话删除 note）会移除早先润色尝试持久化遗留的一次性会话。
