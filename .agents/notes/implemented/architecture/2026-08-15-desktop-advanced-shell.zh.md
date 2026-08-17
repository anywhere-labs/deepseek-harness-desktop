# Agent Note: Desktop 高级 Shell

Status: implemented

[English](2026-08-15-desktop-advanced-shell.md) | 中文

## Problem

DSH Desktop 需要在 macOS 与 Windows 上提供原生桌面呈现（包括 Windows 系统材质），但不能编辑 pinned 上游 checkout，也不能复制官方 Web 应用。该呈现会同时改变多个维度：原生窗口构造、root/sidebar slot 所有权、`layout` service 与 document 级 theme 投影。如果只应用其中一部分，或在正在运行的 renderer 中改变它们，Host 组合与 Client 呈现就会不一致。

无论用户选择应用托盘命令，还是手工编辑 settings 文件，模式选择都必须使用同一个持久化事实源，并让每次修改跨越相同的重启边界。

## Decision

高级模式是由 `dsh-desktop.mode: advanced` 选中的完整 desktop 自有 generation。它仍然使用上游 loopback Web carrier 与普通 Client 模块 Loader；只改变明确由 desktop 拥有的呈现与原生窗口 seam。

### 一个 settings 事实源

DSH home `settings.yaml` 文档是单一事实源。Launcher 通过当前 `@deepseek-ai/dsh-settings-file` row 解析该文件，并在生成最终 Loader patch 之前读取 `dsh-desktop.mode`。它不会在 profile manifest、Electron preference、命令行 flag 或其他 desktop 文件中持久化平行的模式值。

`desktop-shell` Host plugin 使用包含 `mode: compatibility | advanced` 的 schema 与 `applies: restart` 来注册 `settingsNamespace('dsh-desktop')`。托盘调用该已注册 scope 范围受限的 `settings.update({ mode })` 路径。用户也可以直接编辑同一份 `settings.yaml` 文档；file provider 与已注册 namespace 会观察这个唯一的持久化值。

Linux 只支持兼容模式。托盘会在该平台禁用模式命令，advanced 值也会被拒绝，而不会映射到另一种呈现。

### 重启是组合边界

Settings watcher 会比较已提交模式与当前 generation，并在两者不同时请求一次 Electron 重启。Restart coordinator 会把 exit 标记为 relaunch，然后进入普通的有界 shutdown 路径。Cordis disposal 首先释放 Client effect、Host row、托盘与 `BrowserWindow`；仅当该 generation 以零代码完成最终退出时才调用 `app.relaunch()`。失败 generation 会直接退出而不 relaunch，重复 restart 请求是幂等的，现有强制 shutdown 截止时间仍会给 disposal 设限。

应用绝不会热切换模式。原生材质选项在 `BrowserWindow` 构造时固定，当前 Client graph 必须与启动前所选的 Loader row 与 root slot 声明保持一致。

### 高级 Client 组合

在 bundle、profile 与 home patch 完成组合后，Launcher 会验证预期官方 row 身份。其最终高级 overlay 禁用官方 `ui-layout` row，并明确保持 `ui-sidebar` 与 `ui-conversation` 启用。兼容模式会保持三个官方 row 全部启用。

desktop Client 会在安装高级 effect 前校验 Host 提供的模式与平台 URL marker。它通过 Cordis reflection 在一个 plugin fiber 生命期内提供由 `DesktopLayoutState` 支撑的 `layout` service。该 service 拥有 sidebar toggle 与 details open/close transition，并与安装它的同一 effect 一起消失。

Client 注册 `root` occupant，并为 `sidebar`、`conversation`、`details` 与纯新增 `shell.overlay` entry 声明子 seat。不变的官方 `ui-sidebar` 会继续作为 sidebar occupant，并保留其 workspace、settings 与纯新增 footer-action seat 的所有权。不变的 `ui-conversation` plugin 继续拥有 conversation 与 details surface。第三方 feature 可以向与兼容模式相同的已文档化 seat 贡献内容。

desktop frame 只拥有几何与 chrome：可折叠 sidebar 列、中心宽度下限、可选 details 列、resize handle 与原生 drag region。它不会复制 sidebar 控件、session、workspace、conversation、settings 或 feature 状态。

### Theme 投影

禁用官方 layout 会移除通常把当前 theme 投影到 document 的呈现层。因此，高级模式包含一个范围受限的 `DesktopThemePresenter`。它会读取普通上游 theme service，把解析后的 color scheme 与 token 值应用到 document，维护深色 theme marker 与 `theme-color` metadata，并订阅标准 `theme/change` 事件。Disposal 只会移除由该 presenter 拥有的 attribute、token 与 metadata。

