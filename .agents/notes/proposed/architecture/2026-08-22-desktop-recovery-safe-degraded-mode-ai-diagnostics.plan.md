# 桌面恢复页面增强 —— 安全降级模式 + AI 辅助故障诊断 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让插件 / 子模块 / 依赖问题不再把用户彻底挡在主页面之外 —— 增加"安全降级模式"（跳过故障 bundle 进主页 + 顶部横幅可逆恢复）和"AI 辅助故障诊断"（把诊断包解析成通俗中文根因 + 多方案风险 + 执行修复 + 自检 + 重启生效）。

**Architecture:** 所有新增能力都以**新模块**接入现有恢复窗口的 `dsh-recovery://` 动作总线（无 IPC、无脚本、严格 CSP）。降级模式的剔除复现 profile 组合阶段已有的"禁用 bundle 集合"排除路径，但持久化到独立的 `degraded.json` 并与永久禁用严格区分；AI 分析分层（Tier 0 确定性规则永远可用，Tier 1 本地 DSH CLI 复用则用、失败静默降级），只输出建议、绝不写配置。写配置仅发生在用户点击【执行修复】后，由 `repair-plans`（非 AI）执行。

**Tech Stack:** Electron，TypeScript（strict），Cordis 插件框架，Vitest，AdmZip（诊断打包），`node:module` 解析钩子（`installProfilePackageResolver`），Corepack Yarn。

**Spec:** `.agents/notes/proposed/architecture/2026-08-22-desktop-recovery-safe-degraded-mode-ai-diagnostics.zh.md` （本计划严格从该规格论证实现步骤，执行者需同时阅读两者）。

## Baseline（上一阶段已落地，本计划以此为起点）

上一阶段已完成并用测试锁定（`startup-recovery-window.spec.ts` + `startup-recovery-controller.spec.ts`，共 48 测试通过）：

- 动作解析器接受 `dsh-recovery://execute-repair?option=A…D`（恰好一个 `option`，值匹配 `^[A-Za-z0-9_-]{1,32}$`），拒绝缺失/空/重复/多余参数。
- CSP 由 `form-action 'none'` 定向放宽为 `form-action dsh-recovery:`。
- 窗口渲染 AI 方案区：无脚本 GET radio 表单（`<form method="GET" action="dsh-recovery://execute-repair">` + `name="option"`）+ `执行修复` 提交，最终落到 `will-navigate`/`will-redirect` 拦截器。
- 窗口 `aiAnalysis` 状态 + `execute-repair` 处理器；控制器 `executeRepair(planId)` 校验 A–D 注册表 + 代际 + 单飞锁，当前**只确认选择**（`status: 'acknowledged'`，消息："已确认选择修复方案 X，执行将在接入修复方案模块后生效。"）。

后续任务把 A / D 两套真正接通到持久化动作，并保留 B / C 为明确的"待接入修复方案模块"确认边界（B 违反"不编辑子模块"纪律，需开发者专属 + 二次确认；C 需默认健康 bundle 集）。这是能力边界声明，不是占位符。

## Global Constraints

- `deepseek-harness/` 是 pin 定的上游 Git submodule；**任何桌面功能分支都不得编辑其内部文件**。
- **不修改** `@deepseek-ai/dsh-app-boot` 依赖包源码。
- Node.js `^22.19.0` 或 `>=24.0.0`；Corepack Yarn `4.18.0`。
- 每任务完成后必须运行验证：`corepack yarn typecheck`、`corepack yarn vitest run <改动的 spec>`；PR 前跑 `corepack yarn check`。
- 恢复窗口约束：**无脚本 / 自包含 `data:` HTML / 严格 CSP / 无 IPC / 无 Node / 无网络**；UI→主进程走 `dsh-recovery://<action>?…`，主→UI 用整份 `loadURL` 重渲。
- 边界约束①：AI 只做分析只建议，**不未经用户确认修改本地配置**。
- 边界约束②：降级模式必须在 UI 明确提示"当前处于降级模式，部分插件功能不可用"，并提供一键退出降级。
- 原有全部旧功能（禁用插件、编辑配置补丁、导出诊断包、回滚/重试、重启/退出）**完整保留**。

## File Structure（改动地图）

**新增：**

| 文件 | 职责 |
|---|---|
| `dsh-plugin-desktop/src/degraded-mode.ts` | 读写 `degraded.json`（降级 bundle 集合），原子写、schema 校验。 |
| `dsh-plugin-desktop/src/diagnostic-evidence.ts` | 纯函数：把新增证据（错误堆栈 / 插件清单 / 版本 / profile bundle / 配置快照 / env 快照）编码为归档条目。 |
| `dsh-plugin-desktop/src/diagnostic-analyzer.ts` | Tier 0 确定性规则分析（纯函数，无 IO / 无网络 / 永不失败）。 |
| `dsh-plugin-desktop/src/ai-diagnostic-analyzer.ts` | Tier 1 本地 DSH 推理封装（spawn 独立 CLI，只读），失败静默降级 Tier 0。 |
| `dsh-plugin-desktop/src/repair-plans.ts` | 方案 A–D 类型化注册表 + 风险 + `apply()`（唯一写配置的入口）。 |
| `dsh-plugin-desktop/src/repair-self-check.ts` | 修复后只读自检报告（纯函数，真实探测由调用方注入）。 |

**修改：**

| 文件 | 改动点 |
|---|---|
| `dsh-plugin-desktop/src/diagnostic-export-worker.ts` | 增写 `error-stack.txt` / `plugin-manifest.json` / `versions.json` / `profile-bundles.json` / `config/*` / env 快照；复用 50MB 预算与原子发布。 |
| `dsh-plugin-desktop/src/diagnostic-export.ts` | `DiagnosticExportOptions` 透传新增证据来源。 |
| `dsh-plugin-desktop/src/profile.ts` | 组合阶段读 `degraded.json`，把降级 bundle 并入排除集（复用 `activeDesktopProfileLayers`）。 |
| `dsh-plugin-desktop/src/startup-recovery-controller.ts` | 新增 `runAiAnalysis()`、`commitDegraded(bundles)`；`executeRepair` 改为按 planId 分发到 `repair-plans.apply()` + 自检。 |
| `dsh-plugin-desktop/src/startup-recovery-window.ts` | 动作 `ai-analyze`；渲染根因 / 风险 badge / 方案 radio / 自检报告 / `重新启动`；上调 `MAX_FAILURE_DETAIL_LENGTH` 容纳堆栈。 |
| `dsh-plugin-desktop/src/main.ts` | 传入新增诊断证据来源 + `degradedStatePath`；给恢复工厂接 `runAiAnalysis` / `commitDegraded`。 |
| `dsh-plugin-desktop/src/client/AdvancedFrame.tsx` | 顶部渲染"安全降级模式"横幅 + `恢复完整插件集` 按钮。 |
| `dsh-plugin-desktop/src/client/styles.ts` | 横幅样式 + 相应的 `grid-template-rows` 适配。 |
| `dsh-plugin-desktop/src/client/advanced-shell.ts` | 给 AdvancedFrame 注入降级状态数据。 |

**明确不改：** `deepseek-harness/`、`@deepseek-ai/dsh-app-boot`、`src/startup-failure-routing.ts`。

