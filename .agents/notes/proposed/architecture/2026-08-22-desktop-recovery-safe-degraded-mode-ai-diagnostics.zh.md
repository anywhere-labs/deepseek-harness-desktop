# Agent Note：桌面恢复页面增强 —— 安全降级模式 + AI 辅助故障诊断

状态：提议（Proposed）

> 设计目标：修复"插件 / 子模块 / 依赖问题导致完全无法进入主页面"的故障恢复体验。
> 核心原则：**不能因插件、子模块兼容、依赖问题导致完全无法进入主页面。**

## 问题

`Cannot find module xxx` / `plugin tree failed to load` 并不会让应用崩溃，而是让**该代际的 Host 或 Client 启动失败**并落到恢复窗口。真正的问题是：

1. **Host 启动失败**：恢复窗口是唯一出口，且只有「禁用 / 回滚 / 重试 / 退出」四条死路，**没有一条"先跳过故障、进主页再说"的降级出路**。单个必需插件失败即整树失败。
2. **Renderer 加载插件失败**：boot 页显示 `Failed to load plugins` 时，只注入一个「打开 DSH 终端」按钮，**无恢复窗口、无返回主页路径**——这是"卡死、进不去"最严重的空窗。
3. **诊断包缺关键证据**：无完整报错堆栈、插件加载树、子模块 commit、系统环境快照、配置快照。
4. **AI 能力**：无任何"普通人能看懂"的分析、修复方案、风险提示、自检与"重启生效"闭环。

> 语义说明：仓库中**没有"plugin tree"这一实体**——它指 Cordis 插件树 / pnpm 进程树。真实数据结构是 **Bundle 清单**（`DesktopProfileManifestBundle`: `packageName` / `status`: active|disabled / `mutable`，见 `dsh-plugin-desktop/src/desktop-plugins.ts:177-181`）。本设计对齐该语义。

## 解决方案

### 1. 故障降级策略（安全降级模式）

新增一种**生成级排除集 + 降级横幅 + 可逆**的档位，与"永久禁用"严格区分：

| 档位 | 语义 | 持久化 | 可逆 | 现状 |
|---|---|---|---|---|
| 自动降级 | 可选 client-ui 插件解析失败自动跳过 | 内存生成级 | 每次启动重判 | 已有 `omitUnresolvedOptionalEntries`（`src/profile.ts:419-453`）|
| **安全降级模式（新增）** | 用户显式选择：跳过故障 bundle 进主页，显示横幅 | `startup-recovery/degraded.json` | **可逆** | 无 |
| 永久禁用 | 用户确认该插件不再启用 | `plugin-management/state.json` | 需手动启用 | 已有 `executeDisable` |

**注入点（最小改动）**：在 `src/profile.ts` 的 patch 层组合阶段，把 `degraded.json` 里的 bundle 名从各层 patch 剔除（复用 `omitUnresolvedOptionalEntries` 思路，作用于**必需入口**）。**不改上游 `boot()`、不碰 `@deepseek-ai/dsh-app-boot` 依赖包**。

**数据流**：
```
恢复窗口[安全降级模式] → 写 degraded.json → finish('restart') → relaunch
  → 下一次 boot: profile.ts 读 degraded.json → 剔除故障 bundle → 进主页
  → client/main 窗读 degraded.json → 顶部横幅"安全降级模式：插件 X 未加载"
  → 横幅[恢复完整插件集] → 清空 degraded.json → relaunch
```

**降级护栏**：建立**最小健康集**（`dsh-app-boot`、`webserver`、`settings`、`desktop-shell`、`dsh-session` 等核心行）。故障落在最小健康集内时**禁止降级进主页**（裸主页也不可用），只能禁用 / 回滚 / 恢复配置——避免"降级了还是黑屏"。

### 2. 诊断包增强

接入 `src/diagnostic-export-worker.ts` 的 `createDiagnosticsArchive()`（`:167-286`），新增以下证据（沿用 50MB 预算、脱敏、原子发布、保留 3 份）：

