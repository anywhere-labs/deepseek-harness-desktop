# DSH Desktop Linux 托盘关闭行为设计

日期：2026-08-20
状态：已确认（方案 1）

## 背景与问题

Linux 桌面版点击窗口右上角关闭按钮时，进程并不会退出。代码中 `ElectronShellGeneration` 的 close 处理器（`dsh-plugin-desktop/src/electron-shell-generation.ts:76-80`）拦截了 close 事件并 `window.hide()`，这是刻意的 close-to-tray 行为。

但实测在常见 Linux 桌面环境（如 GNOME Wayland）下，托盘图标不显示：Electron 在 Linux 上通过 StatusNotifierItem (SNI) D-Bus 协议显示托盘，GNOME 默认缺少 AppIndicator/StatusNotifier 支持。结果就是窗口隐藏后应用"凭空消失"，进程常驻但没有任何入口重新打开或真正退出，只能手动 kill。

## 目标

1. 关闭行为可配置：`closeBehavior: 'tray' | 'quit'`，默认 `'tray'`（所有平台统一），设置即时生效。
2. 修复 Linux 托盘可靠性：
   - deb 声明 `libayatana-appindicator3-1` 依赖。
   - 启动时探测托盘是否可用；不可用时关闭操作降级为"真正退出"，避免应用消失。
   - 降级时通过原生通知提示用户一次。
3. 最小化按钮行为不变（仍为普通最小化）。

## 非目标

- 不在应用侧解决"GNOME 需要手动安装 AppIndicator 扩展"这一桌面环境层面的限制（只能文档说明）。
- 不修改 `deepseek-harness/` 上游子模块。
- 不改变托盘菜单的既有入口（打开桌面 / 模式切换 / 退出）。

## 现状梳理

- `dsh-plugin-desktop/src/electron-shell-generation.ts`：拥有 `BrowserWindow` 与 `Tray`，close 处理器当前逻辑为「非退出态 → `preventDefault()` + `window.hide()`」。
- `dsh-plugin-desktop/src/electron-runtime.ts`：`mountScheduled()` 组装 `ElectronShellGenerationOptions`；`buildTrayTemplate()` 构建托盘菜单（含 Quit → `spec.requestQuit(0)`）。
- `dsh-plugin-desktop/src/runtime.ts`：`DesktopShellSpec` 已有 `readLocalePreference` / `readThemeSource` 这类「插件 → Electron 适配器」回调，新设置沿用同一模式。
- `dsh-plugin-desktop/src/index.ts`：`DesktopSettingsSchema` 注册于 `DESKTOP_SETTINGS_NAMESPACE`（当前 `applies: 'restart'`）。
- `dsh-plugin-desktop/package.json`：`build.linux` 目标为 deb / rpm / AppImage，未声明 appindicator 依赖。

## 设计

### 1. 设置项

`index.ts` 的 `DesktopSettingsSchema` 增加字段：

```ts
closeBehavior: z.union(['tray', 'quit'] as const).default('tray')
```

- 默认 `'tray'`，所有平台统一。
- 该命名空间的注册 `applies` 由 `'restart'` 改为 `'live'`：
  - 关闭行为在 close 瞬间实时读取，应即时生效。
  - `mode` / `port` 的改动已有 `settings.watch`（`index.ts:200-218`）自动触发 `requestRestart()`，改为 `'live'` 不回归重启语义，只是让配置 UI 不再误标"需重启"。

### 2. 线程接线

沿用现有回调模式，逐层透传：

- `runtime.ts`：
  - 新增类型 `export type DesktopCloseBehavior = 'tray' | 'quit'`。
  - `DesktopShellSpec` 增加 `readCloseBehavior(): DesktopCloseBehavior`。
- `electron-runtime.ts` `mountScheduled()`：
  - `ElectronShellGenerationOptions` 增加 `readCloseBehavior`、`requestQuit(code: number)`、`notifyTrayUnavailable(): void`。
- `index.ts` `apply()`：
  - `readCloseBehavior: () => (settings.get(DESKTOP_SETTINGS_NAMESPACE) as DesktopSettings).closeBehavior`。

### 3. 托盘可用性探测

新增模块 `dsh-plugin-desktop/src/tray-availability.ts`（纯逻辑，便于单测）：

- `probeStatusNotifierWatcher(): Promise<boolean>`（仅 Linux 调用）：
  - 通过 `child_process.spawn` 执行
    `dbus-send --session --print-reply --dest=org.freedesktop.DBus /org/freedesktop/DBus org.freedesktop.DBus.ListNames`
  - 检查输出是否包含 `org.kde.StatusNotifierWatcher`。
  - 带超时与错误兜底：**探测失败 / 无 watcher / 超时 → 返回 `false`**（向"降级"倾斜，宁可退出也不让应用消失）。
- 非 Linux（win32 / darwin）：托盘可靠，恒为可用，不探测。

`electron-shell-generation.ts` 在 `mount()` 中计算可用性：

```
trayAvailable =
  platform === 'linux'
    ? (await probeStatusNotifierWatcher()) && trayCreationSucceeds
    : trayCreationSucceeds   // win/mac：try/catch 兜底
```