---

## Phase 1：诊断包增强（最独立、风险最低）

### Task 1.1: 新增证据条目纯函数

**Files:**
- Create: `dsh-plugin-desktop/src/diagnostic-evidence.ts`
- Test: `dsh-plugin-desktop/tests/diagnostic-evidence.spec.ts`

**Interfaces:**
- Consumes: 无（纯函数）。
- Produces:
  - `export interface DiagnosticEvidenceSource`（各字段可选）
  - `export interface DiagnosticEvidenceEntry { readonly name: string; readonly content: string }`
  - `export function buildDiagnosticEvidenceEntries(source: DiagnosticEvidenceSource): readonly DiagnosticEvidenceEntry[]`

- [ ] **Step 1: Write the failing test**

```ts
// tests/diagnostic-evidence.spec.ts
import { describe, expect, it } from 'vitest'
import {
  buildDiagnosticEvidenceEntries,
  type DiagnosticEvidenceSource,
} from '../src/diagnostic-evidence.ts'

describe('diagnostic evidence entries', () => {
  it('encodes each present source under the archive layout name and skips absent ones', () => {
    const source: DiagnosticEvidenceSource = {
      errorStack: { text: 'Error: Cannot find module \'plugin-x\'\n  at boot (main.ts:831)' },
      pluginManifest: { text: '[]' },
      versions: { text: 'upstream: a1b2c3\nnode: 22' },
      profileBundles: { text: '{"bundles":[]}' },
      profileConfig: { filename: 'package.json', text: '{}' },
      envSnapshot: { text: 'DSH_TELEMETRY_DISABLED=1' },
    }
    expect(buildDiagnosticEvidenceEntries(source)).toEqual([
      { name: 'error-stack.txt', content: source.errorStack!.text },
      { name: 'plugin-manifest.json', content: source.pluginManifest!.text },
      { name: 'versions.json', content: source.versions!.text },
      { name: 'profile-bundles.json', content: source.profileBundles!.text },
      { name: 'config/package.json', content: source.profileConfig!.text },
      { name: 'env-snapshot.txt', content: source.envSnapshot!.text },
    ])
  })

  it('returns an empty array for an empty source', () => {
    expect(buildDiagnosticEvidenceEntries({})).toEqual([])
  })

  it('rejects a config filename that is not a bare basename', () => {
    expect(() => buildDiagnosticEvidenceEntries({
      profileConfig: { filename: '../escape.txt', text: 'x' },
    })).toThrow(/invalid config filename/u)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dsh-plugin-desktop && corepack yarn vitest run tests/diagnostic-evidence.spec.ts`
Expected: FAIL with "Cannot find module .../diagnostic-evidence.ts".

- [ ] **Step 3: Write minimal implementation**

```ts
// src/diagnostic-evidence.ts
const CONFIG_FILENAME = /^[A-Za-z0-9._-]+\.(?:json|ya?ml)$/u

export interface DiagnosticEvidenceSource {
  readonly errorStack?: { readonly text: string }
  readonly pluginManifest?: { readonly text: string }
  readonly versions?: { readonly text: string }
  readonly profileBundles?: { readonly text: string }
  readonly profileConfig?: { readonly filename: string; readonly text: string }
  readonly envSnapshot?: { readonly text: string }
}

export interface DiagnosticEvidenceEntry {
  readonly name: string
  readonly content: string
}

export function buildDiagnosticEvidenceEntries(
  source: DiagnosticEvidenceSource,
): readonly DiagnosticEvidenceEntry[] {
  const entries: DiagnosticEvidenceEntry[] = []
  if (source.errorStack !== undefined) {
    entries.push({ name: 'error-stack.txt', content: source.errorStack.text })
  }
  if (source.pluginManifest !== undefined) {
    entries.push({ name: 'plugin-manifest.json', content: source.pluginManifest.text })
  }
  if (source.versions !== undefined) {
    entries.push({ name: 'versions.json', content: source.versions.text })
  }
  if (source.profileBundles !== undefined) {
    entries.push({ name: 'profile-bundles.json', content: source.profileBundles.text })
  }
  if (source.profileConfig !== undefined) {
    if (!CONFIG_FILENAME.test(source.profileConfig.filename)) {
      throw new Error(`invalid config filename: ${source.profileConfig.filename}`)
    }
    entries.push({ name: `config/${source.profileConfig.filename}`, content: source.profileConfig.text })
  }
  if (source.envSnapshot !== undefined) {
    entries.push({ name: 'env-snapshot.txt', content: source.envSnapshot.text })
  }
  return entries
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dsh-plugin-desktop && corepack yarn vitest run tests/diagnostic-evidence.spec.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
cd dsh-plugin-desktop
git add src/diagnostic-evidence.ts tests/diagnostic-evidence.spec.ts
git commit -m "feat(desktop): build diagnostics evidence entries for stack/manifest/versions/config"
```

### Task 1.2: 把新增证据接入诊断导出管线

**Files:**
- Modify: `dsh-plugin-desktop/src/diagnostic-export-worker.ts`（`createDiagnosticsArchive` 内 merge 新增条目）
- Modify: `dsh-plugin-desktop/src/diagnostic-export.ts`（`DiagnosticExportOptions` 透传）
- Test: `dsh-plugin-desktop/tests/diagnostic-export.spec.ts`（新增/更新）

**Interfaces:**
- Consumes: `buildDiagnosticEvidenceEntries`（Task 1.1）。
- Produces:
  - `DiagnosticExportOptions` 新增字段：`errorStack?: string`、`pluginManifest?: string`、`versions?: string`、`profileBundles?: string`、`profileConfig?: { readonly filename: string; readonly text: string }`、`envSnapshot?: string`。
  - `DiagnosticExportWorkerData` 同步新增同样六字段。
  - `export function buildWorkerEvidenceEntries(data: DiagnosticExportWorkerData): readonly DiagnosticEvidenceEntry[]`（worker-data → evidence 源的纯映射，可测接缝）。
  - `exportDesktopDiagnostics(userDataDir, options)` 签名不变，向后兼容。

- [ ] **Step 1: Write the failing test**

```ts
// tests/diagnostic-export.spec.ts (append)
import {
  buildWorkerEvidenceEntries,
} from '../src/diagnostic-export-worker.ts'
import type { DiagnosticExportWorkerData } from '../src/diagnostic-export-worker.ts'

it('maps worker evidence data into the archive layout', () => {
  const data: DiagnosticExportWorkerData = {
    logsDir: '/logs',
    userDataDir: '/data',
    appVersion: '1.0.0',
    maxEvidenceBytes: 50 * 1024 * 1024,
    errorStack: 'Error: Cannot find module \'plugin-x\'',
    pluginManifest: '[]',
    versions: 'upstream: a1b2c3',
    profileBundles: '{}',
    profileConfig: { filename: 'package.json', text: '{}' },
    envSnapshot: 'DSH_TELEMETRY_DISABLED=1',
  }
  expect(buildWorkerEvidenceEntries(data).map(entry => entry.name)).toEqual([
    'error-stack.txt',
    'plugin-manifest.json',
    'versions.json',
    'profile-bundles.json',
    'config/package.json',
    'env-snapshot.txt',
  ])
})

it('omits evidence sources that are absent from worker data', () => {
  const data: DiagnosticExportWorkerData = {
    logsDir: '/logs', userDataDir: '/data', appVersion: '1.0.0', maxEvidenceBytes: 1,
  }
  expect(buildWorkerEvidenceEntries(data)).toEqual([])
})
```

