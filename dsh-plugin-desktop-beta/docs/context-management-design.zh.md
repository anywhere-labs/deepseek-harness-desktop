# DSH Desktop 上下文管理改造 · 设计方案（提案）

> 状态：**提案（proposed）**，尚未实现。本文定义「对话过长自动压缩 + 分层压缩 + 长短期记忆」核心闭环的架构，以及 KV 缓存、重要文件 markdown、RAG、上下文缓存与 30 天回收箱的配套落点。核心约束：`deepseek-harness/` 是只读上游子模块，本次改造全部落在 Desktop 自有插件层，通过已文档化的扩展点组合/替换上游服务，不改动上游任何源码。

## 一、背景与目标

DSH Desktop 围绕只读的 `deepseek-harness` 子模块构建。上游已具备成熟的**单层**上下文管理：`compaction-basic` 在 token 压力下把最旧历史摘要为一段文本，`spill` 把超大文本溢出到私有文件，`storage-domain` 提供 schema 校验的 KV 持久化，`session-projection-cache` 提供会话投影的持久缓存。

本次改造把「单层摘要」升级为「多层金字塔」，并引入长期/短期记忆边界，使长时间、跨重启的协作不再只依赖一段不断被重写的摘要。目标分三层：

1. **对话过长自动压缩**：复用上游 `compaction-basic` 的触发与阈值，作为金字塔最底层的降级入口。
2. **分层压缩架构**：摘要随年龄逐级再摘要（段 → 会话 → 长期），每一级摘要是下一级的输入。
3. **长期/短期记忆**：短期记忆=仍在上下文内的 L0/L1/L2；长期记忆=退出上下文的持久层（KV + spill 文件 + markdown 索引 + 可选 RAG），按需召回。

KV 缓存、重要文件 markdown、RAG、上下文缓存与 30 天回收箱是围绕同一架构的配套能力，分阶段落地。

## 二、现状盘点（上游已有，复用不重造）

| 能力 | 上游包 | 服务 / 机制 |
|---|---|---|
| 对话过长自动压缩 | `compaction-basic` | `ctx.compaction`：`thresholdRatio`/`retainRatio` 阈值、`context-overflow` 恢复、`/compact` |
| 工具结果溢出到文件 | `spill` + `spill-local` | `ctx.spillStore`：私有 session 文件 + 定位符 + 检索提示 |
| 30 天清理（硬删除） | `spill-local` | `cleanupPeriodDays: 30`，启动一次性清扫，直接删除过期文件 |
| KV 持久化 | `storage-domain` + `storage-json`/`storage-sqlite` | `ctx.storageDomain`：schema 校验 KV domain + `domain/changed` 事件 |
| 持久投影缓存 | `session-projection-cache` | 会话投影 checkpoint，冷启动零 IO 读取列表值 |
| 有界输出 | `output-retention` | `ItemRetainer`/`TextRetainer`，统一省略脚注 |
| 请求上下文 | `context` 族 | `agent-instructions`（AGENTS.md）、`file-reference`（@file）、`session-reference` |

这些是可直接复用的成熟能力。改造的核心不是重写它们，而是在其上建立**层级关系**和**持久化边界**。

## 三、需求映射

| 用户需求 | 上游现状 | 本次策略 |
|---|---|---|
| kv 缓存 | 已有 `storage-domain` | 复用，新增 `memory` KV domain |
| 重要文件 markdown | 无 | 新建：把重要文件索引为 markdown 条目 |
| RAG | 无 | 新建：可选向量检索插件（阶段三） |
| 3kda+1gated mla | 模型/注意力架构规格 | 作为摘要模型路由配置项 + 暖前缀 KV 缓存复用策略 |
| 对话过长自动压缩 | 已有 `compaction-basic` | 复用，作为分层压缩最底层触发 |
| 上下文缓存 + 30 天回收箱 | 部分（投影缓存 + spill 硬删除） | 复用系统回收站，替换桌面自有文件硬删除 |
| 分层压缩架构 | 无 | 新建：多级摘要金字塔 |
| 长短期记忆 | 无 | 新建：组合摘要 + KV + spill + RAG |

