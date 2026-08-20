# 通用设置「关闭窗口时」下拉行 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 DSH Desktop 的通用设置（General section）里加一行「关闭窗口时」下拉，选择「最小化到托盘」或「退出」，读写现有 `closeBehavior` 设置。

**Architecture:** 纯客户端改动（`dsh-plugin-desktop/src/client/`）。照搬上游 Language 行（`deepseek-harness/packages/client/locale/src/client/`）的 `settings.general.item` 槽模式：`ctx.settingsScope.bind(DESKTOP_SETTINGS_NAMESPACE)` 读、`host.set('closeBehavior', v)` 写、`ctx.slots.register` 注册行组件。host 侧关闭决策、托盘降级、`applies: 'live'` 均不动；上游 submodule 零改动。命名空间常量收敛到 host/client 共用的 `src/settings-namespaces.ts`。

**Tech Stack:** Cordis 客户端插件、React（行组件）、`@deepseek-ai/dsh-client-ui-slots`（槽注册/`useStore`/`PropsLocale`）、`@deepseek-ai/dsh-client-ui-settings`（`settingsScope`）、`@deepseek-ai/dsh-client-runtime`（`defineStore`/`EngineStoreHandle`）、vitest（node 环境，headless-safe）。

---

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `dsh-plugin-desktop/src/settings-namespaces.ts` | `DESKTOP_SETTINGS_NAMESPACE` 单一来源（host+client 共用） | 新建 |
| `dsh-plugin-desktop/src/index.ts` | host 入口：改为从共享模块 re-export 该常量 | 修改（第 40 行） |
| `dsh-plugin-desktop/src/client/close-behavior-locale.ts` | zh/en 行文案字典 + `LocaleNamespaceMap` 类型合并 | 新建 |
| `dsh-plugin-desktop/src/client/close-behavior-settings-store.ts` | 行 store（value + revision，`defineStore`） | 新建 |
| `dsh-plugin-desktop/src/client/CloseBehaviorRow.tsx` | 行组件：标题 + `Menu` 下拉 | 新建 |
| `dsh-plugin-desktop/src/client/CloseBehaviorRow.module.css` | 行样式（镜像 LanguageRow） | 新建 |
| `dsh-plugin-desktop/src/client/close-behavior-settings.ts` | 注册逻辑 `registerCloseBehaviorRow(ctx)`（可独立单测） | 新建 |
| `dsh-plugin-desktop/src/client/index.ts` | 桌面客户端 apply：inject 增加 `locale`/`settingsScope`，调用注册 | 修改 |
| `dsh-plugin-desktop/tests/client-close-behavior-settings-store.spec.ts` | store 单测 | 新建 |
| `dsh-plugin-desktop/tests/client-close-behavior-settings.spec.ts` | 注册逻辑单测（fake ctx） | 新建 |

---

### Task 1: 共享 `DESKTOP_SETTINGS_NAMESPACE` 模块 + host 改引

**Files:**
- Create: `dsh-plugin-desktop/src/settings-namespaces.ts`
- Modify: `dsh-plugin-desktop/src/index.ts:40`

- [ ] **Step 1: 新建共享模块**

创建 `dsh-plugin-desktop/src/settings-namespaces.ts`：

```ts
/** Desktop-owned settings namespace shared by the host and client faces. */

import { settingsNamespace } from '@deepseek-ai/dsh-settings'

/** Namespace holding desktop shell preferences (mode, port, logLevel, closeBehavior). */
export const DESKTOP_SETTINGS_NAMESPACE = settingsNamespace('dsh-desktop')
```

- [ ] **Step 2: 修改 host 入口改为 re-export**

在 `dsh-plugin-desktop/src/index.ts` 中，把第 40 行的：

```ts
export const DESKTOP_SETTINGS_NAMESPACE = settingsNamespace('dsh-desktop')
```

替换为：

```ts
export { DESKTOP_SETTINGS_NAMESPACE } from './settings-namespaces.ts'
```

`settingsNamespace` 的 import 保留（第 42-43 行 `UI_THEME_SETTINGS_NAMESPACE` / `UI_LOCALE_SETTINGS_NAMESPACE` 仍用它）。**行为不变**（同一字符串值），只是收敛单一来源。