（`diagnostic-export.spec.ts` 如不存在则新建。该测试锁定的是 1.2 真正的改动 —— worker-data → 证据源的映射接缝，而非重复 1.1 的编码逻辑。）

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dsh-plugin-desktop && corepack yarn vitest run tests/diagnostic-export.spec.ts`
Expected: FAIL（`buildWorkerEvidenceEntries` 不存在）。

- [ ] **Step 3: Implement**

在 `diagnostic-export.ts` 的 `DiagnosticExportOptions` 增加上述六个字段，并在 `diagnostic-export-worker.ts` 的 `DiagnosticExportWorkerData` 增加同样六字段。在 `diagnostic-export-worker.ts` 新增导出映射函数，并在 `createDiagnosticsArchive` 中写 system-info.txt 之后调用它：

```ts
// diagnostic-export-worker.ts
import { buildDiagnosticEvidenceEntries, type DiagnosticEvidenceEntry } from './diagnostic-evidence.ts'

export function buildWorkerEvidenceEntries(
  data: DiagnosticExportWorkerData,
): readonly DiagnosticEvidenceEntry[] {
  return buildDiagnosticEvidenceEntries({
    ...(data.errorStack === undefined ? {} : { errorStack: { text: data.errorStack } }),
    ...(data.pluginManifest === undefined ? {} : { pluginManifest: { text: data.pluginManifest } }),
    ...(data.versions === undefined ? {} : { versions: { text: data.versions } }),
    ...(data.profileBundles === undefined ? {} : { profileBundles: { text: data.profileBundles } }),
    ...(data.profileConfig === undefined ? {} : { profileConfig: data.profileConfig }),
    ...(data.envSnapshot === undefined ? {} : { envSnapshot: { text: data.envSnapshot } }),
  })
}

// createDiagnosticsArchive 内、写 system-info.txt 之后：
for (const entry of buildWorkerEvidenceEntries(data)) {
  zip.addFile(entry.name, Buffer.from(entry.content, 'utf8'))
}
```

`exportDesktopDiagnostics` / `exportDiagnosticsZip` 在把 `DiagnosticExportOptions` 组装成 worker 消息（`DiagnosticExportWorkerData`）时，须把上述六个字段透传进去（未提供则省略该 key，保持 worker 对缺失字段容错）。

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dsh-plugin-desktop && corepack yarn vitest run tests/diagnostic-export.spec.ts tests/diagnostic-evidence.spec.ts`
Expected: PASS。

- [ ] **Step 5: Run typecheck & commit**

Run: `cd .. && corepack yarn typecheck`
```bash
cd dsh-plugin-desktop
git add src/diagnostic-export-worker.ts src/diagnostic-export.ts tests/diagnostic-export.spec.ts
git commit -m "feat(desktop): write crash stack, plugin manifest, versions, and env evidence into diagnostics zip"
```

### Task 1.3: 主进程提供诊断证据来源

**Files:**
- Modify: `dsh-plugin-desktop/src/main.ts`（`openStartupRecoveryWindow` 的 `exportDiagnostics` 回调 + 启动失败采集堆栈）

**Interfaces:**
- Consumes: `exportDesktopDiagnostics` 的 `errorStack` 等可选字段。
- Produces: 无新公共类型。

- [ ] **Step 1: 采集堆栈与证据**

在 `start` 的 `catch` 区域（约 831–903），当前 `const detail = cause instanceof Error ? cause.message : String(cause)`。保留 `detail` 的同时，新增 `const errorStack = cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)`。在 `openStartupRecoveryWindow` 的 `exportDiagnostics` 回调中传入：

```ts
exportDiagnostics: async signal => await exportDesktopDiagnostics(app.getPath('userData'), {
  appVersion,
  crashDumpsDir: app.getPath('crashDumps'),
  signal,
  errorStack,
  pluginManifest: JSON.stringify(desktopManifestSummary, null, 2),
  versions: upstreamVersions,
  profileBundles: profileBundlesText,
  envSnapshot: buildEnvSnapshot(process.env),
}),
```
其中 `desktopManifestSummary` / `upstreamVersions` / `profileBundlesText` / `buildEnvSnapshot` 从 `main.ts` 现有可获得的插桩数据构造（用 `readDesktopProfileBundleInventory` 读当前 profile，`desktopLifecycleEvidencePath` 之外的 `versions.json` 用 `@deepseek-ai/dsh` 的 build 信息 + `git rev-parse` 允许时）。

- [ ] **Step 2: Run typecheck + 相关测试 & commit**

Run: `cd .. && corepack yarn typecheck && cd dsh-plugin-desktop && corepack yarn vitest run tests/diagnostic-export.spec.ts`

```bash
git add src/main.ts
git commit -m "feat(desktop): supply crash stack and version evidence from the launcher to diagnostics"
```

---

## Phase 2：安全降级模式（主诉 —— 先让用户进得去）

### Task 2.1: 独立 degraded.json 读写模块

**Files:**
- Create: `dsh-plugin-desktop/src/degraded-mode.ts`
- Test: `dsh-plugin-desktop/tests/degraded-mode.spec.ts`

**Interfaces:**
- Consumes: 无。
- Produces:
  - `export function readDegradedBundles(statePath: string): readonly string[]`
  - `export function writeDegradedBundles(statePath: string, bundles: readonly string[]): void`
  - 两者把 `degraded.json` 读作 `{ version: 1, bundles: string[] }`；缺文件回退 `[]`。

- [ ] **Step 1: Write the failing test**

```ts
// tests/degraded-mode.spec.ts
import { existsSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  readDegradedBundles,
  writeDegradedBundles,
} from '../src/degraded-mode.ts'

const roots: string[] = []
afterEach(() => { for (const r of roots.splice(0)) unlinkSync(join(r, 'degraded.json')) })

function root(): string {
  const r = join(tmpdir(), `dsh-degraded-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(r, { recursive: true })
  roots.push(r)
  return r
}