## 四、总体架构

### 4.1 分层压缩模型

把上游的「单层摘要」扩展为四级金字塔：

- **L0 短期（原文）**：上下文内保留的最近消息——即上游 compaction 的 retained tail 加当前活动 surface。
- **L1 段摘要**：L0 老化后，最旧的平衡区间被 `ctx.compaction` 压缩为段摘要，仍留在上下文内。
- **L2 会话摘要**：多个 L1 段摘要再被摘要为会话级摘要（「摘要的摘要」）。
- **L3 长期记忆**：L2 摘要 + 关键事实/文件索引固化到持久层，退出上下文，按需经检索召回。

关键不变量：

- 每级摘要是下一级的输入，摘要可被再次摘要（recursive summarization）。
- L3 与上下文解耦：模型通过检索接口按需读取，而不是常驻上下文。
- 每一级都保留「原文定位符」（spill locator）兜底，避免摘要信息损失后原文不可达。

### 4.2 长期/短期记忆边界

- **短期记忆** = L0 + L1 + L2 中仍在上下文内的部分，由 `ctx.compaction` + `ctx.tokenMeter` 的阈值决定何时降级。
- **长期记忆** = L3 持久层：
  - `memory` KV domain：结构化事实、偏好、摘要（带 sessionId + seq 区间 + 时间戳）。
  - spill 文件：大块原文。
  - markdown 索引：被标记为「重要」的文件条目。
  - RAG 向量索引（可选）：语义检索。
- 转换路径：L2 → L3 时，摘要写入 KV domain 并打时间戳；召回时按相关性/时间排序，作为一条 `user/message` 注入上下文（复用上游 `session-reference` 的「以 user 角色进入历史」模式）。

### 4.3 数据流

```mermaid
flowchart LR
  Surface[活动对话 surface] -->|token 压力| Compact[ctx.compaction 段摘要 L1]
  Compact -->|再次老化| Session[会话摘要 L2]
  Session -->|固化| Memory[长期记忆 L3]
  Memory --> KV[memory KV domain]
  Memory --> Spill[spill 文件]
  Memory --> MD[重要文件 markdown 索引]
  Memory --> Vec[RAG 向量索引]
  Vec -.按需召回.-> Surface
  KV -.按需召回.-> Surface
  Spill -.按需召回.-> Surface
```

## 五、关键设计决策

### 5.1 分层压缩（新）

- 新增 Desktop 插件 `desktop-context`，监听 `agent/pre-step`（与 `compaction-basic` 相同的钩子），在 compaction 阈值之后执行分层降级。
- 复用 `ctx.compaction` 完成 L0→L1；L1→L2 用同一接口对「段摘要消息集合」再摘要。
- 统一用 `ctx.tokenMeter` 计价，避免多套估算口径；每级阈值暴露为 `Config` 字段（不硬编码）。

### 5.2 长期记忆（新）

- 用 `defineDomain` 声明 `memory` domain，表：`summaries`（按 sessionId + seq 区间）、`facts`、`preferences`、`files`。
- 摘要固化写入 `ctx.storageDomain` 的 `memory` domain，天然获得 schema 校验 + 持久化 + `domain/changed` 事件。
- 新增服务 `ctx.desktopMemory`：`remember()` / `recall()`，封装 L3 的写入与召回。

### 5.3 KV 缓存（复用）

- 直接复用 `storage-domain`。Desktop 已依赖 `@deepseek-ai/dsh-storage-domain`，无需新造 KV。
- 后端选 `storage-json`（人类可读）或 `storage-sqlite`（频繁点更新），由 `storage-domain` 的 `backend`/`routes` 配置决定。

### 5.4 重要文件 markdown（已实现，开关默认关）

