# @deepseek-ai/dsh-client-ui-conversation

[English](README.md) | 中文

会话领域：骨架（标题栏／标签页／编辑器／空状态）、聊天视图（分组步骤摘要流、流式尾部隔离与轮次状态）、编辑器 dock（与输入区一同 sticky 的会话统计行）、输入区 dock（队列行加 todo 计划条）、详情壳层，以及按 scope 寻址的 ConversationController。工具展示属于 [`ui-tool`](../ui-tool/README.md)。

压缩（compaction）在检查点自身的消息流位置渲染为一行折叠标记，不替换其上方的 transcript（文本记录）。自动压缩使用「上下文已压缩」标题。每个已加载对应 `compaction/summary` 事件的完成标记都会显示被替换条目数量和估算 token 数量，并可点击展开摘要。手动 `/compact` 开始时显示为运行中的 `compact` 行；成功结算后，其显式摘要事件引用会在保持同一 React key 的前提下把该命令折叠进检查点行。完成的检查点静止时保留上下文压缩（context compaction）图标，仅在悬停或键盘聚焦时将其替换为收起／展开指示图标。输入被拒绝、没有可压缩历史、取消和失败时仍使用通用命令行及处理器撰写的文本。配对绝不依赖相邻关系，因为压缩运行期间可能注入持久上下文。面向模型的带框检查点载荷绝不渲染；被引用的 `compaction/summary` 事件位于已加载窗口之外时，检查点仍然可见但不可展开。

常驻会话壳会跨无会话与会话状态切换而保留。没有当前会话时，它会锁定消息操作，并让整张虚线编辑器卡片成为根作用域 `conversation.hero.workspace` Workspace picker 的入口；textarea 保持只读且支持键盘操作。选择 Workspace 会连接或复用由 Host 拥有的空白会话，并在不替换会话壳的情况下打开该会话。根组件始终拥有同一个滚动容器与 Hero／编辑器子树；首个会话到达时，彼此独立的严格会话页头和主体 outlet 只填入各自区域，因此 Workspace picker、滚动主体、编辑器 seat 与 textarea 都保留原有 React 和 DOM identity。空白会话与活跃会话渲染相同的输入区主体；InputHub 则在 Workspace 切换间携带草稿，并将草稿镜像到会话 store。活跃阶段，会话标题栏作为普通列 chrome，仅显示当前会话标题和视图标签；fork 谱系仍保留为会话数据，不投影到标题栏。在桌面 document 中，macOS 让可见标题栏成为拖拽区；Windows 只让 44px 标题首行可拖动，在右边为原生窗口按钮留位，并把 Session 工具放在按钮左侧。按钮、链接、表单字段、ARIA 控件、标签页与可编辑后代保持 `no-drag`；该标题栏隐藏时，常驻根组件提供同一标题行的拖拽带。其下滚动容器（`data-conversation-scroll`）承载流动排版的各视图与 sticky 编辑器栈（统计 dock＋输入区 dock＋输入栏）。该滚动容器无条件预留自己的滚动条槽，选用编辑器 overlay 的视图也仍把它保留为滚动容器，因此无论对话记录是否滚动、无论展示哪个视图标签，输入卡片都保持同一个横向位置（[决策](../../../.agents/notes/implemented/bug-fix/2026-08-04-composer-tab-gutter-reservation.md)）。textarea 上的滚轮会链式处理：限高草稿先在本地滚动，到达边缘后再转交给该宿主。

别的插件可以经 `ctx.conversation.blocks` 让某个会话的编辑器变为惰性：它设置一个携带自己本地化理由的 block，输入栏就渲染同一个禁用的 textarea，并把该理由作为 placeholder——复用无 Workspace 时的那套姿态。推送方向是约束而非偏好：知道某会话发不出消息的插件（ui-model-selection，在没有适配器服务其路由时）本就依赖本包，因此本包读不到它们。模型 seat 是 block 唯一保留可用的控件——这份约定里的每个 block 都靠选模型来解除，把它一起锁上会让编辑器索要它自己拦下的那件事。block 只是提示性设计；无论客户端禁用了什么，宿主都会拒绝一个它无法路由的提示词。两者同时成立时以无 Workspace 姿态为准，因为选 Workspace 是更靠前的前提。