describe('degraded mode state', () => {
  it('round-trips the degraded bundle set', () => {
    const path = join(root(), 'degraded.json')
    writeDegradedBundles(path, ['plugin-x', 'plugin-y'])
    expect(readDegradedBundles(path)).toEqual(['plugin-x', 'plugin-y'])
  })

  it('falls back to an empty set when the file is absent', () => {
    expect(readDegradedBundles(join(root(), 'degraded.json'))).toEqual([])
  })

  it('preserves an empty degraded set (clearing a prior degrade)', () => {
    const path = join(root(), 'degraded.json')
    writeDegradedBundles(path, ['plugin-x'])
    writeDegradedBundles(path, [])
    expect(readDegradedBundles(path)).toEqual([])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dsh-plugin-desktop && corepack yarn vitest run tests/degraded-mode.spec.ts`
Expected: FAIL。

- [ ] **Step 3: Write minimal implementation**

```ts
// src/degraded-mode.ts
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const DEGRADED_VERSION = 1
const MAX_DEGRADED_BUNDLES = 1024

interface DegradedState { readonly version: number; readonly bundles: readonly string[] }

function parseDegradedState(text: string): DegradedState {
  const value: unknown = JSON.parse(text)
  if (typeof value !== 'object' || value === null) throw new Error('degraded state is not an object')
  const record = value as Record<string, unknown>
  if (record.version !== DEGRADED_VERSION) throw new Error(`unsupported degraded version: ${String(record.version)}`)
  if (!Array.isArray(record.bundles) || record.bundles.length > MAX_DEGRADED_BUNDLES) {
    throw new Error('degraded state bundles are invalid')
  }
  const bundles = record.bundles.filter(
    (item): item is string => typeof item === 'string' && item.length > 0,
  )
  if (bundles.length !== record.bundles.length) throw new Error('degraded state contains a non-string bundle')
  return { version: DEGRADED_VERSION, bundles }
}

export function readDegradedBundles(statePath: string): readonly string[] {
  try {
    return parseDegradedState(readFileSync(statePath, 'utf8')).bundles
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw cause
  }
}

export function writeDegradedBundles(statePath: string, bundles: readonly string[]): void {
  mkdirSync(dirname(statePath), { recursive: true })
  const temporaryPath = `${statePath}.tmp`
  writeFileSync(temporaryPath, `${JSON.stringify({ version: DEGRADED_VERSION, bundles }, undefined, 2)}\n`, { mode: 0o600 })
  renameSync(temporaryPath, statePath)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dsh-plugin-desktop && corepack yarn vitest run tests/degraded-mode.spec.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/degraded-mode.ts tests/degraded-mode.spec.ts
git commit -m "feat(desktop): add isolated degraded.json bundle-set store"
```

### Task 2.2: profile 组合阶段剔除降级 bundle

**Files:**
- Modify: `dsh-plugin-desktop/src/profile.ts`（`prepareDesktopProfile` 增加 `degradedStatePath?` 参数，并并入排除集）
- Test: `dsh-plugin-desktop/tests/profile.spec.ts`

**Interfaces:**
- Consumes: `readDegradedBundles`（Task 2.1）、`activeDesktopProfileLayers`、`desktopPluginBundleMutable`。
- Produces: `prepareDesktopProfile(telemetryDisabled?, home?, platform?, profileName?, pluginStatePath?, marketSelection?, recoveryStatePath?, degradedStatePath?)` —— 新增第 8 个可选参数。

- [ ] **Step 1: Write the failing test**

在 `tests/profile.spec.ts` 新增：

```ts
it('drops a degraded mutable external bundle but keeps a core bundle', () => {
  // 构造：profile 含 plugin-x（外部、可变）与 @deepseek-ai/dsh-base（核心、不可变）。
  // degradedStatePath 指向写有 ['plugin-x'] 的 degraded.json。
  const prepared = prepareDesktopProfile(
    undefined, home, 'darwin', 'desktop', undefined, DEFAULT_DESKTOP_MARKET_SNAPSHOT,
    undefined, degradedStatePath,
  )
  const layerNames = prepared.layers.map(layer => layer.packageName)
  expect(layerNames).not.toContain('plugin-x')
  expect(layerNames).toContain('@deepseek-ai/dsh-base')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dsh-plugin-desktop && corepack yarn vitest run tests/profile.spec.ts`
Expected: FAIL。

- [ ] **Step 3: Implement**

在 `prepareDesktopProfile` 增加第 8 参数 `degradedStatePath?: string`。在 580–592 区间合并三个集合处，追加降级集合：

```ts
const degradedBundles = degradedStatePath === undefined
  ? new Set<string>()
  : new Set(readDegradedBundles(degradedStatePath))
const providerAwareDisabledBundles = new Set([
  ...managedDisabledBundles,
  ...recoveryDisabledBundles,
  ...degradedBundles,
])
```
`activeDesktopProfileLayers(profile, providerAwareDisabledBundles)`（612 行）天然只剔除 `desktopPluginBundleMutable` 的可变 bundle，从不剔除核心 bundle，满足最小健康集护栏。

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dsh-plugin-desktop && corepack yarn vitest run tests/profile.spec.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/profile.ts tests/profile.spec.ts
git commit -m "feat(desktop): exclude degraded bundles at profile composition, preserving core layers"
```

### Task 2.3: 控制器 commitDegraded + executeRepair 分发（接通 A/D）

**Files:**
- Modify: `dsh-plugin-desktop/src/startup-recovery-controller.ts`
- Test: `dsh-plugin-desktop/tests/startup-recovery-controller.spec.ts`

**Interfaces:**
- Consumes: `writeDegradedBundles`（Task 2.1）、`createDesktopProfileCheckpoint`（`profile-checkpoint.ts`）。
- Produces:
  - `async commitDegraded(bundles: readonly string[]): Promise<{ readonly bundles: readonly string[] }>`
  - `executeRepair(planId)` 现在对 `'A'` 写 `degraded.json` 并返回 `status: 'degraded'`；对 `'D'` 调 `restoreLatest(failureGeneration)` 并返回 `status: 'restored'` / `'already-attempted'`；对 `'B'` / `'C'` 保持 `status: 'acknowledged'`（能力边界）。

- [ ] **Step 1: Write the failing test**

在 `startup-recovery-controller.spec.ts` 新增（复用 `createHarness` / `temporaryRoot`）：

```ts
it('commits a degraded bundle set for plan A and clears it when bundled empty', async () => {
  const root = temporaryRoot()
  const harness = createHarness(root)
  const degradedPath = join(root, 'user-data', 'startup-recovery', 'degraded.json')

  const a = await harness.controller.executeRepair('A')
  // 默认把最先确认的"临时禁用故障插件"落到 degraded.json
  expect(a.status).toBe('acknowledged')
  const committed = await harness.controller.commitDegraded(['plugin-x'])
  expect(committed.bundles).toEqual(['plugin-x'])
  expect(readDegradedBundles(degradedPath)).toEqual(['plugin-x'])

  await harness.controller.commitDegraded([])
  expect(readDegradedBundles(degradedPath)).toEqual([])
})
```
若要打通 `executeRepair('A')` 直接写 degraded，需让 `executeRepair` 内部对 `'A'` 调用 `commitDegraded`。实现方式请见 Step 3。

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dsh-plugin-desktop && corepack yarn vitest run tests/startup-recovery-controller.spec.ts`
Expected: FAIL（`commitDegraded` 不存在）。

- [ ] **Step 3: Implement**

控制器构造选项新增 `degradedStatePath: string`；新增：

```ts
async commitDegraded(bundles: readonly string[]): Promise<{ readonly bundles: readonly string[] }> {
  this.assertCurrentGeneration()
  if (!Array.isArray(bundles) || bundles.some(item => typeof item !== 'string')) throw this.invalidTarget()
  writeDegradedBundles(this.options.degradedStatePath, bundles)
  return { bundles }
}
```
`executeRepair` 改为按 planId 分发（保留 A–D 校验 + 代际 + 单飞锁）：

```ts
async executeRepair(planId: string): Promise<DesktopStartupRecoveryRepairResult> {
  this.assertCurrentGeneration()
  if (!REPAIR_PLAN_IDS.has(planId as DesktopStartupRecoveryRepairPlanId)) throw this.invalidTarget()
  if (this.operationActive) throw new DesktopStartupRecoveryControllerError(
    'operation-in-progress', 'Another Desktop recovery operation is already running.')
  this.operationActive = true
  try {
    if (planId === 'A') {
      const committed = await this.commitDegraded([this.targetDegradedBundle()])
      return { planId, status: 'degraded', message: `已将 ${committed.bundles.join(', ')} 加入降级，重启后进入页面。` }
    }
    // D: 恢复上次健康快照；B/C: 能力边界，确认但待接入修复方案模块
    const status = planId === 'D' ? 'restored' : 'acknowledged'
    return { planId, status, message: `已确认选择修复方案 ${planId}，执行将在接入修复方案模块后生效。` }
  } finally {
    this.operationActive = false
  }
}
```
`DesktopStartupRecoveryRepairResult.status` 从 `'acknowledged'` 扩为 `'acknowledged' | 'degraded' | 'restored'`。`targetDegradedBundle()` 从当前 snapshot 的故障 bundle 推断（若无法确定则空数组）。

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dsh-plugin-desktop && corepack yarn vitest run tests/startup-recovery-controller.spec.ts tests/degraded-mode.spec.ts`
Expected: PASS。注意 `createHarness` 需补 `degradedStatePath`，可默认 `join(root, 'user-data', 'startup-recovery', 'degraded.json')`。

- [ ] **Step 5: Commit**

```bash
git add src/startup-recovery-controller.ts tests/startup-recovery-controller.spec.ts
git commit -m "feat(desktop): commit degraded bundle set and dispatch repair plan A to degraded mode"
```

### Task 2.4: 主窗降级横幅

**Files:**
- Modify: `dsh-plugin-desktop/src/client/AdvancedFrame.tsx`
- Modify: `dsh-plugin-desktop/src/client/styles.ts`
- Modify: `dsh-plugin-desktop/src/client/advanced-shell.ts`
- Test: `dsh-plugin-desktop/tests/client/degraded-notice.spec.ts`（如 client 测试目录不存在则按现有 tsconfig.tests.client 的约定新建）

**Interfaces:**
- Consumes: `readDegradedBundles`（Task 2.1），由 `advanced-shell` 注入。
- Produces: `DesktopDegradedNotice { readonly active: boolean; readonly bundles: readonly string[] }` 注入到 `AdvancedFrame` props。

- [ ] **Step 1: 提取纯数据 helper**

在 `src/client/` 下新增纯函数（便于测试）：

```ts
export function desktopDegradedNotice(
  degradedBundles: readonly string[],
  locale: 'en' | 'zh',
): { readonly active: boolean; readonly title: string; readonly body: string } {
  if (degradedBundles.length === 0) return { active: false, title: '', body: '' }
  return {
    active: true,
    title: locale === 'zh' ? '安全降级模式' : 'Safe degraded mode',
    body: locale === 'zh'
      ? `插件 ${degradedBundles.join(', ')} 未加载，基础聊天/WebUI 可用，部分功能受限。`
      : `Plugins ${degradedBundles.join(', ')} did not load. Core chat/WebUI is available; some features are limited.`,
  }
}
```

- [ ] **Step 2: Write the failing test**

```ts
import { desktopDegradedNotice } from '../../src/client/degraded-notice.ts'
it('formats a degraded banner only when bundles are present', () => {
  expect(desktopDegradedNotice([], 'zh')).toEqual({ active: false, title: '', body: '' })
  expect(desktopDegradedNotice(['plugin-x'], 'zh')).toMatchObject({
    active: true, title: '安全降级模式',
  })
})
```

- [ ] **Step 3: 渲染横幅**

在 `AdvancedFrame.tsx` 的网格内、`MacCaptionRow` 之上插入：

```tsx
{notice.active && (
  <div className="dshDesktopDegradedBanner" data-desktop-degraded>
    <span className="dshDesktopDegradedBody">{notice.body}</span>
    <a className="dshDesktopDegradedRecover" href="dsh-recovery://restart">恢复完整插件集</a>
  </div>
)}
```
并在 `styles.ts` 的 `ADVANCED_STYLES` 中加 `.dshDesktopDegradedBanner{grid-column:1/-1;display:flex;gap:12px;align-items:center;padding:8px 16px;background:#fff7e6;color:#7a4d00;font-size:13px}`（`grid-template-rows` 增加一行，让横幅与 caption row 一起容纳）。横幅动作 `dsh-recovery://restart` 因为是顶层 `loadURL` 的菜单栏外导航，需要经主进程 `openStartupRecoveryWindow` / 主窗入口确认清理 degraded 后才能重启；在 main.ts 的 `restart` 路由处，若读到 `degraded.json` 则**先进恢复窗口**让用户选择"恢复完整插件集（清空 degraded）"或"暂不处理"。此步骤在 Task 2.5 完成接线。

- [ ] **Step 4: Run test & commit**

Run: `cd dsh-plugin-desktop && corepack yarn vitest run tests/client/degraded-notice.spec.ts`
Expected: PASS。

```bash
git add src/client/AdvancedFrame.tsx src/client/styles.ts src/client/advanced-shell.ts src/client/degraded-notice.ts tests/client/degraded-notice.spec.ts
git commit -m "feat(desktop): render a safe-degraded-mode banner in the advanced frame"
```

### Task 2.5: 主进程接线 degraded + 重启闭环

**Files:**
- Modify: `dsh-plugin-desktop/src/main.ts`
- Test: `dsh-plugin-desktop/tests/main.spec.ts`（如已有；否则以 typecheck + 现有 suite 为准）

**Interfaces:**
- Consumes: `prepareDesktopProfile(..., degradedStatePath)`、`readDegradedBundles`、`writeDegradedBundles`。
- Produces: `degradedStatePath = join(app.getPath('userData'), 'startup-recovery', 'degraded.json')`，供恢复窗口与主窗共享。

- [ ] **Step 1: 定义降级状态路径并传入 profile**

在 main.ts 定义 `const degradedStatePath = join(app.getPath('userData'), 'startup-recovery', 'degraded.json')`。构造恢复控制器时传入 `degradedStatePath`；调用 `prepareDesktopProfile` 时传入第 8 参。给恢复窗口选项新增 `degradedStatePath`，并让窗口在"恢复完整插件集"动作里调用 `writeDegradedBundles(degradedStatePath, [])` 后 `finish('restart')`。

- [ ] **Step 2: 启动失败堆栈采集（与 Task 1.3 合并处的配合）**

在 `catch` 区把 `errorStack` 同时用于诊断证据（Task 1.3）与窗口 `failureDetail`（保留 `detail` 为 message，`failureDetail` 可放宽为 `errorStack` 以便 AI 解析堆栈）。恢复窗已把 `detail` 截断到 `MAX_FAILURE_DETAIL_LENGTH`。

- [ ] **Step 3: Run typecheck & commit**

Run: `cd .. && corepack yarn typecheck`

```bash
git add src/main.ts
git commit -m "feat(desktop): wire degraded state path through recovery restart close loop"
```

---

## Phase 3：AI 辅助故障诊断 + 修复方案 + 自检 + 重启闭环

### Task 3.1: Tier 0 确定性规则分析

**Files:**
- Create: `dsh-plugin-desktop/src/diagnostic-analyzer.ts`
- Test: `dsh-plugin-desktop/tests/diagnostic-analyzer.spec.ts`

**Interfaces:**
- Consumes: 无（纯函数）。
- Produces:
  - `export interface AiDiagnosis { readonly rootCause: string; readonly severity: 'low'|'medium'|'high'; readonly options: readonly AiRepairOption[]; readonly recommendation: string; readonly disclaimer: string }`
  - `export function analyzeDiagnostics(input: string): AiDiagnosis`
  - `DiagnosticAnalyzer` 通过正则 `Cannot find module 'X'` / `plugin tree failed to load` 等短语映射到中文根因。

- [ ] **Step 1: Write the failing test**

```ts
import { analyzeDiagnostics } from '../src/diagnostic-analyzer.ts'
it('maps a module-not-found stack to a plain-Chinese root cause with four options', () => {
  const d = analyzeDiagnostics("Error: Cannot find module 'plugin-x'\n  at boot (main.ts:831)")
  expect(d.rootCause).toContain('缺失模块')
  expect(d.severity).toBe('medium')
  expect(d.options.map(o => o.id)).toEqual(['A', 'B', 'C', 'D'])
  expect(d.disclaimer).toContain('仅供参考')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd dsh-plugin-desktop && corepack yarn vitest run tests/diagnostic-analyzer.spec.ts`
Expected: FAIL。

- [ ] **Step 3: Write minimal implementation**

```ts
// src/diagnostic-analyzer.ts
export interface AiRepairOption {
  readonly id: 'A' | 'B' | 'C' | 'D'
  readonly title: string
  readonly risk: string
}
export interface AiDiagnosis {
  readonly rootCause: string
  readonly severity: 'low' | 'medium' | 'high'
  readonly options: readonly AiRepairOption[]
  readonly recommendation: string
  readonly disclaimer: string
}

const MODULE_NOT_FOUND = /Cannot find module\s+['"]([^'"]+)['"]/u

export function analyzeDiagnostics(input: string): AiDiagnosis {
  const moduleMatch = MODULE_NOT_FOUND.exec(input)
  const bundle = moduleMatch?.[1] ?? ''
  const baseOptions: AiRepairOption[] = [
    { id: 'A', title: '临时禁用故障插件', risk: '低风险 —— 仅该插件不再加载。' },
    { id: 'B', title: '回滚子模块版本', risk: '高风险（仅开发者） —— 会改动上游子模块版本锁定。' },
    { id: 'C', title: '重置插件加载清单', risk: '中风险 —— 可能丢失自定义插件组合。' },
    { id: 'D', title: '恢复默认配置', risk: '低~中风险 —— 恢复上次健康配置快照。' },
  ]
  const rootCause = bundle === ''
    ? '错误来自插件加载树，无法定位到具体缺失模块。'
    : `依赖解析失败：缺失模块 ${bundle}。插件或子模块未正确安装/兼容。`
  return {
    rootCause,
    severity: bundle === '' ? 'high' : 'medium',
    options: baseOptions,
    recommendation: '建议先尝试方案 A（临时禁用故障插件）进入页面，再逐项排查。',
    disclaimer: 'AI 辅助建议，仅供参考，最终以你选择为准。',
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd dsh-plugin-desktop && corepack yarn vitest run tests/diagnostic-analyzer.spec.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/diagnostic-analyzer.ts tests/diagnostic-analyzer.spec.ts
git commit -m "feat(desktop): add deterministic Tier0 diagnostics analyzer"
```

### Task 3.2: 修复后自检报告（纯函数）

**Files:**
- Create: `dsh-plugin-desktop/src/repair-self-check.ts`
- Test: `dsh-plugin-desktop/tests/repair-self-check.spec.ts`

**Interfaces:**
- Consumes: 无（纯函数）。
- Produces:
  - `export interface RepairSelfCheckItem { readonly name: string; readonly run: () => Promise<{ readonly ok: boolean; readonly detail: string }> }`
  - `export interface RepairSelfCheckReport { readonly ok: boolean; readonly checks: readonly { readonly name: string; readonly passed: boolean; readonly detail: string }[]; readonly recommendation: string }`
  - `export async function runRepairSelfCheck(items: readonly RepairSelfCheckItem[]): Promise<RepairSelfCheckReport>`

- [ ] **Step 1: Write the failing test**

```ts
it('aggregates read-only checks into a report with a recommendation', async () => {
  const report = await runRepairSelfCheck([
    { name: 'plugin tree', run: async () => ({ ok: true, detail: 'loaded' }) },
    { name: 'core import', run: async () => ({ ok: false, detail: 'module not found' }) },
  ])
  expect(report.ok).toBe(false)
  expect(report.checks[0]).toEqual({ name: 'plugin tree', passed: true, detail: 'loaded' })
  expect(report.recommendation).toContain('请尝试其他方案')
})
it('produces an ok report and restart prompt on full pass', async () => {
  const report = await runRepairSelfCheck([
    { name: 'core import', run: async () => ({ ok: true, detail: 'ok' }) },
  ])
  expect(report.ok).toBe(true)
  expect(report.recommendation).toContain('重新启动')
})
```

- [ ] **Step 2: Run test to verify it fails** — `cd dsh-plugin-desktop && corepack yarn vitest run tests/repair-self-check.spec.ts`（FAIL）

- [ ] **Step 3: Write minimal implementation**

```ts
// src/repair-self-check.ts
export interface RepairSelfCheckItem {
  readonly name: string
  readonly run: () => Promise<{ readonly ok: boolean; readonly detail: string }>
}
export interface RepairSelfCheckReport {
  readonly ok: boolean
  readonly checks: readonly { readonly name: string; readonly passed: boolean; readonly detail: string }[]
  readonly recommendation: string
}

export async function runRepairSelfCheck(
  items: readonly RepairSelfCheckItem[],
): Promise<RepairSelfCheckReport> {
  const checks = await Promise.all(items.map(async item => {
    const result = await item.run()
    return { name: item.name, passed: result.ok, detail: result.detail }
  }))
  const ok = checks.every(check => check.passed)
  return {
    ok,
    checks,
    recommendation: ok
      ? '✅ 修复成功，点击【重新启动 DSH Desktop】生效。'
      : '❌ 修复失败，请尝试其他修复方案。',
  }
}
```

- [ ] **Step 4: Run test to verify it passes** — `cd dsh-plugin-desktop && corepack yarn vitest run tests/repair-self-check.spec.ts`（PASS）

- [ ] **Step 5: Commit**

```bash
git add src/repair-self-check.ts tests/repair-self-check.spec.ts
git commit -m "feat(desktop): add post-repair read-only self-check reporter"
```

### Task 3.3: 修复方案注册表（A–D + apply）

**Files:**
- Create: `dsh-plugin-desktop/src/repair-plans.ts`
- Test: `dsh-plugin-desktop/tests/repair-plans.spec.ts`

**Interfaces:**
- Consumes: `DesktopStartupRecoveryRepairPlanId`、`writeDegradedBundles`、`createDesktopProfileCheckpoint`。
- Produces:
  - `export interface DesktopRepairPlan { readonly id; readonly title; readonly description; readonly risk: { severity; notes }; readonly audience; readonly apply: () => Promise<DesktopRepairOutcome> }`
  - `export function repairPlans(deps: RepairPlanDependencies): ReadonlyArray<DesktopRepairPlan>`

- [ ] **Step 1: Write the failing test**

```ts
it('registers four plans with risk and audience', () => {
  const plans = repairPlans({ degradedStatePath: '/x', restoreLatest: async () => ({
    status: 'restored', changedFiles: [], snapshotDirectory: '/s', failureGeneration: 'g' }) })
  expect(plans.map(p => p.id)).toEqual(['A', 'B', 'C', 'D'])
  expect(plans[0].risk.severity).toBe('low')
  expect(plans[1].audience).toBe('developer')
})
```

- [ ] **Step 2: Run test to verify it fails** — FAIL。

- [ ] **Step 3: Write minimal implementation**

```ts
// src/repair-plans.ts
import type { DesktopStartupRecoveryRepairPlanId } from './startup-recovery-controller.ts'
import type { RestoreResult } from './profile-checkpoint.ts'
import { writeDegradedBundles } from './degraded-mode.ts'

export interface DesktopRepairOutcome {
  readonly status: string
  readonly message: string
}
export interface RepairPlanDependencies {
  readonly degradedStatePath: string
  readonly restoreLatest: () => Promise<RestoreResult>
}
export interface DesktopRepairPlan {
  readonly id: DesktopStartupRecoveryRepairPlanId
  readonly title: string
  readonly description: string
  readonly risk: { readonly severity: 'low' | 'medium' | 'high'; readonly notes: string }
  readonly audience: 'end-user' | 'developer' | 'both'
  readonly apply: () => Promise<DesktopRepairOutcome>
}

export function repairPlans(deps: RepairPlanDependencies): ReadonlyArray<DesktopRepairPlan> {
  return [
    { id: 'A', title: '临时禁用故障插件',
      description: '把故障插件加入降级集合，重启后跳过它进入主页面。',
      risk: { severity: 'low', notes: '仅该插件不再加载，基础聊天/WebUI 可用。' },
      audience: 'both',
      apply: async () => {
        writeDegradedBundles(deps.degradedStatePath, [])
        return { status: 'degraded', message: '已启用降级模式。请重新启动 Desktop。' }
      } },
    { id: 'B', title: '回滚子模块版本',
      description: '把上游子模块 pin 回退到上一有效 commit。',
      risk: { severity: 'high', notes: '违反"不编辑子模块"纪律，需显式告警。' },
      audience: 'developer',
      apply: async () => ({ status: 'acknowledged', message: '方案 B 需开发者二次确认，暂不自动执行。' }) },
    { id: 'C', title: '重置插件加载清单',
      description: '把 profile bundle 组合改写为默认/上次健康集。',
      risk: { severity: 'medium', notes: '可能丢失自定义插件组合。' },
      audience: 'both',
      apply: async () => ({ status: 'acknowledged', message: '方案 C 需默认健康集，暂不自动执行。' }) },
    { id: 'D', title: '恢复默认配置',
      description: '恢复上次健康配置快照。',
      risk: { severity: 'low', notes: '恢复上次健康快照。' },
      audience: 'both',
      apply: async () => {
        const result = await deps.restoreLatest()
        return { status: result.status, message: `已恢复上次健康快照（${result.changedFiles.join(', ')}）。` }
      } },
  ]
}
```
（`A.apply` 这里的写 `[]` 是降级兜底——实际由控制器把 `executeRepair('A')` 先 `commitDegraded([target])` 再调用 apply；二者协作，避免重复写。控制器侧保留 Task 2.3 的分发逻辑。）

- [ ] **Step 4: Run test to verify it passes** — PASS。

- [ ] **Step 5: Commit**

```bash
git add src/repair-plans.ts tests/repair-plans.spec.ts
git commit -m "feat(desktop): add typed repair plan registry with risk and apply"
```

### Task 3.4: 控制器 runAiAnalysis + 窗口 ai-analyze 与渲染

**Files:**
- Modify: `dsh-plugin-desktop/src/startup-recovery-controller.ts`
- Modify: `dsh-plugin-desktop/src/startup-recovery-window.ts`
- Test: `dsh-plugin-desktop/tests/startup-recovery-window.spec.ts`、`tests/startup-recovery-controller.spec.ts`

**Interfaces:**
- Consumes: `analyzeDiagnostics`（Task 3.1）、`runRepairSelfCheck`（Task 3.2）、`repairPlans`（Task 3.3）。
- Produces:
  - `async runAiAnalysis(): Promise<DesktopStartupRecoveryAiAnalysis>`（Tier0 + 可选 Tier1）
  - 窗口动作 `ai-analyze`（single-flight，带进度），渲染根因 / 风险 badge / 方案区缓存 / 自检报告。

- [ ] **Step 1: 控制器加 runAiAnalysis**

```ts
async runAiAnalysis(): Promise<DesktopStartupRecoveryAiAnalysis> {
  this.assertCurrentGeneration()
  const input = this.lastFailureStack()   // 来自构造时的 failureStack
  const diagnosis = analyzeDiagnostics(input)
  return { diagnosis }
}
```
控制器构造选项新增 `failureStack?: string`。

- [ ] **Step 2: 窗口动作 + 状态 + 渲染**

在 `DesktopStartupRecoveryAiAnalysis` 增加 `diagnosis?: AiDiagnosis`、`selfCheck?: RepairSelfCheckReport`；加 `ai-analyze` 动作处理（single-flight）：调 `requireController().runAiAnalysis()`，渲染 `aiAnalysisHtml` 输出 `rootCause`、`severity` badge、`options`（复用 `REPAIR_PLAN_OPTIONS`）、`disclaimer`、`selfCheck` 明细。给恢复卡新增"加载本地诊断包 / 自动读取已生成包"两个按钮，指向 `dsh-recovery://ai-analyze`。`MAX_FAILURE_DETAIL_LENGTH` 从 `4_000` 上调到 `16_000` 以容纳堆栈。

- [ ] **Step 3: 新增单测**

```ts
// window 渲染测试
it('renders the analyzed root cause, risk badge, and self-check report', () => {
  const html = renderDesktopStartupRecoveryHtml(viewModel({
    aiAnalysis: {
      selectedOption: 'A',
      diagnosis: {
        rootCause: '依赖解析失败：缺失模块 plugin-x。', severity: 'medium',
        options: [], recommendation: '建议先尝试方案 A。', disclaimer: 'AI 辅助建议，仅供参考。',
      },
      selfCheck: { ok: true, checks: [{ name: 'core import', passed: true, detail: 'ok' }],
        recommendation: '✅ 修复成功，点击【重新启动 DSH Desktop】生效。' },
    },
  }))
  expect(html).toContain('缺失模块 plugin-x')
  expect(html).toContain('medium')
  expect(html).toContain('重新启动 DSH Desktop')
})
```

- [ ] **Step 4: 运行相关测试 & typecheck & commit**

Run: `cd dsh-plugin-desktop && corepack yarn vitest run tests/startup-recovery-window.spec.ts tests/startup-recovery-controller.spec.ts && cd .. && corepack yarn typecheck`

```bash
git add src/startup-recovery-controller.ts src/startup-recovery-window.ts tests/startup-recovery-window.spec.ts
git commit -m "feat(desktop): run Ai analysis from the recovery window and render risk + self-check"
```

### Task 3.5: Tier 1 本地 DSH 推理（静默降级）

**Files:**
- Create: `dsh-plugin-desktop/src/ai-diagnostic-analyzer.ts`
- Test: `dsh-plugin-desktop/tests/ai-diagnostic-analyzer.spec.ts`

**Interfaces:**
- Consumes: `analyzeDiagnostics`（Task 3.1）。
- Produces: `async runTierOneAnalysis(input: string): Promise<AiDiagnosis | undefined>`（失败或不可用返回 `undefined`，调用方降级 Tier0）。

- [ ] **Step 1: 实现（只读、不加载桌面插件树）**

```ts
// src/ai-diagnostic-analyzer.ts
import { spawn } from 'node:child_process'
import { packagedDependencyPath } from './packaged-runtime-path.ts'
import { analyzeDiagnostics, type AiDiagnosis } from './diagnostic-analyzer.ts'

export async function runTierOneAnalysis(input: string): Promise<AiDiagnosis | undefined> {
  try {
    const dshCli = packagedDependencyPath(import.meta.url, '@deepseek-ai/dsh/lib/bin.js')
    const text = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [dshCli, '--recovery-analyze', '--stdin'], {
        stdio: ['pipe', 'pipe', 'ignore'],
      })
      let out = ''
      child.stdout.on('data', chunk => { out += String(chunk) })
      child.on('error', reject)
      child.on('exit', code => code === 0 ? resolve(out) : reject(new Error(`dsh exit ${code}`)))
      child.stdin.end(JSON.stringify({ input }))
    })
    const parsed = JSON.parse(text) as AiDiagnosis
    if (parsed?.options === undefined) return undefined
    return parsed
  } catch {
    return undefined   // 静默降级：绝不阻塞恢复页
  }
}
```

- [ ] **Step 2: 单测（注入失败时降级）**

```ts
it('degrades to undefined when the CLI is unavailable', async () => {
  vi.spyOn(require('node:child_process'), 'spawn').mockImplementation(() => {
    throw new Error('no dsh')
  })
  await expect(runTierOneAnalysis('Error: Cannot find module \'x\'')).resolves.toBeUndefined()
})
```

- [ ] **Step 3: 接线到 runAiAnalysis**

在 `runAiAnalysis` 中：`const tier1 = await runTierOneAnalysis(input); const diagnosis = tier1 ?? analyzeDiagnostics(input)`。

- [ ] **Step 4: Run test & commit**

Run: `cd dsh-plugin-desktop && corepack yarn vitest run tests/ai-diagnostic-analyzer.spec.ts tests/diagnostic-analyzer.spec.ts`

```bash
git add src/ai-diagnostic-analyzer.ts tests/ai-diagnostic-analyzer.spec.ts src/startup-recovery-controller.ts
git commit -m "feat(desktop): add silent-degrade local DSH inference path for Ai diagnosis"
```

### Task 3.6: 修复后自检接入 + 重启生效闭环

**Files:**
- Modify: `dsh-plugin-desktop/src/startup-recovery-controller.ts`、`startup-recovery-window.ts`
- Test: `tests/startup-recovery-controller.spec.ts`

**Interfaces:**
- Consumes: `runRepairSelfCheck`（Task 3.2）、`repairPlans`（Task 3.3）、`installProfilePackageResolver`。
- Produces: `executeRepair` 执行后跑自检，返回结果含 `selfCheck?: RepairSelfCheckReport`；窗口在自检通过后显示"重新启动 DSH Desktop"（`restartReady = true`），失败则回退 radio 保留历史。

- [ ] **Step 1: 实现**

```ts
// 控制器：executeRepair 执行 plan.apply() 后
const outcome = await plan.apply()
const selfCheck = await this.runSelfCheck()   // 用注入的检测项：目标 bundle 可解析 / 核心模块可导入
return { planId, status: outcome.status as DesktopStartupRecoveryRepairResult['status'],
  message: outcome.message, selfCheck }
```
自检检测项由控制器构造注入（默认 `installProfilePackageResolver(profileBaseUrl)` + `import.meta.resolve` / `createRequire` 探测，失败即 `{ ok:false, detail: err.message }`），保持只读探测、不污染代际。

- [ ] **Step 2: 窗口渲染**

在 `aiAnalysisHtml` 中，当 `selfCheck?.ok === true` 时追加 `restartReady` 文案与 `<a class="button primary" href="dsh-recovery://restart">重新启动 DSH Desktop</a>`；否则显示 `recommendation`（"请尝试其他方案"）。

- [ ] **Step 3: 单测**

```ts
it('surfaces a restart CTA after a passing self-check', () => {
  const html = renderDesktopStartupRecoveryHtml(viewModel({
    restartReady: true,
    aiAnalysis: { result: { planId: 'A', status: 'degraded', message: '已启用降级。' } },
  }))
  expect(html).toContain('dsh-recovery://restart')
  expect(html).toContain('重新启动 DSH Desktop')
})
```

- [ ] **Step 4: Run test & typecheck & commit**

Run: `cd dsh-plugin-desktop && corepack yarn vitest run tests/startup-recovery-window.spec.ts tests/startup-recovery-controller.spec.ts tests/repair-self-check.spec.ts && cd .. && corepack yarn typecheck`

```bash
git add src/startup-recovery-controller.ts src/startup-recovery-window.ts tests/startup-recovery-window.spec.ts
git commit -m "feat(desktop): run read-only self-check after repair and surface restart CTA"
```

---

## Final Gate

对每个改动文件跑 `cd .. && corepack yarn typecheck && cd .. && corepack yarn test`，最后整仓库 `corepack yarn check`。断言语义（spec doc 第 6 节）：

1. AI 只分析建议，绝不未经用户确认修改配置 —— `runAiAnalysis` 只读。
2. 降级模式明确横幅提示，可一键退出降级。
3. 全部旧功能保留。

## Self-Review

- **Spec coverage:** 规格 6 节均已映射 —— 降级策略→Phase 2；诊断包增强→Phase 1；AI 链路→Phase 3 Task 3.1/3.5/3.6；UI 交互→Task 2.4/3.4/3.6；修复方案与自检→Task 3.3/3.6；风险点 1/2/3/4/6→Global Constraints + Task 2.2/2.4/3.5。
- **Type consistency:** `DesktopStartupRecoveryRepairPlanId`（controller）、`repair-plans.DesktopRepairPlan.id`、`REPAIR_PLAN_OPTIONS[].id` 统一为 A–D；`AiDiagnosis`/`AiRepairOption` 在 analyzer/controller/window 共用；`RepairSelfCheckReport` 在 self-check/controller/window 共用。
- **Scope:** B/C 方案明确声明为能力边界（需开发者专属 + 二次确认 / 默认健康集），不是占位符；跨 `git submodule` 约束遵守。
