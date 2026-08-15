# @deepseek-ai/dsh-message-edit

[English](README.md) | 中文

基于会话 surface 的就地用户消息编辑。编辑一条已定稿的用户消息时，会追加一条**复用原消息 id** 的替换 `user/message`，并带一个遮蔽目标事件的 `replace` surface 操作：surface 折叠——以及其后的每一次模型请求——看到的是新文本；UI 把替换折叠进同一条消息节点（不会出现第二个气泡）；追加式日志同时保留两个版本。替换消息是纯 `{ kind: 'user' }` 来源，只携带调用方提供的文本；原消息的非文本块（图片、附件）原样保留。

消息按稳定 id 在**当前** surface 上定位，因此同一消息可以连续多次编辑——每次编辑都以之前的替换为靶。

## Remote API

服务在 `messageEdit` 命名空间注册一个 Typert Remote 方法，由 Client 组装（`@deepseek-ai/dsh-api-remotes`）挂载：

| 方法 | 请求 | 结果 |
|---|---|---|
| `messageEdit` | `{ sessionId, messageId, text }` | `{ ok: true, value: { seq } }` 或一个闭集失败 |

`messageEdit` 要求 `sessionId` 对应的 **live** agent（否则 `session-not-found`）。文本会去除首尾空白，必须非空（`message-blank`），且不得超过配置的 `maxMessageChars`（`message-too-long`）。目标必须是仍在 surface 上的普通用户消息——被压缩掉、作为上下文注入或来自非用户来源的消息会被拒绝（`message-not-found`）。

## Config

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxMessageChars` | `20000` | 替换文本的最大字符数。 |

## Model Experience

### 编辑替换

#### 模型看到什么

下一次模型请求从折叠后的 surface（`foldSurface`）重建，模型在消息原位置以用户角色看到编辑后的文本；编辑前的文本不在请求中。模型基于旧文本已经产出的历史不会被重写——编辑改变的是消息的走向，不会重放已经消费旧措辞的回合。

#### Token 影响

替换只是日志中的一条新事件；编辑之后构建的请求携带新文本而非旧文本，因此保留的 token 从此反映编辑后的版本。

#### KV Cache 影响

编辑后的消息位于同一日志位置但文本不同，因此可复用的请求前缀在该点失效；更早的事件不受影响。

## Known Limitations and Deferred Work

- **消费原措辞的回合不会被重放** —— 已经回应过编辑前文本的 assistant 回复保持原样；只有未来的请求看到编辑。真正重排受影响回合的能力延后。
- **仅编辑文本** —— 编辑器改写消息的文本块；带非文本块的消息保留这些块，且当没有文本可编辑时 UI 隐藏编辑控件。