- [ ] **Step 3: 门禁确认**

Run: `corepack yarn workspace dsh-plugin-desktop typecheck`
Expected: PASS（无类型错误，4 个生成类型文件 current）

- [ ] **Step 4: 提交**

```bash
git add dsh-plugin-desktop/src/settings-namespaces.ts dsh-plugin-desktop/src/index.ts
git commit -m "refactor(desktop): share the dsh-desktop settings namespace across host and client"
```

---

### Task 2: 行文案字典 + 类型合并

**Files:**
- Create: `dsh-plugin-desktop/src/client/close-behavior-locale.ts`

- [ ] **Step 1: 新建文案模块**

创建 `dsh-plugin-desktop/src/client/close-behavior-locale.ts`：

```ts
/** Close-behavior settings row copy (zh/en), plus the slot locale merge. */

import type {} from '@deepseek-ai/dsh-client-ui-slots'

/** Row copy keys registered into the `settings.desktop` locale namespace. */
export type CloseBehaviorLocaleKey =
  | 'closeBehavior.title'
  | 'closeBehavior.tray'
  | 'closeBehavior.quit'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Desktop close-behavior row copy. */
    'settings.desktop': CloseBehaviorLocaleKey
  }
}

/** zh dictionary. */
export const zh: Record<CloseBehaviorLocaleKey, string> = {
  'closeBehavior.title': '关闭窗口时',
  'closeBehavior.tray': '最小化到托盘',
  'closeBehavior.quit': '退出',
}

/** en dictionary. */
export const en: Record<CloseBehaviorLocaleKey, string> = {
  'closeBehavior.title': 'On window close',
  'closeBehavior.tray': 'Minimize to tray',
  'closeBehavior.quit': 'Quit',
}
```

- [ ] **Step 2: 提交**

```bash
git add dsh-plugin-desktop/src/client/close-behavior-locale.ts
git commit -m "feat(desktop): add close-behavior row locale dictionaries"
```

---

### Task 3: 行 store（TDD）

**Files:**
- Create: `dsh-plugin-desktop/src/client/close-behavior-settings-store.ts`
- Test: `dsh-plugin-desktop/tests/client-close-behavior-settings-store.spec.ts`

- [ ] **Step 1: 先写失败的 store 测试**

创建 `dsh-plugin-desktop/tests/client-close-behavior-settings-store.spec.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { createCloseBehaviorRowStore } from '../src/client/close-behavior-settings-store.ts'

describe('desktop close-behavior row store', () => {
  it('starts on the tray default with an unsynced revision', () => {
    const instance = createCloseBehaviorRowStore().create()
    expect(instance.getSnapshot()).toEqual({ value: 'tray', revision: -1 })
  })

  it('adopts newer revisions and ignores stale ones', () => {
    const instance = createCloseBehaviorRowStore().create()
    instance.actions.sync('quit', 1)
    expect(instance.getSnapshot().value).toBe('quit')
    instance.actions.sync('tray', 1)
    expect(instance.getSnapshot().value).toBe('quit')
    instance.actions.sync('tray', 2)
    expect(instance.getSnapshot().value).toBe('tray')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `corepack yarn workspace dsh-plugin-desktop vitest run tests/client-close-behavior-settings-store.spec.ts`
Expected: FAIL——找不到模块 `../src/client/close-behavior-settings-store.ts`（模块不存在）

- [ ] **Step 3: 实现 store**

创建 `dsh-plugin-desktop/src/client/close-behavior-settings-store.ts`：

```ts
/** Close-behavior row slot store: mirrors the dsh-desktop namespace value. */

import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'
import type { DesktopCloseBehavior } from '../runtime.ts'

/** Store state: the active close behavior plus a change guard. */
export interface CloseBehaviorRowState {
  /** Active close behavior; 'tray' until the Host section is adopted. */
  value: DesktopCloseBehavior
  /** Service revision; -1 until first sync so revision 0 lands as a change. */
  revision: number
}

/** Declared action shape giving the exported factory a stable return type. */
type CloseBehaviorRowActions = {
  sync: (draft: CloseBehaviorRowState, value: DesktopCloseBehavior, revision: number) => void
}