- `desktop-context` 插件新增 `index_file` 工具：模型调用它把某文件标记为重要。工具读取文件（安全边界：>1MB 拒绝、含 NUL 字节的二进制拒绝、文本内容截断至 16000 字符），把 `path`（解析后的绝对路径）+ `note`（为什么重要）+ 截断后的 `content` 写入 `desktop_memory` domain 的 `files` 表；record key = `sha256(绝对路径)`，同路径重复索引幂等覆盖。
- 召回：`fileRecall` 开启时，在 `agent/pre-step` 把已索引文件清单（path + note，不含正文）作为一条 `user/message`（source kind `desktop-files`）注入上下文；按 files 表签名（`key:createdAt` 排序）去重，仅清单变化时重新注入。
- 正文不落 spill：本轮用「拒绝超大文件 + 截断缓存内容」实现有界；`content` 作为 RAG 与长期记忆的种子语料（阶段三的 RAG 消费）。
- 开关：`fileIndex`（注册工具 + 落库，默认 `false`）、`fileRecall`（注入清单，默认 `false`），均为 `desktop-context` 的 `Config` 字段，按需在 cordis 配置开启，符合「可选、默认不启用」约定。
- 位置：复用 `desktop-context` 已打开的 `desktop_memory` 域——该域为 single-open（重复开域抛 `already-open`），故工具与 `files` 表都落在 `desktop-context` 内，不新增插件。

### 5.5 RAG（新，阶段三）

- 可选插件：本地 embedding + 向量库（或复用 `storage-sqlite` 承载向量表）。
- 检索接口注入 `ctx`，模型通过工具/引用按需召回 L3 记忆。
- 与上游 `session-reference` 区分：RAG 做语义检索，session-reference 做确定性快照引用，两者并存。

### 5.6 30 天回收箱（复用系统回收站，新）

- 现状：桌面自有文件产物（诊断日志、更新安装包）在轮转/清理时是**硬删除**（`unlinkSync`/`unlink`）；上游 `spill-local` 的 30 天清理也是硬删除，但无拦截钩子、且 spill 文件生命周期由上游决定，不属于桌面可安全改动的范围。
- 改造：**复用系统回收站**（Electron `shell.trashItem`）替换桌面自有文件产物的硬删除——「移入系统回收站」而非「直接删除」，用户可在系统回收站中手动找回。桌面已现成接线：`desktop-factory-reset` 通过注入的 `trashItem`（绑定 `shell.trashItem`）把数据移入系统回收站，含 fail-closed 安全边界。
- 落地对象（桌面自有、可恢复、不涉及上游）：
  - 诊断日志**年龄轮转**：`log-files.ts` 的 `purgeOlderThan(7)`（`LogFileSinkOptions.trashItem` 注入，回收站失败回退 `unlinkSync`）。
  - 更新安装包清理：`update-download.ts` 的 `resolveDesktopUpdateArtifact(remove)` 新增 `trashItem` 参数，删除时移入回收站。
- 明确不覆盖：spill 文件（上游硬删、无钩子）、投影缓存（上游持有）、L3 摘要/RAG 索引（KV 记录，非文件，`shell.trashItem` 不适用）；日志的**容量阀** `enforceDirectoryCap()`（`write()` 内联同步路径，保持同步硬删除的安全阀语义）与**全量清空** `clear()`（显式清空意图，保持硬删除）。
- 开关与限制：`trashItem` 通过注入提供；开关为**机器级**环境变量 `DSH_DESKTOP_RECYCLE_BIN`（默认关，非空且非 `0`/`false` 时开启，见 `desktop-recycle-bin.ts`）——主进程日志清理发生在 Profile 选择前，故不用 per-Profile 偏好。**host 进程**（`host-process-entry.ts`，独立 Node utility 进程、无 Electron main API）的日志 sink 无法使用 `shell.trashItem`，本轮不覆盖，后续可经 RPC 让 supervisor 代为回收。

### 5.7 3kda+1gated mla（模型/注意力架构规格）

- 作为**摘要/压缩模型选型**落地：`desktop-context` 配置暴露 `summarizationProvider`/`summarizationModel`（透传上游 `compaction-basic` 已有字段），指向具备该注意力架构的模型。
- 架构层面的影响体现在 **KV/前缀缓存**：MLA 的潜在 KV 压缩使「暖前缀复用」收益更大。上游 `compaction-basic` 已按「重放 system prompt + 被遮蔽消息作为真实前缀，仅尾随指令与摘要输出不命中缓存」最小化 KV 重算；分层压缩的 L2/L3 摘要调用沿用同一策略。