原生 adapter 会在 Host boot 完成后单独读取已注册的 `ui-theme.preference`，并在构造高级窗口前把内置 `light`、`dark` 或 `system` 值应用到 Electron。它会在当前 generation 内观察已提交的 preference 变化，使原生窗口框架与 Windows 材质使用和内置 Client theme 相同的外观来源。释放 generation 会恢复此前的 Electron 外观。仅存在于 Client 的第三方 theme id 没有可同步的 Host preference，因此不会改变原生外观。

### 原生材质

在 macOS 上，高级 `BrowserWindow` 使用 `titleBarStyle: hiddenInset` 与定位后的红黄绿按钮，同时不设置 Electron 透明、vibrancy 或 visual-effect 选项。不透明 renderer 会保留官方 sidebar-fill token，并在 desktop 自有 sidebar surface 上绘制该填充色。因此壁纸颜色不会改变 sidebar 对比度，renderer 也不需要持续合成到原生模糊层之上。其 90 CSS 像素收起列会把官方 56 像素 rail 居中。Sidebar surface 本身不可拖动，内容上方且位于红绿灯右侧的 desktop 自有无绘制条则提供 32 CSS 像素窗口拖动目标。另一条 caption row 会在 conversation 与 details 两列上方保留 20 CSS 像素间距，同时让无绘制的原生拖动命中区域也维持 32 CSS 像素高度。desktop shell 因此可以保留紧凑视觉间距，而无需检查或重排 feature 自有 Header 节点。语义化控件与显式 no-drag contribution 仍可交互；顶部 32 像素内的自定义 pointer target 必须退出原生拖动区域。

desktop sidebar surface 会在 macOS 上保留官方不透明 sidebar-fill token。因此官方 sidebar 与 session 列表会保留与 Web client 相同的组件行为、滚动、间距、渐隐和填充色。只有 Windows surface 会把该 token 局部设为透明，使平台 Mica 材质保持可见。

在 Windows 上，高级窗口使用带原生标题栏 overlay 控件的隐藏标题栏、透明背景、`backgroundMaterial: mica`、原生阴影、圆角与粗可调整边框。Electron 在 Windows 11 22H2 及以上版本支持由系统绘制的该材质。官方 sidebar 会保留兼容模式的几何与过渡，包括 56 像素紧凑 rail 和 280 像素默认展开宽度，同时由透明 surface 透出 Mica。Desktop frame 会在 conversation 与 details 两列上方拥有一个标准高度的 32 CSS 像素 caption row，在该行内避让原生控件区域，并把两个完整 slot surface 放到下一行。该 caption 几何不会检查或重排 feature 自有的 Header 节点，因此上游与第三方 slot contribution 会整体移动。控件、输入框、对话框与交互内容仍然不可拖动。

高级模式不支持 Linux。Host 校验、托盘与原生窗口构造器都会强制同一边界，而不会静默降级。

## Security and carrier boundary

高级模式不会向 renderer 添加 preload script、Electron IPC transport 或 Node 能力。它保留 `contextIsolation`、Chromium sandbox、禁用 Node integration、精确 loopback origin 导航，以及把外部链接委托给操作系统的行为。HTTP/WebSocket carrier 与第三方 package 发现路径与兼容模式相同。

## Verification

Profile 测试会向临时 `settings.yaml` 写入 `dsh-desktop.mode: advanced`，并验证它被投影到 `desktop-shell`、官方 layout 已禁用，以及官方 sidebar 与 conversation row 已启用。Host 测试覆盖共享 settings namespace、值变化后重启、托盘更新路径，以及持久化前的 Linux 拒绝。Client 测试覆盖 environment 校验、作用域化 layout-service disposal、平台专属 rail 几何、Windows 外层 slot caption 几何与 theme 投影。类型检查会根据已发布 rc.6 slot 与 service contract 验证 desktop 声明。

窗口选项与 Electron-runtime 测试验证 macOS hidden-inset 不透明窗口装饰未启用透明或 vibrancy、Windows Mica/原生控件、内置原生 theme 初始化与实时更新、generation 范围的外观恢复、Linux 拒绝，以及托盘更新到相反模式。Client 样式测试验证 macOS 使用官方 sidebar 填充色，而 Windows 使用局部透明填充。Shutdown 测试验证仅在成功零退出码 disposal 后 relaunch，且失败 generation 不会 relaunch。Client 与 Host bundle 均可 headless 构建；图形化原生外观与目标机器性能仍是目标机器验证边界。

