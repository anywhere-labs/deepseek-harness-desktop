# DSH Desktop 通用设置「关闭窗口时」下拉行设计

日期：2026-08-20
状态：已确认（方案 A）

## 背景与问题

`closeBehavior` 设置项（`'tray' | 'quit'`）在 [2026-08-20-tray-close-behavior-design.md](./2026-08-20-tray-close-behavior-design.md) 中已经完整实现：schema 注册于 `DESKTOP_SETTINGS_NAMESPACE`（`applies: 'live'`），关闭处理器按决策矩阵实时读取。但该设置目前只能手改 `/home/admins/.dsh/settings.yaml`，应用内没有可视化入口。

用户需求：在应用「通用设置」里加一个下拉，选择点击窗口关闭按钮时「最小化到托盘」还是「退出」，替换手改配置。

## 目标

1. 在通用设置（General section）加一行偏好项：标题「关闭窗口时」，下拉两个选项「最小化到托盘」「退出」。
2. 下拉读取并写入现有 `closeBehavior` 设置（`DESKTOP_SETTINGS_NAMESPACE` 的 `closeBehavior` 字段），写入后即时生效（`applies: 'live'`）。
3. 不修改任何 host 侧代码（关闭决策、托盘降级、通知均沿用现有实现）。
4. 不修改 `deepseek-harness/` 上游子模块。

## 非目标

- 不暴露 `mode` / `port` / `logLevel` 等其他桌面设置。
- 不新增「托盘不可用」的行内提示（沿用现有「静默降级 + 每会话一次原生通知」行为，用户已确认）。
- 不新建独立设置页（`settings.section`）；单行偏好用 `settings.general.item` 槽。
- 不改变关闭决策矩阵、托盘探测或降级逻辑。

## 现状梳理

- `dsh-plugin-desktop/src/index.ts`：`DesktopSettingsSchema` 含 `closeBehavior`，注册于 `DESKTOP_SETTINGS_NAMESPACE`（`settingsNamespace('dsh-desktop')`），`applies: 'live'`；host `apply()` 提供 `readCloseBehavior` 给关闭处理器。
- `dsh-plugin-desktop/src/electron-shell-generation.ts`：close 处理器按 `resolveCloseAction` 决策「放行 / 隐藏到托盘 / 退出」，托盘不可用时降级退出并通知一次。
- `deepseek-harness/packages/client/ui-settings/src/client/contract/slots.ts`：`settings.general.item` 槽 =「通用设置内一行偏好项，由拥有该偏好的特性插件贡献；行自绘内部（含 label），读写走自己的注入面 + host.call；options 为 `id`（行 key）与 `order`（行位置）」。
- `deepseek-harness/packages/client/ui-settings-general/src/client/GeneralSection.tsx`：General 部分渲染所有 `settings.general.item` 贡献。
- 范例：`deepseek-harness/packages/client/locale/src/client/index.ts` + `LanguageRow.tsx`——`ctx.settingsScope.bind(namespace)` 读、`host.set(field, value)` 写、`Menu` 下拉渲染、`ctx.slots.inject('settings.general.item', ...)` 注册。
- `dsh-plugin-desktop/src/client/index.ts`：桌面客户端 `apply()` 已存在（环境检查后注册桌面专属表面），当前 inject 为 `['slots', 'sessions', 'theme', 'workspaces']`；依赖已含 `@deepseek-ai/dsh-client-ui-settings` / `@deepseek-ai/dsh-client-ui-slots` / `@deepseek-ai/dsh-client-ui-primitives` / `@deepseek-ai/dsh-client-locale`。

## 设计

### 1. 设置项

复用现有 `closeBehavior` 字段，**无 schema / host 改动**。选项映射：
- `'tray'` → 「最小化到托盘」（托盘可用时隐藏到托盘；不可用时按现有逻辑降级退出并通知）
- `'quit'` → 「退出」

### 2. 新增客户端文件（`dsh-plugin-desktop/src/client/`）

| 文件 | 职责 |
|---|---|
| `close-behavior-settings-store.ts` | 行 store：`value: DesktopCloseBehavior`、`options: [{ id: 'tray' }, { id: 'quit' }]`、`revision`；`getSnapshot` / `subscribe` / `set`。纯逻辑，node 环境可单测。 |
| `CloseBehaviorRow.tsx` | 行组件：标题「关闭窗口时」+ `Menu` 下拉（复用 `@deepseek-ai/dsh-client-ui-primitives`），`useStore` 读当前值，注入面 `setCloseBehavior` 写。结构对齐 `LanguageRow.tsx`。 |
| `close-behavior-locale.ts` | zh/en 字典：行标题 + 两选项 + 通用口吻。 |