> 说明：本项对「3kda+1gated mla」的理解为「摘要/压缩模型的注意力架构规格」，落地为配置项与暖前缀复用策略。若其指代具体的模型名称或层配置，需在实现前补充明确值。

## 六、落地方式（Desktop 自有插件）

- 位置：`dsh-plugin-desktop-beta/` 新增子路径 `desktop-context`（`src/context/…`），经 `cordis.patch.yml` 注入（`id: desktop-context`）。
- 服务组合：
  - 复用：`ctx.compaction`（L0→L1）、`ctx.storageDomain`（KV）、`ctx.spillStore`（大块原文）、`ctx.tokenMeter`（计价）、`ctx.sessionProjections`（冷启动）。
  - 新增：`ctx.desktopMemory`（长期记忆）、`ctx.desktopContextTrash`（回收箱）、可选 `ctx.desktopRag`（向量检索）。
- 不修改上游：所有新增行为挂在已文档化的扩展点（`agent/pre-step`、`domain/changed` 等）上。

## 七、分阶段实施

- **Phase 1（核心闭环）**：`desktop-context` 插件骨架 + 分层压缩（L0→L1 复用 compaction，L1→L2 再摘要）+ 长期记忆落库（`memory` domain）+ 短期/长期边界。
- **Phase 2**：30 天回收箱（桌面自有文件硬删除 → 移入系统回收站）。
- **Phase 3**：重要文件 markdown 索引（已完成：`index_file` 工具 + `files` 表 + 清单召回，开关默认关）+ RAG 向量检索（可选插件，待定）。

## 八、风险与边界

- 上游只读：所有能力挂在扩展点，`deepseek-harness/` 内代码零改动。
- 分层压缩的摘要质量依赖摘要模型；L2/L3 的「摘要再摘要」有信息损失，靠 spill locator 保留原文兜底。
- RAG 依赖 embedding 提供方；作为可选插件，缺失时不阻断核心闭环。
- 回收箱的保留期沿用桌面现有日志轮转配置（`purgeOlderThan(7)` / 目录容量上限），回收站本身由操作系统管理；回收箱能力由机器级环境变量 `DSH_DESKTOP_RECYCLE_BIN` 开关、默认关，不硬编码（符合上游「无硬编码可调项」约定）。

## 九、验收标准

- 长对话越过阈值后自动分层压缩，L0→L1→L2 逐级降级且上下文内 token 保持有界。
- 会话重启后 L3 记忆可经检索召回。
- 桌面自有文件产物在轮转/清理时进入系统回收站而非直接删除，可恢复（年龄轮转日志 + 更新安装包）。
- 上游 `deepseek-harness/` 无改动；`corepack yarn check`（typecheck + test）通过。

## 十、分层编排（Pro 定级 + Router 分发 + Marvis 桥，已实现，默认关）

> 本层在「上下文管理」之上再加一层**任务编排**：用户需求先经 Pro 模型定级为 L0–L4，再由纯代码 Router 分发到对应执行器。真正的新增量只有三个薄层——**Pro 定级 + Router 分发 + 异常闭环**；执行器、信息分级、防死循环都复用 harness 已有能力（`ctx.subagents` 的 fresh 隔离、`ctx.get('llm').stream`、`ctx.get('userQuestions')`）。Marvis（腾讯「马维斯」）无官方 API，仅能经剪贴板人工在环接入。

### 10.1 五级难度与执行器映射

| 级别 | 语义 | 执行器 | 路径 |
|---|---|---|---|
| L0 | 确定性、单步、无需 LLM | `local`（本地确定性操作，如 JSON 格式化） | 直达 |
| L1 | 单目标、1–3 步 | `flash`（fresh `spawn` subagent） | 直达 |
| L2 | 多步、需分解 | `marvis`（剪贴板人工在环） | 直达（人工搬运） |
| L3 | 多目标、跨域、路径不清 | `pro_router`（递归长链路） | 长链路 |
| L4 | 开放、高风险 | `human`（人工决策） | 直达（转交人工） |

### 10.2 架构

