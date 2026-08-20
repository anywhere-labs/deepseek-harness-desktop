# DSH Desktop Linux 托盘关闭行为实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让桌面端的关闭按钮行为可配置（最小化到托盘 / 真正退出），并修复 Linux 托盘可靠性——deb 声明 appindicator 依赖、启动时探测托盘可用性、托盘不可用时关闭操作降级为退出且不出现"应用消失"。

**Architecture:** 在 `dsh-plugin-desktop` 插件内完成。新增两个纯逻辑模块（`close-behavior.ts` 关闭决策、`tray-availability.ts` Linux SNI 探测），通过 `DesktopShellSpec` 新增 `readCloseBehavior()` 回调把 `DesktopSettings` 里的 `closeBehavior` 字段透传到 `ElectronShellGeneration` 的 close 处理器。托盘可用性由 shell 挂载时探测，关闭决策用纯函数矩阵 + 降级通知。

**Tech Stack:** TypeScript、Electron 43、Cordis 插件、schemastery 设置 schema、electron-builder（deb）、vitest。

规格：`docs/superpowers/specs/2026-08-20-tray-close-behavior-design.md`

---

## 文件结构

**新增：**
- `dsh-plugin-desktop/src/close-behavior.ts` — 纯函数 `resolveCloseAction()`，关闭事件决策（allow/hide/quit），无 Electron 依赖。
- `dsh-plugin-desktop/src/tray-availability.ts` — Linux 会话总线 SNI watcher 探测 + 平台可用性判定，可注入探测函数。
- `dsh-plugin-desktop/tests/close-behavior.spec.ts` — 决策矩阵单测。
- `dsh-plugin-desktop/tests/tray-availability.spec.ts` — 探测与可用性单测。
- `dsh-plugin-desktop/tests/settings-schema.spec.ts` — 设置 schema 默认值单测。

**修改：**
- `dsh-plugin-desktop/src/runtime.ts` — 新增 `DesktopCloseBehavior` 类型；`DesktopShellSpec` 增加 `readCloseBehavior()`。
- `dsh-plugin-desktop/src/index.ts` — `DesktopSettingsSchema` 增加 `closeBehavior` 字段；注册 `applies` 改 `'live'`；`schedule()` 提供 `readCloseBehavior`。
- `dsh-plugin-desktop/src/electron-runtime.ts` — `mountScheduled()` 透传新回调；新增 `notifyTrayUnavailable()` 一次性降级通知。
- `dsh-plugin-desktop/src/electron-shell-generation.ts` — `trayAvailable` 状态、挂载时探测、close 处理器三分支。
- `dsh-plugin-desktop/package.json` — `build.linux.depends` 增加 `libayatana-appindicator3-1`。
- `dsh-plugin-desktop/tests/plugin.spec.ts` — `applies` 断言 `'restart'`→`'live'`；harness `settings.get` 增加 dsh-desktop 分支；`shell()` 断言增加 `readCloseBehavior`。
- `dsh-plugin-desktop/tests/electron-runtime.spec.ts` — `spec` mock 增加 `readCloseBehavior`/`requestQuit`；child_process mock 支持 stdout + 探测自动结算；新增 close 行为测试。
- `docs/faq.md` / `docs/faq.en.md` — 新增 Linux 托盘问答。

---

## Task 1: 关闭决策纯函数（TDD）

**Files:**
- Modify: `dsh-plugin-desktop/src/runtime.ts`（新增 `DesktopCloseBehavior` 类型）
- Create: `dsh-plugin-desktop/src/close-behavior.ts`
- Test: `dsh-plugin-desktop/tests/close-behavior.spec.ts`

- [ ] **Step 1: 在 runtime.ts 增加类型**

在 `dsh-plugin-desktop/src/runtime.ts` 顶部附近（`DesktopShellSpec` 定义之前）新增：

```ts
/** Close-button behavior selected through desktop settings. */
export type DesktopCloseBehavior = 'tray' | 'quit'
```

- [ ] **Step 2: 写失败测试**