### 3. 接线（`dsh-plugin-desktop/src/client/index.ts` 的 `apply()`）

- inject 增加 `'locale'`、`'settingsScope'`（上游 locale / ui-settings 服务）。
- 在环境检查通过后、mode 无关地注册（桌面窗口内两个 mode 均生效）：
  ```ts
  const host = ctx.settingsScope.bind<DesktopSettings>({ namespace: DESKTOP_SETTINGS_NAMESPACE })
  ctx.locale.register('settings.desktop', { zh, en })
  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'close-behavior',
    order: 10,            // 位于 Language（order 0）之后
    store,
    locale: 'settings.desktop',
    inject: injected,     // { setCloseBehavior }，内部 host.set('closeBehavior', v)
  }, CloseBehaviorRow))
  ```
- `injected` 同时负责首次同步：把 `settingsScope` 当前快照的 `closeBehavior` 灌入 store（对齐 `LanguageRow` 的 `sync(locale.getLocale())`）。

### 4. 文案（zh / en）

- 行标题：关闭窗口时 / On window close
- 选项：最小化到托盘 / Minimize to tray；退出 / Quit

### 5. 测试（headless-safe，沿用仓库 vitest，`environment: 'node'`）

1. `close-behavior-settings-store` 单测：默认值、`set` 后快照与 revision 变化、订阅通知。
2. `apply()` 注册单测（对齐上游 `apply.client.spec.ts` 模式）：mock `slots` / `settingsScope` / `locale`，断言以 `id: 'close-behavior'`、`order: 10` 注册了 `settings.general.item` 行，且注入面写 `closeBehavior` 正确转发。
3. 关闭决策逻辑已有 `close-behavior.spec.ts` 覆盖，不动。

### 6. 验证

- `corepack yarn typecheck` / `corepack yarn test` / `corepack yarn check` 门禁通过。
- 打包 deb → 打开通用设置，肉眼确认「关闭窗口时」下拉出现；切换「退出 ↔ 最小化到托盘」后关闭窗口行为即时变化；`settings.yaml` 的 `dsh-desktop.closeBehavior` 随之更新。

## 涉及文件

- 新增：`dsh-plugin-desktop/src/client/close-behavior-settings-store.ts`
- 新增：`dsh-plugin-desktop/src/client/CloseBehaviorRow.tsx`（+ 同目录 `.module.css`，若复用现有样式则省略）
- 新增：`dsh-plugin-desktop/src/client/close-behavior-locale.ts`
- 修改：`dsh-plugin-desktop/src/client/index.ts`（inject、注册）
- 修改：`dsh-plugin-desktop/tests/`（新增 store / apply 注册单测）

## 风险与待办

- **renderer locale 注册时机**：`ctx.locale.register` 需在行渲染前完成；行 store 的 locale seat 由 slot 机制绑定 `settings.desktop` 命名空间，缺失字典时按现有链回退（fail loud 显示 key）。实现阶段用真实组合验证文案渲染。
- **桌面 composition 依赖**：`locale` / `settingsScope` 服务由上游插件提供；桌面依赖已声明（package.json 的 `dsh-client-locale` / `dsh-client-ui-settings`），实现时确认桌面 cordis 组合包含这两个插件。
- **行 order 冲突**：现有 General 行（language=0 等）order 唯一即可；取 10 不与现有冲突，可在实现阶段按实际行清单微调。
- **非桌面窗口**：`apply()` 的环境检查已保证设置行只在桌面窗口注册，浏览器/web 端不受影响。
- **命名空间常量可达性**：`DESKTOP_SETTINGS_NAMESPACE` 现定义于 host 入口 `src/index.ts`；客户端 bundle 不得从该入口导入（会拖入 host 代码）。实现时把 `settingsNamespace('dsh-desktop')` 的值收敛到 host 与客户端共用的纯模块（或在客户端侧独立求值同一字面量），保证两侧取到同一 namespace 字符串。
- **文案命名空间类型合并**：`settings.desktop` 需要像上游 locale 包那样 `declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { 'settings.desktop': DesktopSettingsLocaleKey } }`，使 `ctx.locale.register` 与 slot 的 `locale` 字段获得类型化键域。
