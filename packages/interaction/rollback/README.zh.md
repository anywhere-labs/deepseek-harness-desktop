# @deepseek-ai/dsh-rollback

[English](README.md) | 中文

基于 agent-loop rewind 的会话回退：将会话——上下文与模型消息——恢复到某条消息之前，可选地撤销被删除区间在 `edit`/`write` 工具结果上记录的文件改动。调用方（Web 助手消息回退按钮）按 seq 选定一条消息；服务在该消息的 **Turn 起点** 切割，因此存活日志结束于前一个 `turn/end`，保持平衡且无需修复事件。

切割是持久的：持久化截断已存储的日志（JSONL 原子重写存活前缀；SQLite 在单个事务中删除尾部行），在线代理被 dispose 并以同一身份恢复，会话从切割点继续。**冷**持久化会话（无在线代理）直接经持久化截断并保持冷态——下一次 prompt 会用完整组合恢复它。rewind 的次序是刻意的——flush、dispose（这会追加 inbox-splice 尾部）、截断、恢复——因此不会有延迟写入落在切割点之后。

代码回退是 best-effort，绝不致命：被删除区间的 `tool/result` `meta.diffs` 按逆应用顺序收集，每个 hunk 以精确 `newText` 匹配反向应用。在 hunk 记录之后被编辑过的文件，或位于会话工作区之外的 hunk，会被报告为失败；回退本身仍然成功。调用方报告已撤销与失败的 hunk 数量。

## Remote API

服务在 `rollback` 命名空间下注册一个 Typert Remote 方法，由 Client 装配（`@deepseek-ai/dsh-api-remotes`）挂载：

| Method | Request | Result |
|---|---|---|
| `rollback` | `{ sessionId, messageSeq, code? }` | `{ ok: true, value: { cutSeq, codeReverted, codeFailures } }` 或封闭失败 |

失败构成闭集词汇：`session-not-found`（既非在线也非持久化）、`message-seq-out-of-range`（seq 不是当前日志中的消息）、`no-turn`（seq 不属于任何 Turn）、`rewind-failed`（回退抛出异常；会话未被触碰，但文件可能已被部分回退）。

## 模型体验

### 回退与模型

#### 模型看到什么

什么都不会看到：回退是用户对已完成 Turn 的操作。被删除区间从日志中消失——切割点是所选消息的 `turn/start`——模型不会再看到它；存活前缀逐字节相同。

#### Token 影响

删除事件会将其 token 从持久日志与之后的每次请求中释放。

#### KV Cache 影响

前缀稳定；截断从不重写更早的事件，因此可复用的请求前缀不受影响。代码回退发生在文件系统上，不在会话日志中。

## 已知限制与延后工作

- **代码回退基于 hunk 文本**——若文件在记录改动后被再次编辑，可能不再包含精确的 `newText`，该改动块会被报告为失败而不是猜测处理。
- **一次只能回退一次**——循环会 dispose 并恢复代理；对同一会话的并发回退会被在线代理守卫拒绝，第一次回退后的第二次回退只是针对已缩短的日志。