创建 `dsh-plugin-desktop/tests/close-behavior.spec.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { resolveCloseAction } from '../src/close-behavior.ts'

describe('resolveCloseAction', () => {
  it('allows the close when the app is already quitting', () => {
    expect(resolveCloseAction({ isQuitting: true, closeBehavior: 'tray', trayAvailable: true })).toBe('allow')
    expect(resolveCloseAction({ isQuitting: true, closeBehavior: 'quit', trayAvailable: false })).toBe('allow')
  })

  it('hides to the tray for tray mode with an available tray', () => {
    expect(resolveCloseAction({ isQuitting: false, closeBehavior: 'tray', trayAvailable: true })).toBe('hide')
  })

  it('quits for explicit quit behavior regardless of tray availability', () => {
    expect(resolveCloseAction({ isQuitting: false, closeBehavior: 'quit', trayAvailable: true })).toBe('quit')
    expect(resolveCloseAction({ isQuitting: false, closeBehavior: 'quit', trayAvailable: false })).toBe('quit')
  })

  it('quits for tray mode when the tray is unavailable (degradation)', () => {
    expect(resolveCloseAction({ isQuitting: false, closeBehavior: 'tray', trayAvailable: false })).toBe('quit')
  })
})
```

- [ ] **Step 3: 运行测试确认失败**

在 `dsh-plugin-desktop/` 下运行：

```bash
corepack yarn vitest run tests/close-behavior.spec.ts
```

Expected: FAIL，报 `Cannot find module '../src/close-behavior.ts'` 或 `resolveCloseAction is not defined`。

- [ ] **Step 4: 实现最小模块**

创建 `dsh-plugin-desktop/src/close-behavior.ts`：

```ts
/** Close-button decision shared by the native window close path. */

import type { DesktopCloseBehavior } from './runtime.ts'

/** What the native close handler should do with one window close event. */
export type DesktopCloseAction = 'allow' | 'hide' | 'quit'

/** Decide how one window close event should proceed. */
export function resolveCloseAction(options: {
  readonly isQuitting: boolean
  readonly closeBehavior: DesktopCloseBehavior
  readonly trayAvailable: boolean
}): DesktopCloseAction {
  if (options.isQuitting) return 'allow'
  if (options.closeBehavior === 'quit') return 'quit'
  return options.trayAvailable ? 'hide' : 'quit'
}
```

- [ ] **Step 5: 运行测试确认通过**

```bash
corepack yarn vitest run tests/close-behavior.spec.ts
```

Expected: PASS，4 个用例。

- [ ] **Step 6: 提交**

```bash
git add dsh-plugin-desktop/src/runtime.ts dsh-plugin-desktop/src/close-behavior.ts dsh-plugin-desktop/tests/close-behavior.spec.ts
git commit -m "feat(desktop): decide window close action through a pure function"
```

---

## Task 2: Linux 托盘可用性探测（TDD）

**Files:**
- Create: `dsh-plugin-desktop/src/tray-availability.ts`
- Test: `dsh-plugin-desktop/tests/tray-availability.spec.ts`

- [ ] **Step 1: 写失败测试**

创建 `dsh-plugin-desktop/tests/tray-availability.spec.ts`：

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const childProcess = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void
  const listeners = new Map<string, Listener[]>()
  const stdoutListeners = new Map<string, Listener[]>()
  let watcherPresent = true
  let autoSettle = true
  const child = {
    stdout: {
      on: vi.fn((event: string, listener: Listener) => {
        stdoutListeners.set(event, [...(stdoutListeners.get(event) ?? []), listener])
        return child.stdout
      }),
    },
    once: vi.fn((event: string, listener: Listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
      return child
    }),
    kill: vi.fn(),
  }
  return {
    child,
    emit(event: string, ...args: unknown[]) {
      const current = [...(listeners.get(event) ?? [])]
      listeners.delete(event)
      for (const listener of current) listener(...args)
    },
    reset() {
      listeners.clear()
      stdoutListeners.clear()
      watcherPresent = true
      autoSettle = true
    },
    setWatcherPresent(present: boolean) { watcherPresent = present },
    setAutoSettle(enabled: boolean) { autoSettle = enabled },
    spawn: vi.fn((_command: string, args: string[]) => {
      // Auto-settle the StatusNotifier probe so tests never hang on the bus.
      if (autoSettle && args.includes('org.freedesktop.DBus.ListNames')) {
        queueMicrotask(() => {
          if (watcherPresent) {
            for (const listener of [...(stdoutListeners.get('data') ?? [])]) {
              listener(Buffer.from('  string "org.kde.StatusNotifierWatcher"\n'))
            }
          }
          const close = [...(listeners.get('close') ?? [])]
          listeners.delete('close')
          for (const listener of close) listener(0)
        })
      }
      return child
    }),
  }
})

vi.mock('node:child_process', () => ({ spawn: childProcess.spawn }))

import { isTrayAvailable, probeStatusNotifierWatcher } from '../src/tray-availability.ts'