/**
 * Declares the close-behavior row state and write surface.
 * @returns the store handle.
 */
export function createCloseBehaviorRowStore(): EngineStoreHandle<CloseBehaviorRowState, CloseBehaviorRowActions> {
  return defineStore({
    init: (): CloseBehaviorRowState => ({ value: 'tray', revision: -1 }),
    actions: {
      sync: (d, value, revision) => {
        if (revision <= d.revision) return
        d.value = value
        d.revision = revision
      },
    },
  })
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `corepack yarn workspace dsh-plugin-desktop vitest run tests/client-close-behavior-settings-store.spec.ts`
Expected: PASS（2 tests）

- [ ] **Step 5: 提交**

```bash
git add dsh-plugin-desktop/src/client/close-behavior-settings-store.ts dsh-plugin-desktop/tests/client-close-behavior-settings-store.spec.ts
git commit -m "feat(desktop): add close-behavior row store"
```

---

### Task 4: 行组件 + 样式

**Files:**
- Create: `dsh-plugin-desktop/src/client/CloseBehaviorRow.tsx`
- Create: `dsh-plugin-desktop/src/client/CloseBehaviorRow.module.css`

- [ ] **Step 1: 新建行组件**

创建 `dsh-plugin-desktop/src/client/CloseBehaviorRow.tsx`：

```tsx
/**
 * Close-behavior preference row registered into the General section item slot:
 * title plus a selector menu choosing minimize-to-tray or quit on window close.
 */
import { useState } from 'react'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import { IconChevronDownOutline14, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { DesktopCloseBehavior } from '../runtime.ts'
import type { createCloseBehaviorRowStore } from './close-behavior-settings-store.ts'
import css from './CloseBehaviorRow.module.css'

/** Injected business face: the preference write (t rides the standard locale seat). */
export interface CloseBehaviorRowInjected {
  /** Persist the selected close behavior to the dsh-desktop scope. */
  setCloseBehavior: (value: DesktopCloseBehavior) => void
}

/** Full component props: runtime share + store share + locale seat + injected face. */
export type CloseBehaviorRowComponentProps =
  PropsRuntime<'settings.general.item'> & PropsStore<ReturnType<typeof createCloseBehaviorRowStore>>
  & PropsLocale<'settings.desktop'> & CloseBehaviorRowInjected

/** The two selectable close behaviors in display order. */
const OPTIONS: DesktopCloseBehavior[] = ['tray', 'quit']

/**
 * Render the close-behavior row.
 * @param props - composed slot props.
 * @returns the row element tree.
 */
export function CloseBehaviorRow({ t, setCloseBehavior, useStore }: CloseBehaviorRowComponentProps) {
  const value = useStore(s => s.value)
  const [open, setOpen] = useState(false)
  const labelOf = (id: DesktopCloseBehavior): string =>
    id === 'tray' ? t('closeBehavior.tray') : t('closeBehavior.quit')

  return (
    <div className={css.row}>
      <div className={css.rowText}>
        <div className={css.title}>{t('closeBehavior.title')}</div>
      </div>
      <Menu
        open={open}
        onClose={() => { setOpen(false) }}
        items={OPTIONS.map(id => ({ id, label: labelOf(id) }))}
        selectedId={value}
        onSelect={(id) => {
          setCloseBehavior(id as DesktopCloseBehavior)
          setOpen(false)
        }}
        align="end"
        portal
        anchor={(
          <button
            type="button"
            className={css.selector}
            aria-haspopup="menu"
            aria-expanded={open}
            onClick={() => { setOpen(v => !v) }}
          >
            {labelOf(value)}
            <IconChevronDownOutline14 className={css.chevron} />
          </button>
        )}
      />
    </div>
  )
}
```

- [ ] **Step 2: 新建样式（镜像 LanguageRow）**

创建 `dsh-plugin-desktop/src/client/CloseBehaviorRow.module.css`：

```css
/* Close-behavior row (same Setting-Cell geometry as the Language row:
   gap 8, pad 16/0, hairline separator). */

.row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 16px 0;
  border-bottom: 1px solid var(--dsw-alias-border-l2);
}

.rowText {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-right: 48px;
}

.title {
  font-size: 14px;
  font-weight: 400;
  line-height: 22px;
  color: var(--dsw-alias-label-primary);
}

.selector {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  height: 36px;
  padding: 0 14px;
  border: none;
  border-radius: 18px;
  background: var(--dsw-alias-bg-module-platform);
  font: inherit;
  font-size: 14px;
  line-height: 22px;
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
}

.selector:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}

.chevron {
  flex: none;
}
```

- [ ] **Step 3: 门禁确认（组件被 Task 5 的注册测试引用，这里只做 typecheck）**

Run: `corepack yarn workspace dsh-plugin-desktop typecheck`
Expected: PASS

- [ ] **Step 4: 提交**

```bash
git add dsh-plugin-desktop/src/client/CloseBehaviorRow.tsx dsh-plugin-desktop/src/client/CloseBehaviorRow.module.css
git commit -m "feat(desktop): add close-behavior settings row component"
```

---

### Task 5: 注册逻辑（TDD）

**Files:**
- Create: `dsh-plugin-desktop/src/client/close-behavior-settings.ts`
- Test: `dsh-plugin-desktop/tests/client-close-behavior-settings.spec.ts`

- [ ] **Step 1: 先写失败的注册测试**

创建 `dsh-plugin-desktop/tests/client-close-behavior-settings.spec.ts`：

```ts
import { describe, expect, it, vi } from 'vitest'
import type { DesktopCloseBehavior } from '../src/runtime.ts'
import {
  CLOSE_BEHAVIOR_SETTINGS_NS,
  registerCloseBehaviorRow,
} from '../src/client/close-behavior-settings.ts'
import { CloseBehaviorRow } from '../src/client/CloseBehaviorRow.tsx'
import { createCloseBehaviorRowStore } from '../src/client/close-behavior-settings-store.ts'
import { en, zh } from '../src/client/close-behavior-locale.ts'

type RegisterOptions = {
  name: string
  id: string
  order: number
  locale: string
  store: unknown
  inject: (actions: ReturnType<ReturnType<typeof createCloseBehaviorRowStore>['create']>['actions'])
    => { setCloseBehavior: (value: DesktopCloseBehavior) => void }
}

describe('desktop close-behavior settings row', () => {
  it('registers the row, projects the host value, and routes writes back', () => {
    let section: { closeBehavior: DesktopCloseBehavior } | undefined = { closeBehavior: 'quit' }
    let revision = 3
    const host = {
      getSnapshot: () => ({ value: section, revision }),
      subscribe: vi.fn(),
      set: vi.fn(async (_field: string, value: unknown) => {
        section = { closeBehavior: value as DesktopCloseBehavior }
        revision += 1
      }),
    }
    const locale = { register: vi.fn() }
    let registered: { options: RegisterOptions; component: unknown } | undefined
    let declaration: (() => void) | undefined
    const slots = {
      inject: vi.fn((_name: string, fn: () => void) => { declaration = fn }),
      register: vi.fn((options: RegisterOptions, component: unknown) => {
        registered = { options, component }
      }),
    }
    const ctx = {
      settingsScope: { bind: vi.fn(() => host) },
      locale,
      slots,
      effect: vi.fn((cb: () => void) => cb()),
    }

    registerCloseBehaviorRow(ctx as never)

    expect(ctx.settingsScope.bind).toHaveBeenCalledWith({ namespace: expect.any(String) })
    expect(locale.register).toHaveBeenCalledWith(CLOSE_BEHAVIOR_SETTINGS_NS, { zh, en })
    expect(host.subscribe).toHaveBeenCalledTimes(1)
    declaration?.()
    expect(registered?.component).toBe(CloseBehaviorRow)
    expect(registered?.options).toMatchObject({
      name: 'settings.general.item',
      id: 'close-behavior',
      order: 10,
      locale: CLOSE_BEHAVIOR_SETTINGS_NS,
    })

    const instance = createCloseBehaviorRowStore().create()
    const face = registered!.options.inject(instance.actions)
    expect(instance.getSnapshot().value).toBe('quit')
    face.setCloseBehavior('tray')
    expect(host.set).toHaveBeenCalledWith('closeBehavior', 'tray')
    expect(instance.getSnapshot().value).toBe('quit') // store mirrors Host, not the optimistic write
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `corepack yarn workspace dsh-plugin-desktop vitest run tests/client-close-behavior-settings.spec.ts`
Expected: FAIL——找不到模块 `../src/client/close-behavior-settings.ts`

- [ ] **Step 3: 实现注册模块**

创建 `dsh-plugin-desktop/src/client/close-behavior-settings.ts`：

```ts
/**
 * Close-behavior settings row: registers the preference into the General
 * section item slot and binds reads/writes to the dsh-desktop namespace scope.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { DESKTOP_SETTINGS_NAMESPACE } from '../settings-namespaces.ts'
import type { DesktopCloseBehavior } from '../runtime.ts'
import type { createCloseBehaviorRowStore } from './close-behavior-settings-store.ts'
import { CloseBehaviorRow, type CloseBehaviorRowInjected } from './CloseBehaviorRow.tsx'
import { en, zh } from './close-behavior-locale.ts'

/** Locale namespace owning the row copy. */
export const CLOSE_BEHAVIOR_SETTINGS_NS = 'settings.desktop'

/** Narrow desktop section read by the row. */
interface DesktopSettingsSection {
  closeBehavior: DesktopCloseBehavior
}

/**
 * Register the close-behavior row into the General settings section.
 * @param ctx - desktop client context (injects slots, locale, settingsScope).
 */
export function registerCloseBehaviorRow(ctx: ClientContext): void {
  const host = ctx.settingsScope.bind<DesktopSettingsSection>({ namespace: DESKTOP_SETTINGS_NAMESPACE })
  ctx.locale.register(CLOSE_BEHAVIOR_SETTINGS_NS, { zh, en })

  const store = createCloseBehaviorRowStore()
  let bound: BoundActions<typeof store> | undefined
  const sync = (): void => {
    const snapshot = host.getSnapshot()
    const section = snapshot.value
    if (section === undefined || snapshot.revision === undefined) return
    bound?.sync(section.closeBehavior, snapshot.revision)
  }
  ctx.effect(() => host.subscribe(sync), 'dsh-plugin-desktop: close-behavior settings scope adoption')
  const injected = (actions: BoundActions<typeof store>): CloseBehaviorRowInjected => {
    bound = actions
    sync()
    return { setCloseBehavior: value => { void host.set('closeBehavior', value) } }
  }
  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'close-behavior',
    order: 10,
    store,
    locale: CLOSE_BEHAVIOR_SETTINGS_NS,
    inject: injected,
  }, CloseBehaviorRow))
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `corepack yarn workspace dsh-plugin-desktop vitest run tests/client-close-behavior-settings.spec.ts tests/client-close-behavior-settings-store.spec.ts`
Expected: PASS（2 files，3 tests）

