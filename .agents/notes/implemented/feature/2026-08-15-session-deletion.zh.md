# Agent Note: Users can delete sessions

Status: implemented

[English](2026-08-15-session-deletion.md) | 中文

## Problem

会话列表没有任何删除动作：`archive` 只是隐藏一行并保留日志，删除工作区也只会让其中的会话变成"未分组"。用户想彻底删掉某个会话（或早先润色实现遗留的一次性会话）时没有途径——持久化后端没有删除 API，agent 注册表没有公开的按会话拆除能力，行菜单止步于 重命名/分叉/归档。

## Decision

**会话删除是一次横跨 host 与 client 的完整生命周期移除。** 新增 `session.delete` unary RPC：停止 live agent（若有）、移除内存会话、持久删除日志：

- **持久化**：`SessionPersistence.remove(id)` 是新增抽象方法；coordinator 实现它（拒绝 live 或已预备身份，adopt 并校验存储前缀，然后经后端删除），两个后端各新增 `removeStored` 钩子——JSONL 删除会话目录（POSIX 目录 fsync；Windows 跳过），SQLite 在单个事务中删除 events 与 sessions 行。
- **Agent 拆除**：`AgentLoop.disposeAgent(agent)` 复用 rewind 的生命周期一半——flush 会话的写后缓冲，然后 dispose 循环跟踪的生命周期（停止机器、注销、从 store 移除会话、解构 scope）。运行中的 agent 以 `session-running` 拒绝；客户端先取消。
- **API**：当会话既未附加也未持久化时返回 `session-not-found`，拆除或删除失败返回 `session-delete-failed`，否则返回 `deleted: true`。
- **客户端**：`ctx.sessions.deleteSession` 调用 RPC，成功后本地移除行与实例状态，不等待 host 帧（cold 删除永不发出帧；live 删除的 `session/disposed` 帧到时已无操作）。工作区行菜单新增 Delete 项（危险样式 + 确认对话框，镜像工作区删除）；工作区记账保留过期 id，分组表面将其过滤掉。

## Alternatives considered

- **复用工作区删除语义**（仅注销、保留日志）：不予采纳——用户要求会话及其消息彻底消失；archive 已覆盖"隐藏但保留"。
- **复用回退的 truncate 路径**：不予采纳——截断保留前缀；删除是移除整个身份。
- **在 API 层直接删文件**：不予采纳——删除必须走 coordinator，才能拒绝 live/已预备身份、排空写后缓冲，并让两个后端（JSONL 与 SQLite）原子删除。

## Consequences

- 被删除的会话立即从列表消失（本地移除），并从持久化中消失（持久删除）；重新打开报 not-found。
- 删除运行中的会话以 `session-running` 拒绝；用户先取消。
- 工作区 `sessionIds` 保留已删除 id；分组表面将其过滤掉，因此无需改写 host 侧记账。
- `AgentRegistry` 保持 owner 作用域：新拆除能力放在循环（结构性 provider）上，而不是注册表上。