视图环是一个 slot：严格会话主体注册在 `children` 表中声明会话作用域的 `'conversation.view'` 列表，并通过自身的 renderSlot share 渲染活跃配置项（`only: <active id>`）；视图标签页则从注册选项（`id`／`order`／`label`）投影而来。聊天视图是该包自身的配置项；ui-trajectory 等插件通过 `ctx.slots.register` 贡献标签页，每个视图负责自己的 chrome。

Chat 业务行是彼此独立的注册表贡献，不是封闭的内建联合。Client 插件通过 declaration merging 增加类型化 `ChatNodeDataMap` key，在 `ctx.conversationEvents` 上注册 `ConversationNodeDefinition`，再向 `conversation.chat.node` 注册匹配的 keyed renderer；它无须修改会话 fold 或中央 renderer switch。稳定事件 id、append/prepend 回放、Location data 与 renderer 约束见 [Conversation Node 实操手册](../../../docs/cookbook/adding-a-conversation-node.md)。

会话页头会在标题旁渲染会话作用域的 `'conversation.session.header.actions'` 列表，并在最右侧渲染独立的 `'conversation.session.header.utilities'` 列表。会话上下文和谱系控件保留在 `actions` 中；可选的会话工具不会改变它们的顺序或位置。编辑器链的 currency 包含当前对话 `session`；ui-subagent 会选取 one-shot 或 parent 不可用的已寻址会话，并按原因显示只读文案，而普通 InputBar 会让所有已寻址 child 仅保留 Send，因为继续执行服务不公开逐 Activation 取消操作，`session.cancel` 也会绕过其所有权。

已记录的非用户消息渲染为默认折叠的展开项，标题栏先给出运行时为该消息投影出的角色——注入为 `上下文注入`，召回为 `跨会话召回`——其后是该投影从持久来源读出的生产者名称，因此读者无需展开即可区分 skill（技能）目录、工作区指令文件与被召回的会话。来源未提供生产者名称时只显示角色。共享的 `DisclosureRow` 原子组件让该上下文界面与消息流中的其他紧凑行保持相同几何，同时保留上下文语义：展开内容区的高度会随内容自适应，最大为 141px，超出后滚动，且不会合成工具状态或摘要（[历史展开项决策](../../../.agents/notes/archived/feature/2026-07-30-web-context-injection-disclosure.md)、[生产者标签决策](../../../.agents/notes/implemented/feature/2026-08-04-web-context-source-and-steer-marks.md)）。该内容区按生产方在持久来源上声明的形态渲染：`instructions` 在正文之上列出它对账过的文件，`catalog` 列出来源记录的条目而非面向模型的正文，其余取值——未声明、本版本不认识、或字段不可用——一律渲染 opaque 内容区，即按真实换行展示面向模型的文本，并把剩余来源字段列出。opaque 不是兜底剩余物而是有文档的默认：恢复的、fork 的、外部写入的日志，无论其生产方是否挂载在此处，都必须渲染得出来。持久或待处理的 steering（中途引导）气泡沿用用户气泡的呈现，不加任何装饰；transcript 中唯一的 steering 信号是它出现在轮次中途的位置。

Think 行默认保持折叠，并在不展开思维链的情况下暴露实时推理（reasoning）吞吐：当推理块是流式输出尾部时，摘要从结算后的首行切换到最新的非空行，其单行滚动区会随每个 delta 追到行内末端。展开该行会移除移动摘要，让完整推理进入普通页面流，因此页面阅读不会与内部跟随器争夺滚动；结算后恢复左对齐的稳定首行摘要（[决策](../../../.agents/notes/implemented/feature/2026-08-02-web-thinking-tail-scroll.md)）。

聊天视图保留工具的消息流位置，但委托其展示。每个已排序的 `tool-call` Conversation Node 都通过 `conversation.chat.node` 的同名 key 分发；详情壳层则通过 `conversation.details.tool` 传递当前选中的调用。组装后的 Web bundle 为该 Chat Node key 注册 [`ui-tool`](../ui-tool/README.md)，由后者渲染运行时已投影的递归 root/child 树，并负责按名称分发、通用展示和 render-intent 卡片；只有详情席位会在该 renderer 缺席时保留 raw-result fallback。

