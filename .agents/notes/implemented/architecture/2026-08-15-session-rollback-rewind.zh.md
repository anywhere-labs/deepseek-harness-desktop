# Agent Note: Session rollback rewinds the event log at a turn boundary

Status: implemented

[English](2026-08-15-session-rollback-rewind.md) | 中文

## Problem

Web GUI 需要回退能力：用户选中一条助手消息，会话——上下文与模型消息——恢复到该点之前，并可选地尽力撤销被删除区间产生的代码改动。会话日志是追加式的，且是真相源，因此用户回退不能只是呈现层操作；剪日志也不是普通文件操作。代理循环的生命周期清理会异步（write-behind）追加 `agent/inbox/spliced` 尾部记录，如果截断发生在这批写入排空之前，截断点之后仍会落下事件。持久化协调器维护每会话游标与 live/prepared 预留，截断必须尊重或使其失效。在 Turn 中间切割会留下没有闭合器的 `turn/start`，冷修复随后会用合成 closers 去"修复"它——这与回退的意图相反。

## Decision

回退实现为四层 rewind，每层拥有一个不变量：

1. **持久化截断**——`SessionPersistence.truncate(id, toSeq)` 保留 `seq < toSeq` 的事件。`PersistenceCoordinator.truncate` 校验非负安全整数 `toSeq`，拒绝 live 或 prepared 身份，拒绝超过已存储游标的 `toSeq`，在每会话链下串行化，并在重写前排空活动 controller 的 pending write-behind——确保没有延迟追加会落在切割点之后。JSONL 后端重新编码存活前缀并原子替换文件（POSIX 上 rename + 目录 fsync；win32 上 remove + publish），SQLite 后端在单个事务中删除尾部行并递增 `revision`。不支持该钩子的后端响亮拒绝。
2. **代理 rewind**——`ctx.agentLoop.rewind(agent, toSeq)` 先 flush 会话，再 dispose 代理（运行所有已注册的 teardown，inbox-splice 尾部正是由此产生），然后截断，最后以 `clear` 作为启动源恢复同一身份。因此截断看到的是 dispose 后的完整日志。
3. **回退服务**——`@deepseek-ai/dsh-rollback` 暴露一个 `@Remote('rollback')` 动词。它将所选消息 seq 解析到其 `turn/start`（Turn 边界，因此存活前缀结束于前一个 `turn/end`，保持平衡），可选地按逆应用顺序收集被删除区间的 `tool/result` `meta.diffs`，尽力反向应用每个 hunk（精确 `newText` 匹配；在 hunk 记录之后被编辑过的文件记一个失败，绝不猜测），然后 rewind。失败构成闭集词汇：`session-not-found`、`message-seq-out-of-range`、`no-turn`、`rewind-failed`。
4. **前导助手消息操作**——ui-conversation 声明新的 `conversation.chat.assistant-leading-actions` 列表座位，渲染在内置复制控件之前；`@deepseek-ai/dsh-client-ui-rollback` 贡献回退条目：图标按钮（专属 `IconRollbackOutline16`）、带**同时回退代码**复选框（默认不勾选）的确认对话框，以及报告切割点与已撤销/失败 hunk 数量的结果 Toast。

## Alternatives considered

- **仅呈现层回退**（在 UI 中隐藏消息）：不予采纳——持久日志与重放仍包含被删除区间，重连或重载会使其复活；会话日志是真相源。
- **中间切割加修复事件**：不予采纳——删除一个 Turn 必须在不使用合成 closers 的情况下保持平衡；在 `turn/start` 切割无需修复，也让冷检查保持诚实。
- **代码回退要么致命要么全做**：不予采纳——文件系统可能已经前进（模型或用户在 hunk 记录后编辑过文件）；回退仍匹配的部分并报告其余部分才是诚实的结果，绝不让回退被阻塞。
- **复用尾部 `assistant-actions` 条带**（复制与分支之间）：不予采纳——按钮属于复制左侧，整体移动条带会挪动既有反馈控件；前导座位让两种布局都保持稳定。

## Consequences

- 切割点总是 Turn 边界，存活日志平衡且无需修复事件；会话以同一身份恢复并自切割点继续。
- 回退是持久的：持久化截断意味着重启后会话恢复到切割点，而不是回退前的尾部。
- 代码回退是 best-effort：部分失败作为 `codeFailures` 返回并显示在成功 Toast 中；绝不猜测文件系统。
- 一次只能回退一次：rewind 进行中确认对话框的操作被禁用；恢复后后续 Turn 重新可用。
- 正常追加路径不变；截断是显式用户操作，一次性重写 JSONL 前缀（见 [session persistence](../../../../packages/session/session-persistence-jsonl/README.md)），这是 [2026-06-14-session-persistence.md](2026-06-14-session-persistence.md) 中"从不重写"规则的唯一例外。