- [ ] **Step 5: 提交**

```bash
git add dsh-plugin-desktop/src/client/close-behavior-settings.ts dsh-plugin-desktop/tests/client-close-behavior-settings.spec.ts
git commit -m "feat(desktop): register close-behavior row into the General settings section"
```

---

### Task 6: 接入桌面客户端 apply

**Files:**
- Modify: `dsh-plugin-desktop/src/client/index.ts`

- [ ] **Step 1: inject 增加 locale / settingsScope**

在 `dsh-plugin-desktop/src/client/index.ts` 中，把 inject 数组：

```ts
export const inject = [
  'slots',
  'sessions',
  'theme',
  'workspaces',
]
```

改为：

```ts
export const inject = [
  'slots',
  'sessions',
  'theme',
  'workspaces',
  'locale',
  'settingsScope',
]
```

- [ ] **Step 2: import 注册函数**

在 `dsh-plugin-desktop/src/client/index.ts` 的 import 区（`./advanced-shell.ts` 附近）加：

```ts
import { registerCloseBehaviorRow } from './close-behavior-settings.ts'
```

- [ ] **Step 3: apply 中调用注册**

在 `apply()` 里，`if (environment.platform === 'win32') { ... }` 块之后、`if (environment.mode === 'advanced') applyAdvancedShell(ctx, environment)` 之前，加一行：