聊天流会将跨重试轮次连续出现的模型重试节点投影为一个稳定的弱化状态行，并用最新一次尝试更新该行；每个重试事件仍保留在运行时快照与会话日志中。前端倒计时以客户端收到事件的时刻为计划延迟的起点，避免 Host 与浏览器的时钟偏差；剩余时间向上取整到秒，且下限为 1 秒。最近一次尚未完成的重试会显示从左到右的文字渐变动画。后续轮次事实用于区分已开始的尝试与在退避期间取消的尝试，Host 的 running 位只控制实时动画；随后该行会显示静态的已完成或已取消标签。normal 策略行显示有限重试上限；always 策略行显示 `∞`。激活该行会显示最近一次重试的精确延迟和失败消息。客户端运行时会在相应重试节点到达前移除每个失败步骤的流式输出尾部；后续某次尝试成功后，该状态仍保持可见。未进入重试的终态失败会在其轮次边界渲染为持久的内联状态，展示适合显示的持久消息与可选错误码，但不会提供 Host 无法兑现的操作；AUTH 文案绝不会回显提供方给出的凭据片段。

审批通过本包声明的链条接管编辑器：`ApprovalPanel` 注册为按选择器路由的 `'conversation.composer'` 配置项（ui-user-questions 模式），在审批等待未决期间取代 InputBar 占据编辑器（琥珀色条、理由标题、来自运行中调用参数的配对命令行、一次性的拒绝／允许）。`contract/slots.ts` 中的 `PendingApproval` 领域面在运行时 `PendingWait` 载体之上拥有 wire 编码——带审计关联的 `ApprovalResponsePayload` 值；广播的 `approval/resolved` 帧使等待落定并恢复编辑器。运行时 manager 会将所有审批或问题等待通过 `SessionSummary.pendingInteraction` 投影出来，未实例化的会话也不例外；`ui-workspace` 负责其侧边栏呈现。未决等待完全离开消息流：问题（ui-user-questions）与审批（ApprovalPanel）都经编辑器接管作答，不再保留只读占位卡。编辑器底行的 Access 席位挂载 `PermissionSelect`，由 host 计算的 `permissions` 投影经标准工具包 `useProjection` 供数（key 缺席即隐藏 chip）；chip 打开 Menu 原语下拉，其中 kebab-case 预设名渲染为 Title Case 标签；普通安全预设会立即经输入栏注入的 `command` 回调提交 `/permission <preset>`，而 `danger-full-access` 在界面中显示为 `Full access`，选择后先打开页面内的 Modal 风险确认。用户勾选确认项前启用按钮始终不可用；取消、Escape、关闭按钮与点击遮罩都不会提交命令。

`TodoDock` 以 `order: 0` 占用 `'conversation.input.dock'` 列表 slot（位于 Goal 与 Queue 之前），作为计划条读取 host 计算的 `todos` 投影（当前计划：其后没有更晚 `turn/start` 的最近一次 `todo/write`）并渲染 `TodoPanel`。面板接收纯列表，列表为空时自我隐藏；列表非空时默认折叠，表头显示标题及以 `·` 连接的各状态计数（如 `1 已完成 · 2 进行中 · 1 待处理`，省略零计数）。dock adapter 拥有 selection，因此面板保持为 props 的纯函数。输入区 composer 链隐藏的一切也会隐藏整个 dock。`todo_write` 工具行属于 [`ui-tool`](../ui-tool/README.md)。

`QueueDock` 是 `order: 20` 的末端 input-dock 条目。队列为空时隐藏；只有一个待处理项时直接渲染该行；存在两个或更多待处理项时，默认收起为 `"<n> 条排队消息"` 表头，其按钮可展开或收起完整列表。表头暴露 `aria-expanded` 和 `aria-controls`；展开后的列表以 180px 为高度上限，并可滚动。存在进行中的编辑或变更时，列表行会保持可见；队列清空后，下一次出现队列时会恢复默认收起状态。普通会话中的每条可见行仍是单行预览，并提供针对精确单次入队项的编辑、删除和严格 steering 操作；已寻址 subagent 则保留只读行，因为其继续执行传输不提供 Queue 变更。如果严格 steering 输给已关闭的窗口，原单次入队项会留在 Queue 中正常投递；如果驱动器已经认领该项，正常投递就已开始。这两种已收敛的竞态都不显示失败，传输和未知错误仍会显示。

