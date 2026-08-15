# Agent Note: 基于会话自身 agent 通道的输入润色

[English](2026-08-15-composer-polish-and-ui-motion.md) | 中文

Status: implemented

## Problem

Web GUI 输入区在发送前没有任何改进草稿的手段。希望写出更清晰、更完整消息的用户只能手动重写，或先发送再迭代，浪费一整轮。自然的做法——模型选择器旁放一个"润色"按钮——需要一个 host 侧操作，用会话当前正在使用的同一 provider、模型与凭据重写草稿，以及一个 client 侧入口把结果放回输入区供确认。

## Decision

新 host 包 `dsh-polish`（`packages/interaction/polish`）注册一个 Typert Remote 命名空间（`polish`/`polish`、`polish`/`model`），**通过会话自身的 agent 通道**重写草稿：请求作为 plugin 来源的 `user/message`（`source: { kind: 'plugin', plugin: 'dsh-polish' }`）投递，模型回复作为普通 `assistant/message` 落入日志，服务返回请求之后追加的第一条非空 assistant 消息。因此整个操作可从会话日志完整重建（模型可见即记录），不引入新协议，也不需要任何凭据管道——循环既有的 provider／模型／凭据解析对任何回合同样适用。冷会话不会为润色回合恢复。

新 client 包 `dsh-client-ui-polish`（`packages/client/ui-polish`）贡献 `conversation.input.right` 列表条目（id `polish`，order 10），渲染在模型选择器正左侧。按钮文案显示会话当前模型标签（`润色 deepseek v4 flash`）；草稿为空或润色回合进行中时禁用（同渲染重入守卫用 ref，因为 React state 要到下一次渲染才能禁用）；成功后返回文本替换输入区草稿，供用户确认后再发送。失败通过共享的瞬时 Toast 提示。

同一改动在 ui-theme 引入统一 motion 词汇（`src/styles/motion.css`）：时长／缓动 token、三个标准进入 keyframes、keyframes 名变量（CSS Modules 会局部化裸 animation-name 标识符，因此组件样式表通过 `var()` 消费 `--dsw-motion-rise-in` 等），以及全局 `prefers-reduced-motion` 降级。核心会话界面消费它：每个 chat 节点（消息、工具卡片、命令行、回合尾）挂载时上升进入，hero、详情／todo／队列面板，以及输入区的控件过渡。润色按钮自身的 hover／busy 过渡同样使用这些 token，这正是两部分合并在一次改动里的原因。

## Alternatives considered

### 会话日志之外的独立 LLM 调用

绕过日志的适配器注册表旁路请求可以避免污染历史，但它会 (a) 重复凭据／模型解析逻辑，(b) 对返回文本绕过"模型可见即记录"不变量，(c) 偏离用户明确选择的复用 agent 通道。拒绝。

### 为润色记录新增会话事件类型

扩展 `SessionEventMap` 加 `polish/*` 对会让操作更显式，但为一个已经能用带区分来源的普通 user/assistant 消息对表达的操作，增加了可合并扩展词汇表、重放面与持久化目录条目。通用消息对正是压缩、重放与 UI 已经理解的形态。拒绝。

### 为润色恢复冷会话

仅为了重写草稿而恢复持久化会话代价高昂，且 Web GUI 始终操作 live 会话。否则返回 `session-not-found`。推迟，而非拒绝。

## Consequences

- 每次点击一次模型请求，与其他 assistant 消息一样保留在日志中直到压缩；返回文本绝不会被自动发送。
- 润色回复是请求之后的第一条非空 assistant 消息；在润色回合运行期间被接收的人类回合追加在其后，不会遮蔽它；但在润色回合之前被接收、之后才完成的人类回合可能先于回复出现在日志中。输入区在润色进行中禁用按钮，使该竞态在已发布的 UI 上不可达。
- 按钮文案标签每次会话只读取一次；按钮保持挂载时切换模型，旧标签会保留到下次挂载。
- 向客户端暴露 Remote 类型的 host 包必须通过子路径（`@deepseek-ai/dsh-session/types`）导入跨边界 id，而不是包根：包根的声明把 `Context.sessions` 合并为 `SessionStore`，当 host 包的声明经 Remote 链被加载进 Client 聚合 program 时，会与客户端运行时的 `ISessions` 冲突。