```ts
  registerCloseBehaviorRow(ctx)
```

- [ ] **Step 4: 门禁确认**

Run: `corepack yarn workspace dsh-plugin-desktop typecheck && corepack yarn workspace dsh-plugin-desktop test`
Expected: PASS——typecheck 无错误，全部单测通过（含新增 2 个 spec）

- [ ] **Step 5: 提交**

```bash
git add dsh-plugin-desktop/src/client/index.ts
git commit -m "feat(desktop): wire close-behavior row into the client apply"
```

---

### Task 7: 完整门禁

**Files:** 无新增

- [ ] **Step 1: 跑完整 headless 门禁**

Run: `corepack yarn check`
Expected: PASS——build / typecheck / test / verify:closure / verify:cli / verify:loader / verify:profile / verify:licenses 全部通过。若 `verify:closure` 或 lint 对新增客户端文件报错，按报错修复（多为未使用 import / 类型收窄）。

- [ ] **Step 2: 提交（若 Step 1 产生修复）**

```bash
git add -A dsh-plugin-desktop/src dsh-plugin-desktop/tests
git commit -m "chore(desktop): satisfy gates for close-behavior row"
```

---

### Task 8: 打包并实测

**Files:** 无

- [ ] **Step 1: 打测试 deb**

Run: `corepack yarn workspace dsh-plugin-desktop dist:linux`
Expected: 产出 `dsh-plugin-desktop/dist/linux/DSH-Desktop-2.0.1-amd64.deb` 且 `Linux package verification passed`。