Host 带 placement 的 `session/queue` 快照也会携带待处理 steering。QueueDock 会将其过滤掉，ChatView 则把它投影为会话流末尾带复制操作的用户样式气泡；非用户来源的 next-step 项（注入上下文）改以 `context` placement 广播，领取前不在任何界面渲染。与所有用户样式气泡一样，这里不显示 fork。Host 会等携带该 steering 的持久 `user/message` 进入 mux 流之后再退役 steering。客户端运行时接纳该实时事件时，会在发布快照前退役第一个匹配的当前 steering 单次入队项；历史事件无法隐藏后来复用同一 `MessageId` 的单次入队项。气泡交接时因而不会产生空档或重复，会立即从持久节点恢复复制操作与时钟——steering 气泡与 user 气泡一样不带分支操作（[决策](../../../.agents/notes/implemented/simplification/2026-08-06-user-bubbles-drop-the-branch-action.md)）——并能在重连后从同一权威恢复。

键盘消息提交会根据所寻址会话的运行状态和 steering 能力解析投递方式。空闲时，Enter 和 Cmd/Ctrl+Enter 都执行普通 Queue 发送。主会话运行期间，由 Host settings 支撑的 `ui-conversation.busyEnter` General Settings 偏好会把普通 Enter 分配为 `Queue`（默认值）或 `Steer`，Cmd/Ctrl+Enter 则执行另一种行为；本地 settings 提供方将其存入 `$DSH_HOME/settings.yaml`，因此该选择会跟随同一个用户 home 跨越 Web 端口。Shift+Enter 仍然换行。草稿为空时，Cmd/Ctrl+Enter 改为按 FIFO 顺序把仍在排队的消息全部插话进运行中的轮次（把 dock 的逐条严格 steer 操作应用于整个队列）；空草稿 + 普通 Enter 仍是无操作。这个整队列手势可用时，文本框 placeholder 会提示该手势；owner 提供的 placeholder 仍然优先。已寻址 subagent 即使正在运行，也会让这两个手势都使用其仅支持 Queue 的继续执行传输。该偏好只影响支持 steering 的繁忙态手势对，发送按钮与非键盘提交操作仍使用 Queue。Composer Steer 复用现有尽力而为的 `session.prompt(mode: 'steer')` 约定：如果当前 next-step 窗口在接纳前关闭，AgentLoop 会把消息接纳为下一条唤醒 Queue 轮次，不显示失败，也不会丢失草稿事务。该持久化边界由[Host settings 支撑的偏好决策](../../../.agents/notes/implemented/bug-fix/2026-08-06-host-backed-web-preferences.md)拥有。

逐会话 UI 状态中的选择与活跃视图位于已声明的聊天 store（`stores.ts` `createChatStore`）中；InputHub 拥有输入区状态机，并将草稿镜像到该 store 以便持久化。apply 将同一个 store handle 传给严格限定于会话的子树、聊天视图和详情注册，因此每个会话内共享一个实例，框架拥有其生命周期。组件保持纯粹：框架标准工具包提供 `useSession`／`sessionId`、全局 `useSessions`／`useWorkspaces`，以及输入状态机的 `useInput`／`inputActions`；store 表层与 inject factory 提供其余状态和回调。

图片经粘贴与整页拖放进入：输入栏绑定 document 级拖拽监听（composer-bar slot 为 `kind: 'single'`，同一时刻至多一个 bar 绑定），文件拖拽悬停窗口时显示 `DropOverlay` 原子组件——纯文本拖拽不受影响，锁定或忙碌的 composer 显示禁用遮罩并拒绝 drop。两种手势共用一条对宿主 `imageLimits` 投影的加入预检（数量、单图字节、总字节）：会突破上限的加入整批拒收，立刻弹出点名上限的横幅，完全不进入附件栏。仍然到达的宿主侧拒绝按 `attachment-error` 原因映射为产品文案（`image-labels.ts` 的 `attachmentErrorText`）；用户无法解决的原因折叠为一条带原因码的发送失败文案，非附件错误码保留开发者可读的原文加错误码。

