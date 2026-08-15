# @deepseek-ai/dsh-client-ui-rollback

[English](README.md) | 中文

助手消息回退按钮：`conversation.chat.assistant-leading-actions` 条带的条目，位于已定稿助手消息操作栏中**复制按钮的左侧**。点击后弹出确认对话框；确认后通过回退 Remote（[`dsh-rollback`](../../interaction/rollback/README.md)）将会话回退到该消息之前——上下文与模型消息被恢复，会话从更早的点继续。

对话框提供可选的**同时回退代码**复选框（默认不勾选）：勾选后，先尽力反序撤销被删除区间在 `edit`/`write` 工具结果上记录的文件改动——无法应用的改动块会被报告，但绝不致命。成功与失败通过共享的瞬时 Toast 提示；成功提示包含已撤销的代码改动数量与未能撤销的数量。

回退按钮每个 Turn 渲染一次，位于持有该 Turn 操作栏的收尾助手消息上——与尾部 `assistant-actions` 条带遵循同一规则。被中断冻结的部分输出不带 `messageId`，因此没有回退控件。

## 注册

- **Slot**：`conversation.chat.assistant-leading-actions`（id `rollback`，order 10）——由 ui-conversation 的 turn-tail 条目声明与类型化，渲染在内置复制控件之前。
- **依赖**：由 Client 装配（`@deepseek-ai/dsh-api-remotes`）挂载的回退 Remote（`ctx.remote.rollback`）。
- **组合**：`packages/bundle/web-app/cordis.patch.yml` 将本包与 `dsh-rollback` 一并挂载。

## 模型体验

### 回退与模型

#### 模型看到什么

什么都不会看到：回退是用户对已完成 Turn 的操作。会话日志在所选消息的 `turn/start` 处被截断，模型不会再看到被删除的事件。

#### Token 影响

删除事件会将其 token 从持久日志与之后的每次请求中释放；保留的前缀保持不变。

#### KV Cache 影响

前缀稳定；截断从不重写更早的事件，因此可复用的请求前缀不受影响。代码回退发生在文件系统上，不在会话日志中。

## 已知限制与延后工作

- **仅限在线会话**——回退 Remote 要求在线代理；Web GUI 始终运行于在线会话。
- **代码回退基于 hunk 文本**——若文件在记录改动后被再次编辑，可能不再包含精确的 `newText`，该改动块会被报告为失败而不是猜测处理。
- **一次只能回退一次**——回退进行中确认对话框的操作被禁用；会话在截断点恢复后，后续 Turn 重新可用。
