# @deepseek-ai/dsh-client-ui-polish

[English](README.md) | 中文

输入区润色按钮：`conversation.input.right` 列表条目，位于输入区工具行的**模型选择器左侧**。它通过镜像会话自身 provider/模型选择的一次性隔离会话（[`dsh-polish`](../../interaction/polish/README.md)）润色并扩展当前草稿——可见会话绝不会被触碰——然后把返回文本替换到草稿中，供用户确认后再发送。

按钮文案是纯 `润色` / `Polish`，润色回合进行中切换为 `润色中…` / `Polishing…`。草稿为空或润色进行中时按钮禁用；失败通过共享的瞬时 Toast 提示。

## 注册

- **Slot**：`conversation.input.right`（id `polish`，order 10）——由 ui-conversation 的 composer-bar 条目声明并定型。
- **依赖**：由 Client 组装（`@deepseek-ai/dsh-api-remotes`）挂载的 polish Remote（`ctx.remote.polish`）；会话标准套件的 `useInput`／`inputActions` 提供实时草稿与唯一草稿写路径。
- **组合**：`packages/bundle/web-app/cordis.patch.yml` 将此包与 `dsh-polish`、`ui-model-selection` 一同挂载。

## Model Experience

### 润色回合

#### 模型看到什么

一条包含润色指令与原文逐字内容的用户消息，投递给一次性会话（见 `dsh-polish`）；模型回复绝不会被自动发送——它替换输入区草稿供用户确认。

#### Token 影响

每次点击在一次性会话中产生一次模型请求；可见会话日志中不保留任何内容。

#### KV Cache 影响

一次性上下文既不复用也不使可见会话的前缀缓存失效。

## Known Limitations and Deferred Work

- **冷会话不润色** —— polish Remote 要求 live 目标 agent；Web GUI 始终操作 live 会话。