### 目标机器性能调查

在 macOS Electron 43.4.0 / Chrome 150 目标机器上，A/B 测试使用了两个相互隔离的 360 轮合成会话。加载全部旧历史后，每个当前 conversation 会投影出 1,080 个 chat node。测试以精确的 `origin/master` 为基线，与本次不透明实现对比；两组均使用隔离的 `DSH_HOME` 和 user-data 目录、自动化会话导航、renderer/GPU 进程 CPU 统计以及浏览器级 Chromium trace。一次带 trace 的区间证明外部物理滚轮输入会污染空闲样本，因此无 trace 复测中屏蔽了滚轮输入。

完整透明链路带来了可重复的冷打开开销：基线首次打开较大会话耗时 427–439 ms，本次改动后为 161–165 ms；在该合成场景中减少约 270 ms（62%）。另做的两组混合测试——原生透明/vibrancy 窗口配不透明 Client 填充，以及不透明原生窗口配透明 Client CSS——均为 159–167 ms。也就是说，额外冷打开开销只有在透明 `BrowserWindow` 与透明 renderer 表面同时存在、形成完整透传合成链路时才出现；移除这条完整链路是本次决策可以实测到的收益。

同一实验没有复现 issue 报告的 renderer 持续空闲 CPU 15–55%。关闭 trace 并屏蔽滚轮输入后，基线和不透明 advanced renderer 的空闲 CPU 分别为单核的 0.064% 和 0.055%。两种实现的热切换都维持在约 0.49 s，并会占满一个 renderer 核。Compatibility mode 也复现了同样行为（p50 为 471 ms，单个 renderer 核约 98%）；trace 将主要工作归因于未修改的上游 conversation view：它通过 `ChatNodeSeat` 实体化 `order` 中的每个 key。因此，本 PR 只声明视觉修复和冷合成开销下降；conversation 虚拟化或保留已挂载 view 应作为独立的上游性能改动。这些目标机器数据仅描述该合成场景，不构成发布性能预算。

## Alternatives considered

**就地 patch 官方 layout 或 sidebar。** 这会修改上游拥有的实现，或让浏览器 DSH 依赖 Electron 呈现规则。只替换 layout row，并把官方 sidebar 承载在透明的 desktop 自有 surface 中，可以保留组件兼容性。

**保持官方 layout 激活，仅 shadow 其 root occupant。** 官方 plugin 仍会提供 `layout` service 并拥有 root 子声明，从而造成分裂所有权与含糊 disposal。高级模式会替换该 service 与 root 声明，同时保持独立 sidebar occupant 启用。

**把 conversation、workspace 或其他 feature surface 复制到 desktop package。** 这些是 feature surface，而非 desktop chrome。保持它们的官方 plugin 激活可避免重复状态，并让上游与第三方改进继续流入 desktop 组合。

**从托盘写入单独 Electron preference。** 两个 store 可能不一致。因此，托盘会更新 Host 已注册的 `dsh-desktop` namespace，手工修改也会指向同一份 `settings.yaml` 文档。

**更改模式后热重载 Client shell。** 这无法原子地重建原生窗口材质、Loader row、service 所有权与 root 声明。有界 relaunch 是最小一致 transition。

**保留 macOS sidebar vibrancy。** 原生模糊会让壁纸颜色进入导航 surface，降低官方 Web 填充色原本可预测的对比度，并在 renderer 大规模更新时增加一层持续工作的 compositor。macOS 不透明窗口装饰仍保留高级布局与 hidden-inset 控件，同时恢复确定的主题色和更简单的合成路径。

**在 Linux 上提供不带原生材质的高级模式。** 持久化同一个模式名，却在平台上使用实质不同的语义，会让配置产生误导。在存在明确 Linux 高级设计前，Linux 只暴露兼容模式。

## Consequences

DSH Desktop 在不修改上游 submodule、不复制 Web 应用，也不引入第二套插件或 transport 系统的前提下，获得了 macOS 原生窗口框架与 Windows 原生材质呈现。托盘修改与手工编辑 `settings.yaml` 会聚合到一个持久化值，重启会创建一个一致的 Host、Client 与原生窗口 generation。

desktop package 现在拥有真实 Client 呈现代码，并且必须跟踪它使用的已发布 slot、theme 与 service contract。高级模式按设计与浏览器 Web 及兼容模式具有不同的呈现 row 组合。原生外观也取决于操作系统支持，必须在真实目标机器上验证；Linux 仍只支持兼容模式。