输入栏为 `'conversation.input.plan'`（位于本地 access 模式控件右侧）和 `'conversation.input.model'`（渲染在 pending 指示器与发送／停止控件之前）声明会话作用域的单实例 seat，并为 overlay、dock、left 和 right 输入扩展声明列表 slot。各功能包拥有相应控件及其状态；ui-conversation 提供放置位置、`locked` owner prop 和标准 slot share。前置加号按钮是 Command launcher，而非附件入口：它要求当前会话的 `InputTriggerController` 基于 textarea 当前 selection，只打开 `/` trigger 的 `command` source，同时 ui-input-trigger 既有的 `MenuView` 仍是唯一的浮层菜单与 pick 路径。不引入 File 行、file input、上传协议或第二套菜单组件。当 `plan` 投影的有效目标为 plan mode 时，InputBar 将文本框 placeholder 切换为 plan 任务措辞，经本包注册的 `conversation` locale 命名空间（`placeholder.plan` / `hint.plan` 键）本地化，并与已认领 `/plan` 命令的提示逐字共用同一份文案（经标准套件 `useProjection` 读取的 host 折叠值；owner 提供的 placeholder 优先）。另一个会话视图活跃时，待处理的 composer 接管仍保持挂载，使被阻塞的 agent（智能体）仍能收到回答；没有待处理交互时，活跃会话的 composer 归 Chat 所有。composer bar slot 本身为 `session-maybe`：没有当前会话时，同一个 bar 会让消息操作保持不可交互（machine face 均缺席、`disabled` owner prop），整张虚线卡片可经指针打开现有 Workspace picker，只读 textarea 也可通过 Enter 或 Space 打开。禁用控件会把指针事件交给卡片，卡片也会拦下 `pointerdown`，避免已打开 picker 的外点关闭与重新打开发生竞态。它不会换入一棵平行树，因此选择 Workspace 时 textarea DOM 不会被销毁；严格会话作用域的控件 seat 在会话存在之前保持为空。

聊天统计行的 token 账目来自经标准套件 `useProjection` 读取的通用 token-meter 投影 `tokenUsage`：计费输入为未缓存输入、缓存读取与缓存写入之和；缓存命中率以缓存读取除以该总量。轮次与步骤计数、LLM（大语言模型）与工具墙钟时间、以及延迟／吞吐分组都来自全日志的 `sessionStats` 投影（Host 端从步边界、首 token chunk、工具配对与已组装消息折算），因此分页与压缩都无法改变统计条的任何数字；未组合该单元的装配回退为对可见节点做窗口折算，其字段与投影一一对应。统计条把每个有完整记录的步骤的 TTFT（首 token 延迟）取平均，并用采样到的输出 token 数除以其解码时长之和，得到经 `conversation` locale 命名空间本地化的延迟／吞吐分组（中文为 `首 token 平均 … · … tok/s`）；缺少某个 timing 边界或 usage 采样的步骤会直接退出这些数字，而不是让它们失真；压缩（compaction）使已加载窗口不再包含 assistant 节点时，持久计数、token 与上下文分组仍保持可见。轮次计数、步骤计数、耗时、缓存与 token 各项的标签也使用同一命名空间。每个已结算轮次还会在其 assistant footer 的 `用时` 之后追加 hover 才显示的 `首 token {s}秒 · {tps} tok/s` 标签——即该轮次首个步骤的 TTFT 与轮次聚合的解码吞吐——仅当该轮次的 timing 位于已加载窗口内才显示（窗口是日志的连续后缀，因此窗口内的轮次必然带着它的全部步骤），未记录的数字会各自省略。未组合 token-meter 的部署会整组省略 token 分组；统计行过长时以省略号截断，仅在内容真的被裁切时由延迟 hover tooltip 承载完整文本。上下文占用率渲染为 composer 尾部的 ContextMeter：模型座位之后的一枚 14px 占用圆环，由 `contextPressure` 供数，仅当分子与路由容量都已知时才渲染；点击弹出的面板把「已用百分比」标题与 `~已用 / 容量` 数字，与来自 `contextBreakdown` 投影、带 `~` 前缀的启发式组成明细行（系统提示词、工具、对话消息）及分色分段进度条并列。圆环与标题读取 `projectedTokens`——把提供方样本沿此后表层的增减推进到当下——因此压缩会立刻反映出来，而不必再等一整轮；组成明细行仍是纯启发式，因此加起来依然不等于标题数字（[原理](../../llm/token-meter/README.md)）。占用率是刻意为之的近似值：分子与容量是两个相互独立的「后写覆盖」投影字段，并非同一次请求的原子观测。

