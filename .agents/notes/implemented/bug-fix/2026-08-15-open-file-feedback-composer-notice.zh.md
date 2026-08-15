# Agent Note: 文件打开点击一律通过 composer 通知条报告结果

Status: implemented

[English](2026-08-15-open-file-feedback-composer-notice.md) | 中文

## 问题

点击「产物」文件 chip 或工具行的文件链接会调用 ui-conversation 聊天视图注入的 `openFile`，它把路径相对会话 cwd 解析后调用 `workspaces.openPath`，并用 `.catch(() => {})` 吞掉所有拒绝。因此一次失败看起来与死链接别无二致：点击毫无反应，任何层面都不出现错误。两种失败模式共享同一症状。在 PATH 中不存在 `powershell.exe` 的 Windows 主机上，`execFile` 以 ENOENT 拒绝，RPC 返回错误，而该错误被 `.catch` 丢弃。当默认程序存在但静默丢弃该请求时——某应用无法打开 WSL 的 `\\wsl.localhost` UNC 路径，却以退出码 0 结束——`openNativePath` 正常完成，RPC 报告 `{opened: true}`，每一层都认为打开成功。两者对用户可见的缺口相同：没有反馈，也没有原因。

## 决策

`openFile` 现在把两种结果都路由到按会话隔离的 composer 通知通道：`inputHub.shell(sessionId).notify(...)`——成功报告 `produced.open.succeeded`，失败报告 `produced.open.failed` 并携带抛出的错误信息。成功文案说「已把 {name} 交给系统打开」，绝不说「已打开」，因为 `opened: true` 无法区分真正的打开与静默丢弃的请求。失败文案携带宿主侧原因（`workspaces.openPath` 抛出 `path open failed: <message>`）。改动局限于 `openFile` 这一唯一入口；`(path) => void` 签名及所有消费方（ui-deliverables 的 chip、ui-tool 的工具行、「在文件夹中显示」）均保持不变。

通知通道只写不读——没有任何清除逻辑，导致通知条在 composer 上永久停留。通知条现在与 promptError 的 toast 一样是瞬态的：`SessionInputShell.clearNotice()` 清除 store，composer-bar 注入以 `clearNotice` 暴露它，InputBar 运行一个以 `seq` 为键的定时器——新通知到达时重启 6 秒保持期，否则到期关闭通知条。成功文案的尾句解释了为何没有弹出「选择软件」对话框：Windows 只对无关联的扩展名弹出选择框，因此没有窗口或选择框出现，说明该文件类型已有默认程序但打不开此路径；文案以完整路径收尾，方便用户手动打开该文件。

两项行为都由 `feedbackPatchEnabled()`（`src/client/fork-flags.ts`）门控：当该函数返回 false 时，`openFile` 回退到官方静默的 `.catch(() => {})`，注入的 `clearNotice` 变为空操作，恢复官方客户端行为。下一次合并上游时，把该函数改为 false——或直接删除整个 fork。

## 备选方案

**在聊天视图中新增 viewport 固定的 toast store 与横幅。** 不予采用：需要新增 store 与横幅机制，而「产物」行正下方就是 composer，通知条本就可见。现有通知通道本就是「detached command results and business notifications（分离的命令结果与业务通知）」的既定出口。

**让 `openFile` 返回 Promise，由每个消费方各自显示内联状态。** 不予采用：为达到相同的用户可见结果，需要改动 ui-conversation、ui-deliverables、ui-tool 三处的 owner-prop 契约及其约 12 个测试文件。

**对默认程序做更严格的宿主侧探测。** 不予采用：它检测不到「接受路径但静默失败（退出码 0）」的应用，而这正是 WSL/UNC 案例；对无关联扩展名，它会用产品报错取代系统「选择应用打开」对话框这个有用的交互。

## 后果

每次打开点击现在都会产生一条六秒后自动消失的 composer 通知——瞬态语义适用于所有通知条（命令失败、插话失败、文件打开），与 promptError 的 toast 一致。诚实的成功措辞让「静默失败的应用」这一情况首次可见：用户看到「已把 X 交给系统打开」但窗口未弹出，而文案尾句告诉他们该文件类型已有默认程序但打不开此路径，并给出完整路径供手动打开——指向默认程序而非产品本身。检测的天花板不变——以退出码 0 结束且什么都没显示的应用仍与真正的打开无法区分，这正是成功文案保持保守、选择说明而非声称的原因。无关联扩展名的场景保留其系统对话框。两项行为都随 `feedbackPatchEnabled()` 开关发布，可关闭以恢复官方客户端。单元覆盖位于 `apply-inject.client.spec.tsx`（成功、失败与开关关时的静默通知）、`input-bar.client.spec.tsx`（自动消失会清除 store；开关关时保留）；`apps/web/tests/produced-files.e2e.ts` 中的真实组合断言会点击 chip 并期望出现通知条。
