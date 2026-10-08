# 桌面可观测性与护栏设计

为 DSH Desktop 增加能力，全部落在 Desktop 自有插件层（`dsh-plugin-desktop-beta/` 先行，再同步 `dsh-plugin-desktop/`），`deepseek-harness/` 只读子模块零改动，只挂已文档化的扩展点。

## 总览

| 能力 | 上游复用 | Desktop 落点 | 插件形态 | 默认状态 |
|---|---|---|---|---|
| 实时 API 消耗显示 | `ctx.tokenMeter`、`ctx.sessionProjections` | 客户端 UI 读投影渲染 | client | 关闭（config 开） |
| 程序活动轨迹 | `session/event` 持久日志、`session-stats` | 客户端 UI 时间线 | client | 关闭（config 开） |
| 死循环熔断与复位 | `repeat-tool-reminder`、`ctx.goals`、`ctx.userQuestions`、`turnOutline`、L2 摘要 | host 护栏插件（熔断 + 必经复位） | host | 关闭（config 开） |

---

## 1. 实时 API 消耗显示

### 需求
实时展示当前会话已消耗的 token 与费用（输入 / 缓存读 / 缓存写 / 输出），以及剩余上下文水位。

### 上游复用
- `@deepseek-ai/dsh-token-meter` 暴露 `ctx.tokenMeter`：`measure(session, requestHeader?)` 返回 `{ baseline, surfaceDeltaTokens, totalTokens, surfaceTokens, nodes, logRevision }`。
- token-meter 已注册三个投影进 `ctx.sessionProjections`：token 用量、上下文压力、上下文分项（`breakdown-projection`）。
- 费用来自 `route-pricing.ts` 的 provider/model 路由定价。

### Desktop 落点
- 客户端插件订阅 `session/event` 增量追赶，把 `totalTokens` / 分项投影渲染成实时指示器。
- 文案走 locale 字典；开关在设置面板，默认关闭。

### 边界
- token-meter 是「重放感知」启发式估算 + provider usage 锚定，展示需标注「估算」。
- 费用仅在 provider/model 路由定价可用时显示，否则只显示 token 数。

---

## 2. 程序活动轨迹

### 需求
展示「程序做了什么」：工具调用（参数/结果）、LLM 回合、文件读写、spill/压缩等，可回溯、可检索。

### 上游复用
- `session/event` 是权威持久日志（`session.seq` + `session.eventAt(seq)`）。
- `session-stats` 提供对话计数与墙钟时间投影。
- `tools/result`（emit）提供冻结的工具结果快照，适合实时追加。

### Desktop 落点
- 客户端插件从事件流读取事件类型，渲染时间线 + 检索；订阅 `tools/result` 实时追加。
- 只读展示；分页 / 截断避免一次拉全量。
- 开关默认关闭。

---

## 3. 死循环熔断与复位（核心）

> **宏观自我反省不是独立插件，而是「死循环强制打断」后必经的复位阶段。** 二者是同一个熔断机制的两半。

### 完整流程

```
检测（重复调用 / 步数 / 时间预算）
  → 熔断：block 拒绝重复 + agent/pre-step reject 停止回合
  → 必经复位（宏观自我反省）：
      1. 抛开繁杂细节 —— 构造去噪高层上下文（目标 + 回合轮廓 + L2 摘要 + 失败点）
      2. 独立 LLM 调用做宏观反省，让模型智商回到高地：重新明确目标、制定计划
      3. 若发现歧义 —— 主动向用户发问卷（ctx.userQuestions）
      4. 按澄清后的目标 / 新计划重新动手，而非继续蛮干
```

### 检测
- `tools/post-execute` 规范化调用（深 key 排序 + 全量串比较，复用 `repeat-tool-reminder` 的 canonicalize 思路），维护连续重复计数。
- `agent/pre-step` 维护回合步数预算与墙钟时间预算。

### 熔断
- 软阈值：注入提醒（语义复用上游 advisory 提醒）。
- 硬阈值：
  - `tools/post-execute` 返回 `{ kind: 'block', feedback }` —— 拒绝这次重复调用。
  - `agent/pre-step` 返回 `{ kind: 'reject' }` —— 强制结束本回合。

### 复位（宏观自我反省，必经）
打断后进入复位，不是把提示塞进下一步，而是一次**去噪后的独立反省**：

1. **去噪上下文**：`ctx.goals.get(agent)`（当前目标）+ 本次熔断的失败点（重复的调用名 / 超限的步数或时间）。**不**把被重复失败污染的原始长上下文塞回去。`turnOutline` 投影与 `desktop-context` 的 L2 会话摘要作为后续增强（v1 未接线）。
2. **独立反省调用**：复用 `desktop-context` 的 L2 折叠范式（`ctx.get('llm').stream()` + `BlockAssembler`，`purpose: 'compaction'`——上游 `GenerateOptions.purpose` 只有 `'compaction' | 'session-title'`，无 `'reflection'`），让模型在干净的高层上下文里重新明确目标、制定下一步计划；输出为单 JSON 对象 `{ goal, plan, ambiguous, question }`，解析失败则降级为纯文本、按「无歧义」继续。
3. **歧义 → 问卷**：若反省 `ambiguous: true` 且 `askOnAmbiguity`，调用 `ctx.userQuestions.ask(...)` 主动向用户发问卷澄清（无 answerer / headless 时 fail-soft 跳过）；拿到回答后再对齐。
4. **重新动手**：把反省产出（明确目标 + 计划 + 用户澄清）通过 `agent.steer(...)` 重新注入唤醒 agent，按新方向继续，而不是继续打转。

### 边界
- `block` 只拒当前调用，`reject` 才停止回合；二者组合才是完整熔断。
- 复位是「熔断后的必经路径」，但整个「熔断与复位」能力本身仍是可选插件（默认关闭），开启后此流程才生效。
- 阈值（软 / 硬 / 步数 / 时间）、反省调用模型、问卷策略全部是 config 字段。

---

## 落地顺序

- **Phase A（host，先做，已完成）**：`3 死循环熔断与复位` —— 已实现为 `src/loop-guard.ts`（插件名 `desktop-loop-guard`），beta 与 stable 两包对称接线（`tsdown` 入口 `loop-guard`、`./loop-guard` export、`cordis.patch.yml` 以 `disabled: true` 挂载），typecheck 与 build 均通过。
- **Phase B（client，后做）**：`1 实时消耗显示`、`2 活动轨迹` —— 需要客户端 UI（React 组件 + locale 字典 + 设置开关），工作量更大。

## 与既有工作的关系

- `3` 的复位阶段直接消费 `desktop-context` 的 L2 摘要，形成闭环：压缩沉淀的高层摘要，正是熔断后「抛开细节、智商回到高地」的去噪原料。
- `1/2` 是「看得见」，`3` 是「刹得住 + 回得来」。
- 全部通过 `cordis.patch.yml` 以 `disabled: true` 注入，config 布尔开关控制，不影响默认组合。