| 新增项 | 数据来源 | 落点 |
|---|---|---|
| 完整报错堆栈 | 启动失败异常（`main.ts:831` 的 `cause`/`stack`） | 新增 `error-stack.txt`（含 cause 链） |
| 插件加载树 / 清单 | `readDesktopProfileBundleInventory`（`src/desktop-plugins.ts:368`） | 新增 `plugin-manifest.json`（有序 bundle + status + 顺序） |
| 各子模块 commit 版本 | 根 `upstream.json` commit；`git rev-parse HEAD`（允许时）；`@deepseek-ai/dsh` build 信息 | 新增 `versions.json` |
| 系统环境快照 | `process.env` 关键项（复用 `mask-secrets.ts` 脱敏） | 并入 `system-info.txt` |
| 当前插件清单 | `package.json → dsh.profile.bundles` | 新增 `profile-bundles.json` |
| 配置文件快照 | `cordis.patch.yml` / `package.json` / `pnpm-workspace.yaml` | 复用 `DESKTOP_PROFILE_CHECKPOINT_FILES` 白名单（`src/profile-checkpoint.ts:40-56`） |

> `node` / `electron` 版本已在 `system-info.txt`（`:239-240`），无需重复。

### 3. AI 诊断链路（分层、永不阻塞）

DSH 推理本身是插件树里的组件而插件树恰恰挂了，因此 AI 能力设计为分层，规则分析兜底，确保**即使模型完全不可用，恢复页也不会卡住**：

```
diagnostics.zip
  ├─ Tier 0  确定性规则分析（无模型、无网络、永不失败）
  │          解折堆栈 → 正则 "Cannot find module 'X'"
  │          → module-resolution 探测 X（复用 src/module-resolution.ts）
  │          → 错误短语 → 已知根因映射（中文）→ 只输出"根因 + 修复选项"，绝不改配置
  ├─ Tier 1  项目 DSH 本地推理（有则用，无则跳过）
  │          spawn 独立 CLI @deepseek-ai/dsh/lib/bin.js（只读，不加载桌面插件树）
  │          → 本地模型产出"通俗中文根因 + 逐方案风险 + 推荐"
  └─ Tier 2  外部模型（可选，默认关闭，仅当用户已配且本地不可用才触发）
```

**边界约束落实**：AI 只分析只建议，产出为「问题描述 + 风险等级 + 方案列表(含风险) + 推荐」，不写任何配置；写配置仅发生在用户点击【执行修复】后，且由 `repair-plans.ts`（非 AI）执行。优先本地、不强制联网。决策权永远在用户。

## UI 交互设计

恢复窗口为**无 JS / 自包含 `data:` HTML + 严格 CSP**（`src/startup-recovery-window.ts:386`，`connect-src 'none'`），**无 IPC**，UI→主进程走 **URL scheme 动作总线**（`dsh-recovery://<action>?id=…`，`:324-328, 418-433`），主→UI 整份 `loadURL` 重渲。新增动作用同一套总线，零 IPC、零 CSP 放宽。

新增区域【AI 辅助故障分析】（插在 Diagnostics 卡片之下）：

```
┌─ 启动错误卡片（现有 stage + 截断 detail，上调 MAX_FAILURE_DETAIL_LENGTH 容纳堆栈）
├─ [AI 辅助故障分析]（新卡片）
│  ├─ 按钮①：加载本地诊断包        ─┐
│  ├─ 按钮②：自动读取已生成的包      ─┤→ ai-analyze（single-flight，带进度状态）
│  ├─ 状态行：分析中 / 完成 / 失败
│  ├─ 根因区：通俗中文根因 + 风险等级 badge（低/中/高）
│  ├─ 方案区 (radio)：
│  │     ○ A 临时禁用故障插件（低风险…）
│  │     ○ B 回滚子模块版本（高风险·仅开发者…）
│  │     ○ C 重置插件加载清单（中风险…）
│  │     ○ D 恢复默认配置（低~中风险…）
│  │  [ 执行修复 ]
│  ├─ 自检报告区：✅/❌ 插件树可加载 / 关键模块可导入 + 明细
│  └─ [ 重新启动 DSH Desktop ]
├─ 原有卡片（Last protected installation / Plugin bundle list / Manual config / Diagnostics）——全部保留
└─ Footer：Restart + Quit（原有）
```

