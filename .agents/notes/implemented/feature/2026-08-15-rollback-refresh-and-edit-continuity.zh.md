# Agent Note: Rollback cleans the visible conversation; the edit fold survives continuation

Status: implemented

[English](2026-08-15-rollback-refresh-and-edit-continuity.md) | 中文

## Problem

会话变更后的两个可见缺口。其一，**回退不清除可见的上下文和文本**：live 回退会先移除会话再以截断后的日志重新添加，但客户端的常驻 Session 实例一直停留在 `removed` 标记（输入被禁用）且窗口仍是回退前的旧数据——被丢弃的消息留在屏幕上，会话看起来不可用。冷会话更糟：回退要求 live agent，否则返回 `session-not-found`，重新打开的会话根本无法回退。其二，**编辑后继续使用**需要验证：message-edit 折叠与下一回合必须在真实 Session 上共存（折叠更新同一条节点、下一条用户消息追加新节点、会话保持可用）。

## Decision

**回退会刷新常驻窗口，并支持冷会话。**

- **客户端重置**：`Session.resetConversationWindow()` 清除 `removed` 标记、事件窗口与 open 状态，再经共享的 `resync` 路径重新拉取历史。manager 在 `host/session-added` 且常驻实例为 `removed` 时调用它（回退的重新添加）；`ui-rollback` 在任意一次回退成功后也调用它，使视图即使在 host 帧到达前也能刷新。
- **冷会话回退**：`RollbackService.rollback` 不再要求 live agent。冷持久化会话先加载、从日志解析 cut seq、对丢弃区间内的文件 diff 做逆应用（同一代码回退路径）、再用 `persistence.truncate` 直接截断持久日志。会话保持 cold——下一次 prompt 会用完整组合（preset + 选择）恢复它，不同于裸恢复会让会话失去工具。
- **编辑连续性**：在真实 Session 与真实 message Definition 上验证——替换按 message id 折叠进同一条节点，再次编辑继续折叠，下一回合追加新节点且会话保持可用（`removed` 为 false、composer 活跃）。客户端构建的折叠事件使用修剪后的文本，与 host 一致。

## Alternatives considered

- **为冷回退裸恢复 agent**：不予采纳——恢复缺少 preset 组合（工具、选择），api-proxy 在下次 prompt 时原样返回该 agent，会话将失去工具。截断并保持 cold 让常规 prompt 路径正确组合。
- **仅以 rewind 帧作为唯一刷新**：不予采纳——冷回退根本不产生帧；直接重置也让 live 情形在帧延迟时更稳健。

## Consequences

- 回退现在会从视图上移除被丢弃的消息（上下文和文本）并重新启用输入；客户端窗口重新拉取截断后的日志。
- 冷会话可以用同一个按钮回退；会话在下一次发送前保持 cold。
- 编辑折叠被证明能在真实 Session 层继续存活（重复编辑与后续回合）；折叠文本使用修剪后的内容，与 host surface 一致。