- `new Tray(...)` 用 try/catch 包裹；抛错 → `trayAvailable = false`。
- 不可用时跳过托盘创建，`this.tray` 保持 `undefined`；现有 `refreshTrayMenu()` 等已对空托盘优雅短路（`if (this.tray === undefined) return`）。
- 新增 `private trayAvailable` 状态，供 close 决策使用。

### 4. 关闭决策逻辑

新增纯函数（模块内导出，便于单测）：

```ts
type CloseAction = 'allow' | 'hide' | 'quit'
function resolveCloseAction(options: {
  isQuitting: boolean
  closeBehavior: DesktopCloseBehavior
  trayAvailable: boolean
}): CloseAction
```

决策矩阵：

| isQuitting | closeBehavior | trayAvailable | 结果 |
|---|---|---|---|
| true | — | — | `'allow'`（放行，维持现状） |
| false | `'tray'` | true | `'hide'`（隐藏到托盘） |
| false | `'tray'` | false | `'quit'`（降级：托盘不可用） |
| false | `'quit'` | — | `'quit'` |

close 处理器改动（`electron-shell-generation.ts`）：

- `'allow'` → 不 `preventDefault()`，让关闭自然进行。
- `'hide'` → `event.preventDefault(); window.hide()`。
- `'quit'` → `event.preventDefault(); this.options.requestQuit(0)`（与托盘 Quit 相同的 Cordis teardown → 进程退出路径，`shutdown.request` 的 `exitOnce` 保证幂等）。

### 5. 降级通知

当决策结果为 `'quit'` 且原因是「托盘不可用」（`closeBehavior='tray'` 且 `trayAvailable=false`），而非用户显式选择退出时：

- 调用 `this.options.notifyTrayUnavailable()`。
- 由 `electron-runtime.ts` 实现：复用现有原生 Notification 基建，提示「桌面环境不支持系统托盘，关闭窗口将退出 DSH Desktop；可安装 AppIndicator 扩展以启用托盘」。
- **每会话仅通知一次**（用一次性标志位去重），避免反复打扰。
- 通知能力不可用（`Notification.isSupported()` 为 false）时静默退出。

### 6. deb 打包与文档

- `dsh-plugin-desktop/package.json` 的 `build.linux` 增加：
  ```json
  "depends": ["libayatana-appindicator3-1"]
  ```
  使 deb 安装时自动带上托盘底层库（electron-builder `linux.depends` 应用到 deb/rpm）。
- 根 `docs/faq.md`（及 `faq.en.md`）补一条说明：GNOME 桌面需安装 "AppIndicator and KStatusNotifierItem Support" 扩展，否则托盘不显示；无扩展时关闭按钮将直接退出应用。

## 测试

沿用 `dsh-plugin-desktop` 现有 vitest，保持 headless 安全（不启动 GUI）：

1. `resolveCloseAction` 决策矩阵：覆盖上表全部 4 类组合。
2. `probeStatusNotifierWatcher`：mock `child_process.spawn`，覆盖「有 watcher / 无 watcher / 探测出错 / 超时」四条路径。
3. 设置 schema：`closeBehavior` 默认解析为 `'tray'`。
4. 现有 `corepack yarn typecheck` / `corepack yarn test` / `corepack yarn build` 门禁保持通过。

## 涉及文件

- `dsh-plugin-desktop/src/tray-availability.ts`（新增）
- `dsh-plugin-desktop/src/runtime.ts`（`DesktopCloseBehavior`、`DesktopShellSpec.readCloseBehavior`）
- `dsh-plugin-desktop/src/electron-runtime.ts`（透传回调、`notifyTrayUnavailable` 实现）
- `dsh-plugin-desktop/src/electron-shell-generation.ts`（探测、close 决策、`trayAvailable`）
- `dsh-plugin-desktop/src/index.ts`（schema 字段、`applies: 'live'`、`readCloseBehavior`）
- `dsh-plugin-desktop/package.json`（`build.linux.depends`）
- `dsh-plugin-desktop/tests/**`（新增/补充单测）
- `docs/faq.md` / `docs/faq.en.md`（文档说明）

## 风险与待办

- **Electron 43 Linux 托盘是否真的依赖 `libayatana-appindicator3-1`**：Chromium 已切换到原生 SNI 实现，该依赖对纯 SNI 场景可能非必需，但对旧式 appindicator 路径仍是保障。实现阶段用 `ldd <app> | grep -i indicator` 在目标发行版上实测确认，若确认不需要则仅保留文档说明。
- **`applies` 从 `'restart'` 改为 `'live'`**：需验证设置服务对 `'live'` 的写行为（是否会即时推送到 renderer），以及 `mode`/`port` 的自动重启逻辑不受影响。
- **`dbus-send` 探测的时效性**：探测在启动时执行一次；用户中途安装扩展需重启应用才生效，可接受。
- **AppArmor**：deb 的 AppArmor 配置由 electron-builder 自动生成，可能限制 SNI D-Bus 路径/名字；若实测被拦截，再评估是否用 `extraFiles` 覆盖 profile。不在本次范围内强做。