describe('probeStatusNotifierWatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    childProcess.reset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves true when the watcher name is listed on the session bus', async () => {
    await expect(probeStatusNotifierWatcher()).resolves.toBe(true)
  })

  it('resolves false when no watcher is listed', async () => {
    childProcess.setWatcherPresent(false)
    await expect(probeStatusNotifierWatcher()).resolves.toBe(false)
  })

  it('resolves false when the probe process exits with an error', async () => {
    childProcess.setAutoSettle(false)
    const promise = probeStatusNotifierWatcher()
    childProcess.emit('error', new Error('dbus unavailable'))
    await expect(promise).resolves.toBe(false)
  })

  it('resolves false when the probe exits with a non-zero code', async () => {
    const promise = probeStatusNotifierWatcher()
    childProcess.emit('close', 1)
    await expect(promise).resolves.toBe(false)
  })

  it('resolves false after a timeout without a watcher response', async () => {
    vi.useFakeTimers()
    try {
      // Disable the auto-settling queueMicrotask so the setTimeout path is
      // exercised; otherwise the microtask resolves the probe first.
      childProcess.setAutoSettle(false)
      const promise = probeStatusNotifierWatcher(1_000)
      const assertion = expect(promise).resolves.toBe(false)
      await vi.advanceTimersByTimeAsync(1_001)
      await assertion
      expect(childProcess.child.kill).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('isTrayAvailable', () => {
  const probe = vi.fn(async () => true)

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('requires a successfully created tray on every platform', async () => {
    await expect(isTrayAvailable('linux', false, probe)).resolves.toBe(false)
    await expect(isTrayAvailable('win32', false, probe)).resolves.toBe(false)
    await expect(isTrayAvailable('darwin', false, probe)).resolves.toBe(false)
  })

  it('skips the watcher probe outside Linux', async () => {
    await expect(isTrayAvailable('win32', true, probe)).resolves.toBe(true)
    await expect(isTrayAvailable('darwin', true, probe)).resolves.toBe(true)
    expect(probe).not.toHaveBeenCalled()
  })

  it('probes the watcher on Linux', async () => {
    probe.mockResolvedValueOnce(true)
    await expect(isTrayAvailable('linux', true, probe)).resolves.toBe(true)
    probe.mockResolvedValueOnce(false)
    await expect(isTrayAvailable('linux', true, probe)).resolves.toBe(false)
    expect(probe).toHaveBeenCalledTimes(2)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
corepack yarn vitest run tests/tray-availability.spec.ts
```

Expected: FAIL，报 `Cannot find module '../src/tray-availability.ts'`。

- [ ] **Step 3: 实现模块**

创建 `dsh-plugin-desktop/src/tray-availability.ts`：

```ts
/** Linux StatusNotifier availability probe shared by the native shell. */

import { spawn } from 'node:child_process'
import type { DesktopPlatform } from './runtime.ts'

const STATUS_NOTIFIER_WATCHER_NAME = 'org.kde.StatusNotifierWatcher'
const STATUS_NOTIFIER_PROBE_TIMEOUT_MS = 2_000

/**
 * Probe whether a StatusNotifier host is present on the Linux session bus.
 * A missing watcher means a Tray created by Electron is never displayed.
 * @returns false on any failure, timeout, or absent watcher (degrade-safe).
 */
export async function probeStatusNotifierWatcher(
  timeoutMs: number = STATUS_NOTIFIER_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    let child: ReturnType<typeof spawn> | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    const settle = (value: boolean): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      resolve(value)
    }
    try {
      child = spawn('dbus-send', [
        '--session',
        '--print-reply',
        '--dest=org.freedesktop.DBus',
        '/org/freedesktop/DBus',
        'org.freedesktop.DBus.ListNames',
      ], { stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      settle(false)
      return
    }
    const probe = child
    if (probe === undefined) {
      settle(false)
      return
    }
    timer = setTimeout(() => {
      probe.kill()
      settle(false)
    }, timeoutMs)
    let output = ''
    if (probe.stdout !== null) {
      probe.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
    }
    probe.once('error', () => { settle(false) })
    probe.once('close', (code) => {
      if (code !== 0) {
        settle(false)
        return
      }
      settle(output.includes(STATUS_NOTIFIER_WATCHER_NAME))
    })
  })
}

/**
 * Decide whether the native tray will be displayed for the active platform.
 * @param platform - current Electron platform.
 * @param canCreateTray - whether the Tray was constructed without error.
 * @param probeWatcher - overridable Linux watcher probe for tests.
 */
export async function isTrayAvailable(
  platform: DesktopPlatform,
  canCreateTray: boolean,
  probeWatcher: () => Promise<boolean> = probeStatusNotifierWatcher,
): Promise<boolean> {
  if (!canCreateTray) return false
  if (platform !== 'linux') return true
  return await probeWatcher()
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
corepack yarn vitest run tests/tray-availability.spec.ts
```

Expected: PASS，7 个用例。

- [ ] **Step 5: 提交**

```bash
git add dsh-plugin-desktop/src/tray-availability.ts dsh-plugin-desktop/tests/tray-availability.spec.ts
git commit -m "feat(desktop): probe Linux StatusNotifier availability for the tray"
```

---

## Task 3: 设置 schema + 规格契约 + 插件线程接线

**Files:**
- Modify: `dsh-plugin-desktop/src/runtime.ts`（`DesktopShellSpec.readCloseBehavior`）
- Modify: `dsh-plugin-desktop/src/index.ts`（schema 字段、`applies: 'live'`、`readCloseBehavior`）
- Modify: `dsh-plugin-desktop/tests/plugin.spec.ts`（`applies` 断言、harness `settings.get`、`shell()` 断言、`notify` 字面量补 `closeBehavior`）
- Modify: `dsh-plugin-desktop/tests/electron-runtime.spec.ts`（`spec` mock 补 `readCloseBehavior: vi.fn(() => 'tray' as const)`）
- Modify: `dsh-plugin-desktop/tests/window-options.spec.ts`（`spec` mock 补 `readCloseBehavior: () => 'tray'`）
- Test: `dsh-plugin-desktop/tests/settings-schema.spec.ts`

- [ ] **Step 1: runtime.ts 增加规格字段**

在 `dsh-plugin-desktop/src/runtime.ts` 的 `DesktopShellSpec` 中，紧跟 `readThemeSource(): DesktopThemeSource` 行之后增加：

```ts
  /** Read the close-button behavior selected in desktop settings. */
  readCloseBehavior(): DesktopCloseBehavior
```

- [ ] **Step 2: index.ts 增加设置字段并接线**

打开 `dsh-plugin-desktop/src/index.ts`：

1. 把类型导入从 `import type { DesktopShellMode } from './runtime.ts'` 改为：

```ts
import type { DesktopCloseBehavior, DesktopShellMode } from './runtime.ts'
```

2. `DesktopSettings` 接口增加字段：

```ts
export interface DesktopSettings {
  /** Native presentation selected for the next application generation. */
  mode: DesktopShellMode
  /** Loopback Web port selected for the next application generation; zero requests a random port. */
  port: number
  /** Log verbosity threshold applied to the file logger. */
  logLevel: 'debug' | 'info' | 'warn' | 'error'
  /** Close-button behavior: hide to the tray or exit the process. */
  closeBehavior: DesktopCloseBehavior
}
```

3. `DesktopSettingsSchema` 增加字段（`logLevel` 之后）：

```ts
  closeBehavior: z.union(['tray', 'quit'] as const).default('tray'),
```

4. `settings.register` 的选项 `applies` 从 `'restart'` 改为 `'live'`：

```ts
  const settings = ctx.settings.register(
    DESKTOP_SETTINGS_NAMESPACE,
    DesktopSettingsSchema,
    {
      applies: 'live',
      validate: (value) => {
        if (value.mode === 'advanced' && runtime.platform === 'linux') {
          throw new Error('dsh-plugin-desktop: advanced shell mode is supported on macOS and Windows')
        }
      },
    },
  )
```

5. 在 `runtime.schedule({ ... })` 的 spec 对象里，`readThemeSource` 之后增加：

```ts
      readCloseBehavior: () => {
        return (ctx.settings.get(DESKTOP_SETTINGS_NAMESPACE) as DesktopSettings).closeBehavior
      },
```

- [ ] **Step 3: 新增 schema 默认值测试**

创建 `dsh-plugin-desktop/tests/settings-schema.spec.ts`。注意：schemastery 3.18.1 的 schema 是**可调用形式** `schema(value)`，没有 `.parse`；用可调用形式加 `as DesktopSettings` 断言以满足必填字段输入类型：

```ts
import { describe, expect, it } from 'vitest'
import { DesktopSettings, DesktopSettingsSchema } from '../src/index.ts'

describe('DesktopSettingsSchema', () => {
  it('defaults the close behavior to tray mode', () => {
    const settings = DesktopSettingsSchema({} as DesktopSettings)
    expect(settings.closeBehavior).toBe('tray')
  })

  it('accepts an explicit quit close behavior', () => {
    const settings = DesktopSettingsSchema({ closeBehavior: 'quit' } as DesktopSettings)
    expect(settings.closeBehavior).toBe('quit')
  })
})
```

- [ ] **Step 4: 更新 plugin.spec.ts**

打开 `dsh-plugin-desktop/tests/plugin.spec.ts`，做这些修改：

1. `createHarness` 的 `settings.get`（第 101-105 行附近）在 `locale` 分支之后、`return undefined` 之前增加：

```ts
      if (String(namespace) === 'dsh-desktop') return { mode: config.mode, closeBehavior: 'tray' }
```

2. 断言 `applies` 从 `'restart'` 改为 `'live'`（原第 216 行）：

```ts
    expect(register.mock.calls[0]?.[2]).toEqual(expect.objectContaining({ applies: 'live' }))
```

3. `harness.shell()` 断言（原第 218-227 行）：在 `readThemeSource: expect.any(Function),` 之后增加 `readCloseBehavior: expect.any(Function),`；并在 `expect(harness.shell()?.readThemeSource()).toBe('system')` 之后增加：

```ts
    expect(harness.shell()?.readCloseBehavior()).toBe('tray')
```

4. `settings.get` mock 现在返回 `closeBehavior: 'tray'`，解析后的 `DesktopSettings` 也包含该字段。需要把 plugin.spec 中任何对解析后设置的精确实 `toEqual`（约第 163 行）以及 `notify(next, prev)` 的 `DesktopSettings` 字面量（约 8 个字面量）补上 `closeBehavior: 'tray'`，否则运行期与 typecheck 不过。

- [ ] **Step 4b: 补全既有 DesktopShellSpec 测试字面量**

`DesktopShellSpec.readCloseBehavior` 是必填字段，需要给两个构造完整 `DesktopShellSpec` 字面量的既有测试各加一行：
- `dsh-plugin-desktop/tests/electron-runtime.spec.ts`（`spec` mock，`readThemeSource: vi.fn(() => 'system' as const)` 之后）：
  `readCloseBehavior: vi.fn(() => 'tray' as const),`
- `dsh-plugin-desktop/tests/window-options.spec.ts`（`spec` mock，`readThemeSource: () => 'system'` 之后）：
  `readCloseBehavior: () => 'tray',`

- [ ] **Step 5: 运行测试与类型检查**

```bash
corepack yarn workspace dsh-plugin-desktop vitest run tests/plugin.spec.ts tests/settings-schema.spec.ts
cd /home/admins/PycharmProjects/deepseek-harness-desktop && corepack yarn workspace dsh-plugin-desktop typecheck
```

Expected: 两个测试文件 PASS；typecheck 无错误。

- [ ] **Step 6: 提交**

```bash
git add dsh-plugin-desktop/src/runtime.ts dsh-plugin-desktop/src/index.ts dsh-plugin-desktop/tests/plugin.spec.ts dsh-plugin-desktop/tests/settings-schema.spec.ts dsh-plugin-desktop/tests/electron-runtime.spec.ts dsh-plugin-desktop/tests/window-options.spec.ts
git commit -m "feat(desktop): add configurable close behavior setting and thread it to the shell spec"
```

---

## Task 4: Shell 生成接线（close 处理器 + 托盘挂载）

**Files:**
- Modify: `dsh-plugin-desktop/src/electron-shell-generation.ts`
- Modify: `dsh-plugin-desktop/src/electron-runtime.ts`
- Modify: `dsh-plugin-desktop/tests/electron-runtime.spec.ts`

- [ ] **Step 1: electron-shell-generation.ts 增加选项字段**

打开 `dsh-plugin-desktop/src/electron-shell-generation.ts`：

1. 类型导入改为：

```ts
import type { DesktopCloseBehavior, DesktopNotification, DesktopShellSpec } from './runtime.ts'
```

2. 模块导入新增：

```ts
import { resolveCloseAction } from './close-behavior.ts'
import { isTrayAvailable } from './tray-availability.ts'
```

3. `ElectronShellGenerationOptions` 接口，在 `buildTrayTemplate` 之后新增三个字段：

```ts
  readonly readCloseBehavior: () => DesktopCloseBehavior
  readonly requestQuit: (code: number) => void
  readonly notifyTrayUnavailable: () => void
```

- [ ] **Step 2: 重写 close 处理器与托盘挂载**

在 `ElectronShellGeneration` 类中：

1. 类字段新增 `private trayAvailable = false`。

2. `mount()` 内 close 处理器（当前为 `const close = (event: Electron.Event): void => { if (this.options.isQuitting()) return; event.preventDefault(); window.hide() }`）替换为：

```ts
    const close = (event: Electron.Event): void => {
      const closeBehavior = this.options.readCloseBehavior()
      const action = resolveCloseAction({
        isQuitting: this.options.isQuitting(),
        closeBehavior,
        trayAvailable: this.trayAvailable,
      })
      if (action === 'allow') return
      event.preventDefault()
      if (action === 'hide') {
        window.hide()
        return
      }
      // The tray-unavailable notice names the Linux AppIndicator extension;
      // keep it Linux-only so a rare Windows/macOS tray failure never shows it.
      if (closeBehavior === 'tray' && platform.platform === 'linux') {
        this.options.notifyTrayUnavailable()
      }
      this.options.requestQuit(0)
    }
```

3. `mount()` 中删除局部 `let tray: Tray | undefined` 声明（第 161 行），并把托盘创建块（当前第 178-182 行）：

```ts
      tray = new Tray(prepareTrayIcon(spec.trayIcons, platform.platform))
      this.tray = tray
      tray.setToolTip(spec.productName)
      this.refreshTrayMenu()
      tray.on('click', show)
```

替换为：

```ts
      this.trayAvailable = await this.mountTray(show)
```

4. `cleanupListeners`（第 162-174 行）里的 `tray?.off('click', show)` 改为 `this.tray?.off('click', show)`。

5. 在 `mountTray` 之前（`show()` 方法附近）新增私有方法：

```ts
  /** Create the native tray, probing Linux availability; returns whether it is displayed. */
  private async mountTray(show: () => void): Promise<boolean> {
    const { platform, spec } = this.options
    let tray: Tray | undefined
    try {
      tray = new Tray(prepareTrayIcon(spec.trayIcons, platform.platform))
    } catch (cause) {
      this.options.logError(
        `dsh-plugin-desktop: failed to create system tray: ${cause instanceof Error ? cause.message : String(cause)}`,
      )
    }
    const available = await isTrayAvailable(platform.platform, tray !== undefined)
    if (!available) {
      tray?.destroy()
      return false
    }
    if (tray !== undefined) {
      this.tray = tray
      tray.setToolTip(spec.productName)
      this.refreshTrayMenu()
      tray.on('click', show)
    }
    return true
  }
```

6. `release()` 方法调整顺序，让 `cleanupListeners` 在清空 `this.tray` 之前执行。当前（第 238-247 行）：

```ts
    this.clearAttention()
    this.window = undefined
    this.tray = undefined
    if (window === undefined) return

    this.cleanupListeners?.()
    this.cleanupListeners = undefined
    tray?.destroy()
```

改为：

```ts
    this.clearAttention()
    this.cleanupListeners?.()
    this.cleanupListeners = undefined
    this.window = undefined
    this.tray = undefined
    if (window === undefined) return

    tray?.destroy()
```

- [ ] **Step 3: electron-runtime.ts 透传回调 + 降级通知**

打开 `dsh-plugin-desktop/src/electron-runtime.ts`：

1. 类字段新增（`private quitting = false` 附近）：

```ts
  private trayUnavailableNotified = false
```

2. `mountScheduled()` 的 `new ElectronShellGeneration({ ... })`，在 `buildTrayTemplate` 之后新增：

```ts
        readCloseBehavior: () => spec.readCloseBehavior(),
        requestQuit: code => spec.requestQuit(code),
        notifyTrayUnavailable: () => this.notifyTrayUnavailable(),
```

3. 新增私有方法（放在 `showNotification` 附近）：

```ts
  /** Explain once per session why closing exits instead of hiding to the tray. */
  private notifyTrayUnavailable(): void {
    if (this.trayUnavailableNotified) return
    this.trayUnavailableNotified = true
    this.showNotification({
      title: 'System Tray Unavailable',
      body: 'This desktop does not expose a system tray, so closing the window exits DSH Desktop. Install the AppIndicator extension to enable tray mode.',
    })
  }
```

- [ ] **Step 4: 更新 electron-runtime.spec.ts mock 与新增测试**

打开 `dsh-plugin-desktop/tests/electron-runtime.spec.ts`：

1. `childProcess` hoisted mock（第 14-38 行）的 `child` 增加 `stdout.on`、`kill`，`spawn` 增加探测自动结算，返回值增加 `reset` 重置 watcher、`setWatcherPresent`。把整个 hoisted 块替换为：

```ts
const childProcess = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void
  const listeners = new Map<string, Listener[]>()
  const stdoutListeners = new Map<string, Listener[]>()
  let watcherPresent = true
  const child = {
    stdout: {
      on: vi.fn((event: string, listener: Listener) => {
        stdoutListeners.set(event, [...(stdoutListeners.get(event) ?? []), listener])
        return child.stdout
      }),
    },
    once: vi.fn((event: string, listener: Listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
      return child
    }),
    off: vi.fn((event: string, listener: Listener) => {
      listeners.set(event, (listeners.get(event) ?? []).filter(candidate => candidate !== listener))
      return child
    }),
    unref: vi.fn(),
    kill: vi.fn(),
  }
  return {
    child,
    emit(event: string, ...args: unknown[]) {
      const current = [...(listeners.get(event) ?? [])]
      listeners.delete(event)
      for (const listener of current) listener(...args)
    },
    reset() {
      listeners.clear()
      stdoutListeners.clear()
      watcherPresent = true
    },
    setWatcherPresent(present: boolean) { watcherPresent = present },
    spawn: vi.fn((_command: string, args: string[]) => {
      // Auto-settle the StatusNotifier probe so mounts never hang on the bus.
      if (args.includes('org.freedesktop.DBus.ListNames')) {
        queueMicrotask(() => {
          if (watcherPresent) {
            for (const listener of [...(stdoutListeners.get('data') ?? [])]) {
              listener(Buffer.from('  string "org.kde.StatusNotifierWatcher"\n'))
            }
          }
          const close = [...(listeners.get('close') ?? [])]
          listeners.delete('close')
          for (const listener of close) listener(0)
        })
      }
      return child
    }),
  }
})
```

2. `spec: DesktopShellSpec`（第 221-239 行）里 `requestQuit: () => {}` 改为 `requestQuit: vi.fn()`，并在 `requestModeChange` 之前增加：

```ts
  readCloseBehavior: vi.fn(() => 'tray' as const),
```

3. 在 `describe('Electron desktop runtime')` 块内、`it('opens one parented Windows folder chooser...` 之前新增三个测试：

```ts
  it('hides the window on close when the tray is available and close behavior is tray', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    const release = runtime.schedule(spec)

    await runtime.mountScheduled()

    expect(electron.trays).toHaveLength(1)
    const closeListener = electron.browserWindowOn.mock.calls.find(([event]) => event === 'close')?.[1]
    expect(closeListener).toEqual(expect.any(Function))
    const event = { preventDefault: vi.fn() }
    closeListener(event)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(electron.browserWindows[0]?.hide).toHaveBeenCalledOnce()
    expect(spec.requestQuit).not.toHaveBeenCalled()

    await release()
  })

  it('quits through the shutdown path when close behavior is explicit quit', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    spec.readCloseBehavior.mockReturnValueOnce('quit')
    const release = runtime.schedule(spec)

    await runtime.mountScheduled()

    const closeListener = electron.browserWindowOn.mock.calls.find(([event]) => event === 'close')?.[1]
    closeListener({ preventDefault: vi.fn() })

    expect(spec.requestQuit).toHaveBeenCalledWith(0)
    expect(electron.browserWindows[0]?.hide).not.toHaveBeenCalled()

    await release()
  })

  it('quits and notifies once when tray mode is selected but the tray is unavailable', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
    childProcess.setWatcherPresent(false)
    const { ElectronDesktopRuntime } = await import('../src/electron-runtime.ts')
    const runtime = new ElectronDesktopRuntime(async () => {})
    const release = runtime.schedule(spec)

    await runtime.mountScheduled()

    // The Tray is still constructed to test creation, then destroyed once the
    // Linux watcher probe reports no host.
    expect(electron.trays).toHaveLength(1)
    expect(electron.trays[0]?.destroy).toHaveBeenCalledOnce()
    expect(electron.trays[0]?.setToolTip).not.toHaveBeenCalled()
    const closeListener = electron.browserWindowOn.mock.calls.find(([event]) => event === 'close')?.[1]
    closeListener({ preventDefault: vi.fn() })
    closeListener({ preventDefault: vi.fn() })

    expect(spec.requestQuit).toHaveBeenCalledTimes(2)
    expect(electron.notifications).toHaveLength(1)
    expect(electron.notifications[0]?.options).toEqual(expect.objectContaining({
      title: 'System Tray Unavailable',
    }))

    await release()
  })
```

注意：`spec` 是模块级共享对象，三个新测试都依赖 `spec.readCloseBehavior` 默认 `'tray'`；显式退出测试用 `mockReturnValueOnce` 避免污染后续用例。`beforeEach` 里的 `vi.clearAllMocks()` 会清空调用记录但保留工厂默认实现。

- [ ] **Step 5: 运行测试与类型检查**

```bash
corepack yarn workspace dsh-plugin-desktop vitest run tests/electron-runtime.spec.ts
cd /home/admins/PycharmProjects/deepseek-harness-desktop && corepack yarn workspace dsh-plugin-desktop typecheck
```

Expected: electron-runtime.spec.ts 全部通过（含新增 3 个用例与原有用例）；typecheck 无错误。

- [ ] **Step 6: 提交**

```bash
git add dsh-plugin-desktop/src/electron-shell-generation.ts dsh-plugin-desktop/src/electron-runtime.ts dsh-plugin-desktop/tests/electron-runtime.spec.ts
git commit -m "feat(desktop): hide, quit, or degrade on window close from tray availability"
```

---

## Task 5: deb 打包依赖

**Files:**
- Modify: `dsh-plugin-desktop/package.json`

- [ ] **Step 1: 增加 appindicator 依赖**

打开 `dsh-plugin-desktop/package.json`，在 `build.linux` 对象的 `"syncDesktopName": true,` 之后增加一行：

```json
    "depends": ["libayatana-appindicator3-1"],
```

- [ ] **Step 2: 验证 JSON 合法**

```bash
python3 -c "import json; json.load(open('dsh-plugin-desktop/package.json')); print('ok')"
```

Expected: `ok`。

- [ ] **Step 3: 提交**

```bash
git add dsh-plugin-desktop/package.json
git commit -m "build(desktop): declare libayatana-appindicator for the Linux tray"
```

---

## Task 6: 文档

**Files:**
- Modify: `docs/faq.md`
- Modify: `docs/faq.en.md`

- [ ] **Step 1: 中文 FAQ 增加条目**

在 `docs/faq.md` 的 `## 应用如何更新？` 段落之后、`## 在哪里下载和报告问题？` 之前插入：

```markdown
## Linux 下关闭窗口会退出应用或系统托盘不显示？

Linux 下点击窗口关闭按钮默认把应用收起到系统托盘，进程继续运行。但托盘依赖桌面环境的 StatusNotifier 支持：GNOME 桌面默认不显示托盘，需要安装 "AppIndicator and KStatusNotifierItem Support" 扩展（Ubuntu 自带的会话已内置该支持）。

如果托盘不可用，关闭窗口会直接退出应用（并提示一次），避免窗口消失后进程仍在后台运行却无法重新打开。你可以在设置中把"关闭按钮行为"改为"退出"，或改回"最小化到托盘"。
```

- [ ] **Step 2: 英文 FAQ 增加条目**

在 `docs/faq.en.md` 对应位置（"应用如何更新？" 之后）插入：

```markdown
## On Linux, does closing the window exit the app or hide it to the tray?

On Linux, clicking the window close button hides the app to the system tray by default and keeps the process running. The tray relies on StatusNotifier support in the desktop environment: GNOME does not show a tray by default and needs the "AppIndicator and KStatusNotifierItem Support" extension (Ubuntu's default session includes this support).

When the tray is unavailable, closing the window exits the app directly (with a one-time notice) so the window does not vanish while a background process stays impossible to reopen. You can set the "close button behavior" to "exit" or back to "minimize to tray" in settings.
```

- [ ] **Step 3: 提交**

```bash
git add docs/faq.md docs/faq.en.md
git commit -m "docs: explain Linux tray availability and close behavior"
```

---

## Task 7: 完整验证门禁

**Files:** 无（只读验证）

- [ ] **Step 1: 运行桌面包全量单测**

```bash
cd /home/admins/PycharmProjects/deepseek-harness-desktop && corepack yarn workspace dsh-plugin-desktop test
```

Expected: 全部测试通过。

- [ ] **Step 2: 运行类型检查**

```bash
corepack yarn typecheck
```

Expected: 无错误（含 dsh-community-market 的 typecheck）。

- [ ] **Step 3: 运行完整 headless 门禁**

```bash
corepack yarn check
```

Expected: 通过。若某个子包门禁（如 layout / fabric / market）因本次改动报错，先排查是否与本次改动相关；无关则记录并继续。

---

## 风险备注

- **`applies` 从 `'restart'` 改为 `'live'`**：Task 3 Step 5 会跑 `plugin.spec.ts`（断言 `'live'`）与 typecheck；若真实设置服务对 `'live'` 有额外写行为差异，由 Task 7 门禁兜底。`mode`/`port` 自动重启由 `settings.watch` 驱动，不依赖 `applies` 值。
- **Linux 上 Electron 43 是否真需要 `libayatana-appindicator3-1`**：该依赖对旧式 appindicator 路径是保障，Chromium 已切原生 SNI。打包后可用 `ldd /opt/DSH\ Desktop/dsh-desktop | grep -i indicator` 实测；若确认不需要，回退该依赖并保留文档说明。
- **`dbus-send` 探测时效性**：启动时探测一次；用户中途安装扩展需重启应用才生效，可接受。