**无 JS 下实现 radio 单选 + 执行修复**：HTML radio 纯 DOM 状态可选中；提交用 GET 表单，submit 触发导航落 `will-navigate`/`will-redirect` 拦截器（`:491-497`），URL 变为 `dsh-recovery://execute-repair?option=A`，正好被 `parseDesktopStartupRecoveryAction` 解析：

```html
<form method="GET" action="dsh-recovery://execute-repair">
  <label><input type="radio" name="option" value="A" checked> 方案A …</label>
  <button type="submit">执行修复</button>
</form>
```

**兜底**：若严格 CSP 下 `will-navigate` 对表单 GET 不触发（需实测），退化为**每方案独立按钮**（`dsh-recovery://execute-repair?option=A`）。

**主窗降级横幅**：`client/` 顶部加「⚠️ 安全降级模式：插件 X 未加载，基础聊天/WebUI 可用，部分功能受限。[恢复完整插件集] [查看诊断]」，读 `degraded.json` 显隐。

## 修复方案与自检

### 方案注册表（`repair-plans.ts`，类型化、非 AI 可执行）

```ts
interface RepairPlan {
  id: 'A'|'B'|'C'|'D'
  title: string
  description: string          // 普通人视角
  risk: { severity: 'low'|'medium'|'high'; notes: string }
  audience: 'end-user'|'developer'|'both'
  apply(): Promise<RepairOutcome>   // 唯一写配置的地方
}
```

| id | 方案 | 底层机制 | 风险 | 面向 |
|---|---|---|---|---|
| A | 临时禁用故障插件 | disable 标记（或降级 exclude，可逆） | 低：仅该插件不可用 | 两类 |
| B | 回滚子模块版本（开发） | 改 `upstream.json` commit + submodule checkout 上一 commit | **高**：违反"不编辑子模块"约束，需显式告警 | developer |
| C | 重置插件加载清单 | 重写 `package.json → dsh.profile.bundles` 为默认 / 上次健康集 | 中：可能丢自定义组合 | 两类 |
| D | 恢复默认配置 | `DesktopProfileCheckpoint.restoreLatest(failureGeneration)`（`src/profile-checkpoint.ts:376-419`） | 低~中：恢复上次健康快照 | 两类 |

> 边界约束①：方案 A/C/D 在用户点击后由 `repair.apply()` 执行；方案 B 因改子模块，额外二次确认弹窗并标注开发者专属。

### 自检验证（`repair-self-check.ts`）

修复执行后、**不做重启**，在恢复代际内跑只读校验：

1. **插件树可加载**：用 resolver 探测目标 bundle 能否被 `ctx.loader.internal.import()` 解析、能否 `activate`（复用 `module-resolution.ts`，不真启动整树）。
2. **关键模块可导入**：对最小健康集逐个 `import()` 裸路径，断言成功。
3. 输出结构化报告：`{ ok, checks: [{ name, passed, detail }], recommendation }`。

渲染为：✅ 修复成功 → "点击【重新启动 DSH Desktop】生效"；❌ 修复失败 → "请尝试其他方案"（回退到 radio，保留历史结果）。自检必须**只读探测**，不污染代际。

## 需要改动的文件清单（最小改造）

> 尽量小、不重构、不碰上游 submodule、不动 `dsh-app-boot` 依赖包。核心是把"降级 + AI 分析"作为**新模块**接入现有恢复窗口总线。

**新增**：