`src/client/` 按领域组织。`contract/` 是 slot 声明、组合 props 与跨领域类型的共享表层；`skeleton/`、`chat/`、`input/`、`queue/` 和 `settings/` 保持内部实现，`apply.ts` 是它们的组装点。`/client` 导出表层只包含 loader entry、service class 和 contract 类型；组件与 store factory 经 slot 注册抵达页面。

完成的一轮会物化一个有序的 `turn-tail` Conversation Node。它由引擎维护的 `TurnLocation` 提供收尾 Assistant 和 Turn data；renderer 在该 Node 的 IconActions 之前渲染 `conversation.chat.turnTail` chain，并派发包含 Turn、收尾 seq 和 `openFile` 的 `TurnTailOwnerProps`。本包只拥有空位；`@deepseek-ai/dsh-client-ui-deliverables` 把改写工具的 `locations` 累积到 Turn data，并拥有产物行、chip 上限和文案，因此把该插件从 cordis.yml 中组合掉即可关闭该交互面，空位以零成本渲染为空。收尾正文经由同一个开关参与其中：chat 视图向可选的 `chatFileMentions` service（ctx.get；由同一插件提供）索取收尾消息的行内代码词表，并把结果接进 MarkdownText 的 `fileMentions` seam——service 缺席时正文保持死文本。

## 模型体验

无。会话 UI 在浏览器中渲染会话历史与流；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **统计行的回退折算只覆盖窗口内消息流**：未组合 `sessionStats` 投影单元的装配中，所有数字由快照的 assistant `timing` 与工具 call/result 配对折算，落在已加载事件窗口之外的节点（更早的历史）不计入，数字随加载页数增长。
- **详情面板没有入口**：`ChatViewInjected.openDetails` 虽已实现却无人调用，因此以原始形式显示已选择调用的那部分在组装后的应用中不可达。没有 Input/Output/Metadata 切换、Prev/Next 步进，也没有 trajectory 深链接。
- **assistant 逐消息分页是预留 slot**：设计中已有图稿，尚未实现。已定稿的内容 IconActions 行（复制／时钟／分支）只挂在每个已结束轮次中最后一条带 text 内容的 assistant 下；轮次中间的叙述、纯 Think 节点，以及仍在产出步骤的轮次里的所有节点都不带 chrome。除非该消息同时也是已完成轮次的最后一个 transcript 节点，否则分支保持禁用；启用后，它会 fork 到该轮次末尾，在 client 端递增继承标题并打开子会话。fork 或改名失败时源会话保持选中（[决策](../../../.agents/notes/implemented/bug-fix/2026-08-02-message-fork-actions-require-completed-turn-tail.md)）。
- **编辑已发送的 user 消息是就地改写**：user 气泡的编辑控件把气泡换成预载消息全文的编辑框；保存时通过 messageEdit Remote（[`dsh-message-edit`](../../interaction/message-edit/README.md)）追加一条同 id 的 surface 替换 `user/message`，可见消息与之后的每次模型请求都显示新文本，日志保持追加式。已经消费旧措辞的回合不会重放；分支只存在于 assistant 回答之下（[决策](../../../.agents/notes/implemented/simplification/2026-08-06-user-bubbles-drop-the-branch-action.md)）。
- **others 工具行的闪光图标是手绘近似版本**：无法在本地导出设计字形的矢量几何；等到存在精确导出后再将其提升到 ui-primitives。
- **审批面板的「始终允许此类」暂缓**：持久授权需要授权存储设计；今天只能回答允许一次／拒绝。
- **TodoPanel 将过长条目截成单行省略号**：figma 条没有换行或展开入口，完整文本无法在行内读完。
- **Queue 编辑仅支持文本**：包含非文本块的行仍显示扁平化预览，但由于内联编辑器无法保留这些块，其编辑控件会被禁用。文本行进入编辑模式后，删除和严格 steering 操作会被保存和取消取代；Enter 保存，Escape 取消。
- **Queue 严格 steering 会保留完整消息**：agent 运行期间，steering 操作会以原子方式把所寻址的 Queue 单次入队项转移到当前 next-step 窗口。包含混合内容的行仍可使用此操作，因为它会转发不可变消息，而非文本投影。带 placement 的 Host 快照会在会话流末尾渲染待处理 steering，直到已消费的 `user/message` 折叠进持久 transcript（文本记录），因此立即展示、重连和回放共享同一个线性权威。
