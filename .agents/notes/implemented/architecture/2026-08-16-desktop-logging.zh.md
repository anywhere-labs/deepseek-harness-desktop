# Agent Note: 桌面端文件日志

Status: implemented

[English](2026-08-16-desktop-logging.md) | 中文

## Problem

桌面端把 Cordis 根跑在 Electron 主进程内，所以每一条日志——经 `logger-console` 输出的 `ctx.logger`，以及 bootstrap 与 Electron 适配器里显式的 `process.stderr.write`——都落到进程的 stdout/stderr。打包后的 GUI 应用里这条流不可见，开发者与上报者拿不到日志。

## Decision

新增一个 Cordis `Exporter`，把格式化后的日志记录写到 `app.getPath('userData')/logs/` 下的文件，并通过 `ctx.logger.exporter(...)` 在桌面 bootstrap 里注册。它不包裹、不重定向 `console.*`、`process.stdout` 或 `process.stderr`。

三个模块实现它：

- `log-level.ts` —— 纯 verbosity 辅助：`LogType`、`LogLevel`、`shouldEmit(type, threshold)`、`isErrorType(type)`。
- `log-files.ts` —— 同步追加式 sink（`appendFileSync`），写 `dsh-YYYY-MM-DD.log`（全部级别）与 `dsh-YYYY-MM-DD.error.log`（warn 与 error）；单文件超过 10MB 滚到 `.1`、`.2` …；本地日期变化时切换文件；重启后从磁盘恢复当前分段；目录超过 200MB 时删除最旧的自有文件。
- `file-exporter.ts` —— `FileExporter implements Exporter`，把每条 `Message` 渲染成 `<本地时间戳> [LEVEL] [name] <body>`（经 `Logger.format`），按阈值过滤后路由到 sink。

`dsh-desktop.logLevel` 设置字段（`debug | info | warn | error`，默认 `info`）扩展已有的 `dsh-desktop` 命名空间。bootstrap 在 `boot()` 后读一次，并订阅 `settings/updated` 就地更新 exporter 阈值。

## Alternatives considered

**包裹 `console.*` 或 `process.stdout` / `process.stderr`。** sink 自身打印时会递归，`ctx.logger` 每一行会重复（console exporter 一次 + 流包裹一次），并破坏 Electron 的 devtools 与附加调试器控制台。Cordis 的 `Exporter` 接缝收到带 type、level、timestamp、name 的结构化 `Message`，文件目标完全不需要这些 hack。

**单个无上限日志文件。** 没有单文件与目录上限时，长时间运行或某个吵闹的插件会占满磁盘。按天命名 + 10MB 轮转 + 200MB 目录上限既限制了增长，又让日志可按日期与严重度查看。

**复用 console exporter 的渲染器。** 它带颜色、按 label 对齐，是为终端调过的；文件目标渲染更朴素的带时间戳行，让文件在编辑器里可读、可粘贴。

## Consequences

日志持久化到桌面用户数据目录，打包运行后也能排查。verbosity 阈值走标准设置服务配置，同时作用于全量文件与错误文件。`logLevel` 字段在启动时与 `settings/updated` 时读取，改动无需重启即生效。

每天日志以一条启动 header（app 版本、平台、Node 版本、运行时间戳）开头，并在启动时清理 7 天前的文件，配合 200MB 目录上限。写入过程中会持续执行容量上限，大小按 UTF-8 字节计算，过大的单条记录会在 Unicode code point 边界截断。清理只管理 `dsh-*.log` 命名，并容忍文件消失或被 Windows 临时锁定。日志目录如果是链接会被拒绝，链接或非文件占位项会被跳过；日志初始化失败时退化到脱敏后的 stderr，不阻断应用启动。

绕过 Cordis `ctx.logger` 的 Electron 主进程级错误通过 `DesktopLogger` 接口记录：`ElectronStderrLogger` 写入 sink 并镜像到 `process.stderr`（开发时可终端可见）。它被注入 `ElectronDesktopRuntime`，后者把原先的 `process.stderr.write` 调用、`launchWindowsUpdateInstaller` 的子进程错误、以及 `render-process-gone` / `did-fail-load` 渲染器事件都路由过去。`main.ts` 安装共享的 fail-loud rejection 路径和一个专用 `uncaughtException` 处理器；后者记录第一个致命错误后请求受控退出。Electron 的 `child-process-gone` 事件也会被记录，子进程与渲染器退出码同时保留有符号数值和十六进制位模式，使 `0xc0000005` 等 Windows NTSTATUS 保持可识别。sink 失败会退化到 stderr，不会覆盖原始错误。

JavaScript handler 无法在主进程原生崩溃后继续执行。因此 bootstrap 以 `uploadToServer: false` 启动 Electron Crashpad，只在本地保留 minidump，并在 `userData/crash-evidence/` 写 active-run 标记。受控退出会删除标记；下一次启动若发现残留或不可读标记，就记录为上一次进程未正常退出的证据。Crashpad 或标记初始化失败只写日志，不阻断启动。

所有进入文件边界的日志行都经过脱敏层，覆盖 `sk-` 风格 key、长 hex/base64 token、bearer/basic authorization、cookie header、带引号或不带引号的具名敏感字段（包括渲染后的 JSON），以及 HTTP URL 中的凭据或敏感 query 值。

默认 profile 加载 `dsh-plugin-desktop/diagnostics`，在 macOS 与 Windows 的原生托盘中提供 **Export Diagnostics…** 命令。创建归档前，`desktopRuntime.exportDiagnostics()` 会显示本地化隐私确认，说明日志可能包含本地路径与工作区/会话标识，崩溃转储可能包含进程内存片段。确认后的导出在短生命周期 Node worker 中运行，避免文件读取与压缩阻塞 Electron 主线程。Worker 优先纳入本地普通 `.dmp` 文件，再纳入最近的自有日志，两者共享 50MB 证据上限；同时加入系统信息摘要与被省略文件数量，把 zip 原子发布到 `userData/diagnostics/`，拒绝链接形式的输入、输出和崩溃转储目录，容忍文件消失或被锁，并只保留最新三份归档。Runtime 会合并并发请求，成功后在系统文件管理器中定位文件，失败时显示原生错误对话框。

带手动清空的设置页日志查看器尚未构建，作为后续项。