| 文件 | 职责 |
|---|---|
| `dsh-plugin-desktop/src/diagnostic-analyzer.ts` | Tier 0 规则分析（堆栈解构、module-not-found、根因映射）。纯函数无 IO/网络。 |
| `dsh-plugin-desktop/src/ai-diagnostic-analyzer.ts` | Tier 1 本地 DSH 推理封装（spawn `@deepseek-ai/dsh/lib/bin.js`），失败静默降级 Tier0。 |
| `dsh-plugin-desktop/src/repair-plans.ts` | 方案 A–D 注册表 + 风险 + `apply()`。 |
| `dsh-plugin-desktop/src/repair-self-check.ts` | 修复后只读自检（resolver 探测 + 关键模块 importable）。 |

**修改**：

| 文件 | 改动点 |
|---|---|
| `dsh-plugin-desktop/src/startup-recovery-window.ts` | 新动作入白名单（`:418-433`）；新增 `handleAiAnalyze`/`handleExecuteRepair` 与状态字段；HTML 加 AI 卡片 + radio 表单；上调 `MAX_FAILURE_DETAIL_LENGTH`。 |
| `dsh-plugin-desktop/src/startup-recovery-controller.ts` | 新增 `runAiAnalysis()`、`executeRepair(id)`、`commitDegraded(bundles)`、single-flight 与 dispose 清理。 |
| `dsh-plugin-desktop/src/diagnostic-export-worker.ts` | `createDiagnosticsArchive()` 增写 `error-stack.txt`/`plugin-manifest.json`/`versions.json`/`profile-bundles.json`/config 快照；system-info 增 env 快照。 |
| `dsh-plugin-desktop/src/diagnostics.ts` / `diagnostic-export.ts` | 导出选项透传 stack/manifest/commit 等新证据源。 |
| `dsh-plugin-desktop/src/profile.ts` | patch 层组合阶段读 `degraded.json`，剔除降级 bundle。 |
| `dsh-plugin-desktop/src/main.ts` | 传入诊断新证据来源；recovery 工厂接 `runAiAnalysis`/`executeRepair`/`commitDegraded`；启动失败处采集堆栈；（可选）boot 页插件失败也路由到增强恢复窗口闭合 P2。 |

**明确不改**：`deepseek-harness/` 子模块、`@deepseek-ai/dsh-app-boot`、`src/startup-failure-routing.ts`（纯决策表保持纯净）。所有旧功能（禁用插件、编辑配置补丁、导出诊断包、回滚/重试、重启/退出）保留。AI 零写配置。

## 风险点

1. **AI-Tier1 可能复现故障**：本地 DSH 推理若仍走 `boot()` 会撞上同一失败。→ 用独立 CLI 只读模式、不加载桌面插件树；失败静默降级 Tier0，绝不阻塞恢复页。
2. **降级 exclude 与永久禁用语义易混淆**：→ `degraded.json` 与 `state.json` 分离，横幅明确标注并附一键退出降级。
3. **最小健康集误判**：核心行故障禁止降级，仅给禁用 / 回滚 / 恢复配置，避免黑屏。
4. **方案 B 违反仓库纪律**（"不编辑子模块"）：→ 仅开发者可见 + 二次确认 + 明确高警示。
5. **诊断包膨胀 / 隐私**：env 快照复用 `mask-secrets.ts` 只取白名单 key；沿用 50MB 预算与保留 3 份。
6. **无 JS 表单可靠性**：严格 CSP/partition 下 GET 表单导航未必命中拦截器。→ 保留"每方案独立按钮"兜底，需 Windows/macOS 实测。
7. **AI 产生误导性诊断**：→ Tier0 规则兜底（确定性），输出标注"AI 辅助建议，仅供参考，最终以你选择为准"；AI 永不被授权自动执行修复。

## 落地建议（次序列）

1. 先做诊断包增强（最独立、风险最低）。
2. 再做**安全降级模式**（主诉：`degraded.json` + `profile.ts` 剔除 + 横幅），不依赖 AI，先让用户"进得去"。
3. 最后接 **AI 分析（Tier0 → Tier1）+ 修复方案 + 自检 + 重启闭环**。
4. 全链路跑 `corepack yarn typecheck`、`corepack yarn test`、`corepack yarn check` 三关后提 PR。