- [ ] **Step 2: 运行 unpacked 应用，肉眼验证**

Run: `dsh-plugin-desktop/dist/linux/linux-unpacked/dsh-desktop`（或安装 deb 后从应用菜单启动）
Expected:
1. 打开「通用设置」，General 部分出现「关闭窗口时」行，下拉显示当前值（默认 `tray` 或既有配置）。
2. 切到「退出」→ 关闭窗口后进程退出；切回「最小化到托盘」→ 关闭窗口后应用隐藏到托盘，托盘图标可点开。
3. `~/.dsh/settings.yaml` 的 `dsh-desktop.closeBehavior` 随下拉选择变化。
4. 中文/英文界面文案均正确。

- [ ] **Step 3: 若注入失败（`locale`/`settingsScope` 未提供）**

若应用启动时报 inject 解析错误，说明桌面 composition 缺这两个服务：检查桌面 cordis 组合是否包含上游 `@deepseek-ai/dsh-client-locale` 与 `@deepseek-ai/dsh-client-ui-settings`，在桌面 profile 补上后重测。

---

## Self-Review

**Spec 覆盖**（对照 `docs/superpowers/specs/2026-08-20-close-behavior-settings-ui-design.md`）：
- 设置项复用 `closeBehavior`、无 schema/host 改动 → Task 1-6 仅客户端 + 共享常量 refactor ✓
- `settings.general.item` 行、`order: 10`、`id: 'close-behavior'` → Task 5 ✓
- 读写 `settingsScope.bind(DESKTOP_SETTINGS_NAMESPACE)` / `host.set('closeBehavior', v)` → Task 5 ✓
- zh/en 文案「关闭窗口时 / 最小化到托盘 / 退出」→ Task 2 ✓
- 测试：store + 注册逻辑、node 环境、headless-safe → Task 3/5 ✓
- 命名空间常量可达性（host 与 client 共用）→ Task 1 ✓
- 文案命名空间类型合并 → Task 2 ✓
- 非目标：不做行内托盘提示、不建独立页、不改上游 → 全计划未触及 ✓

**Placeholder 扫描**：无 TBD/TODO；每个代码步骤都含完整代码。

**类型一致性**：`DesktopCloseBehavior`（runtime.ts:18，`'tray'|'quit'`）在 store/组件/注册模块/测试中统一；`CLOSE_BEHAVIOR_SETTINGS_NS = 'settings.desktop'` 在 Task 2 合并、Task 5 使用、测试断言统一；`createCloseBehaviorRowStore` 返回 `EngineStoreHandle<CloseBehaviorRowState, CloseBehaviorRowActions>`，注入面 `BoundActions<typeof store>` 与测试的 actions 类型一致。