```mermaid
flowchart LR
  Task[用户需求] --> Plan[ProPlanner 定级 L0-L4]
  Plan --> Router{Router switch}
  Router -->|L0| Local[local 执行器]
  Router -->|L1| Flash[flash 执行器]
  Router -->|L2| Marvis[marvis 执行器]
  Router -->|L3| ProRouter[pro_router 递归]
  Router -->|L4| Human[human 转交]
  Local --> Result[结果]
  Flash --> Result
  Marvis --> Result
  Human --> Result
  ProRouter -->|子目标| Plan
  Result -.失败.-> Plan
```

### 10.3 执行器与信息分级

- **L0 `local`**：确定性单步、零 token；识别 JSON 格式化等确定性操作，无法识别则失败回 Pro 重新定级。
- **L1 `flash`**：`ctx.subagents.start('spawn', …)` 派生 fresh 子 agent——`spawn` provider `inheritsParentContext = false`，子 agent **只看到任务卡、看不到父历史**，即「下层看不到全量历史」这条硬规矩的落点。
- **L2 `marvis`**：生成任务卡写系统剪贴板，返回「请到 Marvis 粘贴执行」提示；结果由 flash 经 `marvis_collect` 工具读回。
- **L3 `pro_router`**：拿 Pro 分解的 `subGoals`，逐个递归 dispatch（重新定级→路由→执行），汇总子目标输出；递归深度由 `maxDepth` 封顶。
- **L4 `human`**：停止链路，返回转交提示（目标 + 定级依据），由用户决策后再回报。

### 10.4 Marvis 剪贴板桥（人工在环）

Marvis 无官方 API/CLI，接入方式为剪贴板人工在环，脚本**不自动点发送、不自动点授权**：

1. `marvis_send` 工具把任务卡（`===DSH_TASK===` JSON：`task_id`/`goal`/`context`/`output_format`）写入系统剪贴板。
2. 用户手动切到 Marvis 粘贴执行，全选复制结果。
3. 用户回 DSH，flash 调 `marvis_collect` 读剪贴板，解析 `===DSH_RESULT===` 标记（无标记则取全量剪贴板文本）。

- 剪贴板能力经 `desktopClipboard` 服务注入（`main.ts` 用 Electron `clipboard` 模块经 `hostCtx.provide` 提供）；headless 启动不注入 → `ctx.get('desktopClipboard')` 为 `undefined`，Marvis 优雅降级「剪贴板不可用」。
- 熔断：`maxSendsPerHour`（默认 100）按滚动小时限流，防止免费额度被当无限水龙头。

### 10.5 关键约束

- **Pro 是唯一定级入口**：只有 `ProPlanner` 调定级模型；执行器绝不重新定级、不自动升级、不改全局计划。
- **Router 是纯 switch**：按 `level` 分发，零智能判断。
- **异常闭环**：执行失败 → 带 `attempted` 回 Pro 重新定级，最多 `maxReplans` 次；L3 递归深度最多 `maxDepth`。无自动升级、无无限重试。
- **信息分级是硬规矩**：任务卡只带 `task_id`/`goal`/`context`，下层拿不到上层全量历史。

### 10.6 插件与配置（默认关）

- `desktop-orchestrator`：`orchestrate` 工具 + ProPlanner + Router + 五级执行器。`Config`：`proProvider`（空=继承会话路由）、`proModel`（默认 `deepseek-v4-pro`）、`proMaxTokens`（默认 1024）、`maxReplans`（默认 2）、`maxDepth`（默认 3）。
- `desktop-marvis`：`marvis_send` / `marvis_collect` 工具 + 熔断。`Config`：`maxSendsPerHour`（默认 100）。
- 两者均 `disabled: true` 默认关，经 `cordis.patch.yml` 挂载，符合「可选、默认不启用」约定。

### 10.7 验收标准

- L0 本地确定性、L1 fresh subagent、L2 Marvis 剪贴板桥各跑通一个用例。
- L3 多目标任务递归分解为子目标并汇总；深度封顶不失控。
- L4 高风险任务转交人工，不自动执行。
- 执行失败回 Pro 重新定级，re-plan 有界。
- 下层（flash/marvis/子目标）拿不到父历史全量。
