# @deepseek-ai/dsh-sandbox-windows-acl

[English](README.md) | 中文

面向 [harness 沙盒 seam](../sandbox/) 的 Windows 写入限制沙盒后端：一个 Node.js/[koffi](https://koffi.dev/) 实现的、对 [huoyaoyuan/windows-acl-restrict-poc](https://github.com/huoyaoyuan/windows-acl-restrict-poc)（`10e4dfb`，固定修订版本）机制的移植，挂载为 [`@deepseek-ai/dsh-sandbox-local`](../sandbox-local/) 链中报告 `enforcement: 'partial'` 的 win32 一级（`workspace-write` / `read-only` 两种模式）；Linux/macOS 后端在同一包中。

一句话机制：把调用者令牌复制为 `WRITE_RESTRICTED` 受限令牌，其 restricting SIDs 携带彼此独立的工作区能力与私有临时目录能力。工作区 SID 由规范工作区路径确定性派生（`workspaceWriteSid`），因此工作区根目录 ACE 每台机器每个工作区只物化一次，之后每次会话、调用或重启都命中精确 ACE 跳过。每个活跃的会话/工作区对则获得一个随机临时目录，以及一个从该路径派生的 SID（`tempWriteSid`），因此各会话共享预期的工作区权限，却不会继承彼此的临时目录权限。此后 Windows 只在「调用者正常权限」与「restricting SID 交集」同时允许时才放行写入。这些 SID 是主要白名单，在系统其余位置不授予任何权限；但该检查还会继承**其他** restricting SID 的环境写 ACE（保活组登录 SID + Everyone），而 NTFS ACL 属于文件对象而非路径。Everyone 与硬链接边界正是该档报告部分而非完整强制执行的原因。

直接构建在原生 ACL 机制上是记录在案的设计选择：它实现两种隔离模式，且不背负被否决的容器方案的问题——见[设计笔记](../../../.agents/notes/implemented/feature/2026-08-08-windows-acl-restricted-token-sandbox.md)（[mxc](https://github.com/microsoft/mxc/blob/main/docs/process-container/os-version-support.md) 要求 Windows 11 24H2 的 OS 下限，且任意路径读取需要整体改写宿主 DACL；AppContainer 根本无法任意路径读取）。

## 用法

```ts
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AclSandbox, tempWriteSid, workspaceWriteSid } from '@deepseek-ai/dsh-sandbox-windows-acl'

const workspaceRoot = process.cwd()
const tempDir = mkdtempSync(join(tmpdir(), 'dsh-'))

// mode selects the token's restricting-SID list (see Modes below) and must
// match the grant shape. workspace-write requires distinct workspace and
// private-temp identities; pass tempDir: null to disable temp writes.
const sandbox = new AclSandbox({
  writableDirs: [workspaceRoot],
  tempDir,
  writeSid: workspaceWriteSid(workspaceRoot),
  tempWriteSid: tempWriteSid(tempDir),
  mode: 'workspace-write',
})
await sandbox.init() // throws on ANY Win32 failure — never spawns unrestricted

const child = sandbox.spawn({ command: 'pwsh', args: ['-NoProfile', '-Command', '...'], cwd: workspaceRoot })
const { stdout, stderr, exitCode } = await child.wait()

sandbox.dispose() // revokes the revocable (temp) grant, keeps the standing workspace ACE; reports every cleanup failure
rmSync(tempDir, { recursive: true, force: true })
```

直接使用 `AclSandbox` 时，必须显式提供私有临时目录（或通过 `tempDir: null` 禁用临时写入；环境临时根目录绝不会被隐式授权），工作区 ACE 以**常驻**方式授予（`dispose()` 保留它们——它们是跨实例的复用缓存），不同的临时 SID 则以**可回收**方式授予。服务端复用则是 `AclWriteGrant` 类：每个目录一次 `add(path, standing)`，`dispose()` 撤销可回收路径并释放 SID——见下方 runner 契约。本包中的每个 Win32 API 调用都有检查；失败抛出 `Win32Error`，携带 API 名、精确 Win32 错误码、`FormatMessageW` 系统文本和失败的路径/上下文。这是刻意的：POC 忽略每个返回值，当 `CreateRestrictedToken` 失败时用完整无限制令牌静默运行子进程（fail-open）。本移植从构造上 fail-closed。

<a id="the-confinement-runner"></a>

## 隔离 runner

面向 seam 的形态是 **runner 入口**（`./runner`）：`@deepseek-ai/dsh-sandbox-local` 在调用者命令的位置 spawn 的 argv 前缀包装——与 bwrap/landlock-run/sandbox-exec 同一架构，因此沙盒 seam 的 `confine()` 契约无需改动。稳定的 argv 契约：

```sh
node runner.js --workspace <dir> --temp <dir> --mode <read-only|workspace-write> [--write-sid <S-1-4-…> --temp-write-sid <S-1-4-…>] -- <argv...>
```

runner 创建受限令牌，在它之下 spawn 包装后的 argv，调用者的 stdio 直接透传（调用者的管道在 spawn 前后被设为可继承——Node 在启动时清除 stdio 可继承性，裸 spawn 必须补偿这一点），通过 `STARTF_USESHOWWINDOW` 与 `SW_HIDE` 请求隐藏子窗口，把子进程包进 `KILL_ON_JOB_CLOSE` job（runner 死亡则子进程死亡），忽略自身的控制台 Ctrl+C 让子进程自行处理，镜像子进程的退出码，并在退出时撤销其自行管理的临时授权（工作区 ACE 常驻）。受限令牌无法使用 `CREATE_NO_WINDOW`，因此子进程继续共享宿主控制台；show-window 提示会抑制可见控制台界面，同时保留继承或重定向的 stdio。每个 runner 侧失败都会向 stderr 打印 `windows-acl-run: <detail>` 并以 127 退出——seam 的 `RUNNER_FAILURE_RULES` 匹配该签名，因此 runner 拒绝永远不会被误判为拒绝授权。

**工作区复用与临时隔离**：seam 先把确定性工作区 SID 的 ACE **常驻**物化（每个工作区每服务器生命周期一次，绝不撤销——它就是复用缓存），再为每个活跃的会话/工作区对创建随机私有临时目录和不同的可回收 SID。它把两种身份作为必须成对出现的 `--write-sid`/`--temp-write-sid` 传入；runner 对照各自所属路径验证二者，既不授权也不撤销（`manageDacls: false`）。fork 获得不同的临时能力；即使恢复的是同一会话，新的提供方也会给出新的路径和 SID，因此崩溃残留只是失效垃圾，而非冲突或继承的能力。如果不带这一对标志，`--temp` 指定的是根目录：无 agent（智能体）/独立的 workspace-write runner 会创建随机私有子目录，自行管理其临时 SID，重写 TMP/TEMP，并在退出时移除该子目录。工作区若等于或包含该根目录，会在任何授权前被拒绝，因为否则其可继承的工作区 ACE 会向每个私有子目录授权；直接 API 同样拒绝任何可写根目录与实际私有临时目录重叠。重启后重新授权常驻工作区 ACE 是幂等的：`grantWrite` 读取当前 DACL，当完全相同的 ACE 已存在时跳过 `SetNamedSecurityInfoW`（应用该 ACE 会把相同的 ACE 急切地重新传播到整棵树——大型工作区上以分钟计）。已知代价：大型工作区树的首次授权会阻塞整次急切传播，每台机器每个工作区一次。

模式（令牌的 restricting-SID 列表随模式而变；保活组登录 SID + Everyone 在**两种**模式下都存在——没有它们早期 DLL 初始化会以 `0xC0000142` 死亡、CNG 会让 pwsh 以 `0xE0434352` 崩溃）：
- `workspace-write`（登录 SID、Everyone、工作区 SID、临时 SID）：工作区与会话的**私有**临时子目录分别携带 Write 授权；受 ACL 管辖的其他写入都会被拒绝，已记录的 Everyone 与硬链接边界除外。
- `read-only`（登录 SID、Everyone——**不含**写入 SID）：不存在显式的写入 SID 授权。写入 SID 有意留在列表**之外**：先前 workspace-write 时期留下的常驻授权 ACE（`/permission` 降级，或崩溃后恢复的会话）在 read-only 下保持**失效**，因为 write-restricted 的 pass-2 检查只授予 restricting 列表所携带的内容——而常驻 ACE 让重新升级免于重新传播。Everyone 的环境权限仍构成已记录的部分强制执行边界。NUL 写入是**环境性**的、不是被授权的：设备 DACL 授予 Everyone 读+写+执行（`0x1201BF`），因此访问掩码落在其内的打开者（cmd 的 `> NUL`、node 的 `\\.\NUL`）在**两种**模式下都能写——只要 Everyone 还在保活组里，沙盒就无法把 NUL 设备归零。`Set-Content NUL` 在两种模式下都失败（PowerShell/.NET 层效应，由 read-only 套件钉住——拒绝方不是设备 DACL）；PowerShell 的 `> $null` 重定向不受影响（它直接丢弃、不打开 NUL）。

Authenticated Users 在**两种**列表中都不存在——WMI 命名空间安全检查失败（`0x80041003`），因此 CIM cmdlet 与 `Get-ComputerInfo`（它静默返回不完整结果而非报错）在**所有**受限模式下都不可用，且 C:\-root 树创建逃逸（常驻的 `AU:(AD)` + `AU:(OI)(CI)(IO)(M)` ACE）在两种模式下都被关闭——面向模型的表面记录的是该契约，而不是提示词承诺。INTERACTIVE/LOCAL 在两种列表中同样不存在：宿主的 Public 树向 INTERACTIVE 授予写权限，因此 Public 写入被拒绝——由 runner 的环境可写 Public 探针回归测试钉住（见设计笔记）。

`AclSandbox` 类（显式私有 `tempDir` + `tempWriteSid`，或用 `tempDir: null` 禁用临时写入）仍是直接 spawn 的编程 API；`AclWriteGrant` 是授权生命周期的服务端物化一半。

## 头部验证

所有常量、签名与结构体布局都在开发机上对照 Windows 头文件（MinGW `winnt.h` / `accctrl.h` / `aclapi.h` / `securitybaseapi.h` / `sddl.h` / `processthreadsapi.h` / `fileapi.h` / `namedpipeapi.h` / `synchapi.h` / `winbase.h`）验证过，并在运行时由 [`verify/abi-probe.cpp`](verify/abi-probe.cpp)（大小、偏移、枚举值、静态断言）交叉检查：

```sh
g++ -std=c++20 -municode -O2 -o abi-probe.exe verify/abi-probe.cpp -ladvapi32 && ./abi-probe.exe
```

koffi 结构体定义在模块加载时对照探针断言其大小，因此头文件/koffi 布局漂移会大声失败而不是破坏内存。

## 已验证边界（受限令牌固有，非本移植引入）

- **Everyone 授权仍是环境中的写权限来源。** Everyone 必须保留在两种 restricting 列表中：移除它会破坏早期 DLL 初始化与 CNG。因此，如果外部 NTFS 对象的正常 DACL 向 Everyone 授予所请求的写权限，它就会同时通过两次访问检查，并在两种模式下保持可写。真实 runner 套件配置一个外部 `Everyone:Modify` 目录并钉住该行为；提供方报告 `enforcement: 'partial'`，使调用方能够拒绝或向上暴露这项较弱的边界。
- **硬链接是文件对象别名，而非路径别名。** 传播到已有 NTFS 硬链接上的可继承工作区 ACE 会修改底层同一文件的安全描述符，因此同一对象也可通过外部别名写入。拒绝工作区中的所有多链接文件不具可行性，因为普通 pnpm 安装会使用硬链接指向其内容寻址存储；原生 runner 套件钉住该缺口，提供方的部分强制执行报告则点明其后果。
- **写入受限；读取、网络与进程可见性不受限。** `WRITE_RESTRICTED` 只交叉检查写访问，因此受限子进程可以读取调用者可读的任何文件并打开套接字。`read-only` 模式因而不能仅靠该机制表达；将其与读侧策略或 AppContainer/`S-1-15-2` capability 令牌配对以获得更强隔离。
- **控制台隔离不可用；可见子窗口会被抑制。** 在受限令牌下，以 `CREATE_NO_WINDOW` / `CREATE_NEW_CONSOLE` 创建的子进程在 DLL 初始化期间以 `STATUS_DLL_INIT_FAILED`（`0xC0000142`）死亡。POC 尝试把控制台登录 SID（`S-1-2-1`）加入 restricting 列表来修复；在 Windows 11 26200 上 `CreateWellKnownSid(WinLocalLogonSid)` 以 `ERROR_INVALID_PARAMETER`（87）失败，正确的 `WinConsoleLogonSid` 能产出合法 `S-1-2-1` 但子进程仍然死亡，POC 的最终修订同时移除了该 SID 与控制台隔离。子进程因此共享宿主控制台。两条 spawn 路径都会设置 `STARTF_USESHOWWINDOW` 与 `SW_HIDE`，同时保持 creation flags 不变，从而抑制可见子窗口并保留继承或重定向的 stdio。
- **ACL 授权是对真实目录的驻留改动。** 进程中途死亡会留下授权；工作区 ACE **按设计**常驻（绝不撤销——复用缓存），临时 ACE 由 `dispose()` 撤销（后续步骤失败时 `init()` 也会撤销已应用的临时授权）。POC 注释里的手工清理命令（`icacls <dir> /remove '*S-1-4-…'`）在本平台实测失败（`ERROR_NONE_MAPPED` 1332）——请通过本模块回收。工作区 ACE 在异常关闭后无需自愈：派生 SID 在下一次供给时重新命中常驻 ACE（跳过应用）；写入 SID ACE 不会因每次重启而累积第二个身份，因为身份**就是**工作区。
- **被授权目录必须由调用者拥有。** 所有者的隐式 `WRITE_DAC` 是沙盒无需提权即可编辑 DACL 的原因。
- **环境临时根目录绝不会被隐式授权。** 直接使用 `AclSandbox` 的 workspace-write 调用方必须提供一个已存在的私有 `tempDir` 及其不同的 `tempWriteSid`，或通过 `tempDir: null` 显式禁用临时写入。实际临时目录不得与任何可写根目录重叠。seam 会创建随机私有目录；无 agent runner 调用把 `--temp` 视为父根目录并自行创建随机子目录，但如果工作区等于或包含该父根目录，就会在任何 ACL 改动前拒绝调用。
- **受限子进程的临时能力按每个活跃的会话/工作区对私有。** runner 在 spawn 之前用 `SetEnvironmentVariableW` 把 TMP/TEMP 改写为该私有目录，子进程继承改写后的环境块（bwrap `--tmpfs /tmp` 的语义）。临时 ACE 与目录会在提供方 dispose 时移除，或在每次无 agent 调用后移除。崩溃可能留下失效的 `%TEMP%` 垃圾，但恢复后的提供方会选择新的随机路径和 SID，而不会与残留发生冲突或重新向其授权。原生 runner 套件证明，共享同一工作区 SID 的两个令牌无法写入彼此的临时目录。
- **受限令牌下 `whoami` 与令牌检查 cmdlet 会失败。** 子进程对复制令牌的 `GetTokenInformation` 部分不可用，因此 `whoami /all` 报错——这是限制方案的诊断噪音，不是运行故障；真正重要的拒绝面（文件写入）不受影响。

## 模型体验

间接地通过 [`dsh-bash-sandbox`](../../shell/bash-sandbox/README.md)、[`dsh-pwsh-sandbox`](../../shell/pwsh-sandbox/README.md) 及其工具呈现：它们渲染此后端的部分强制执行与拒绝事实（工具层通过 `denialSignatures` 分类的受限 stderr），而 [`dsh-sandbox`](../sandbox/README.md) seam 拥有 `SANDBOX_UNAVAILABLE` 文本与 runner 选择。

#### KV Cache 影响

无直接影响；拒绝面属于工具层。

## 已知限制与暂缓事项

- **每个工作区一个写入白名单** —— 写入 SID 是白名单的基本单位，且**就是**工作区身份；同一沙盒实例跨两个工作区复用时，两个根目录会互相扩大授权面（同一个 SID 将命名两个根）。请按工作区根目录各建一个实例——seam 正是这样做的，以工作区路径为键。
- **清理按设计尽力而为** —— `dispose()` 会尝试全部临时撤销并把失败聚合为 `AggregateError`；清理失败可能留下随机目录及其仅含临时 SID 的 ACE。进程退出后，不会再有令牌携带该 SID，因此残留保持失效，直到 OS 临时目录卫生或手动移除目录将其回收。
- **常驻工作区 ACE 是不可见残留。** 工作区改名会派生新的 SID；旧路径上的旧 ACE 留在原地（失效、仅含写入 SID）。未来的清理命令可以回收它们；它们不会引起任何重新传播。
- **NULL-DACL 目录在 grant+revoke 往返下不保持身份。** 带 NULL DACL 的目录（罕见——Windows 创建的目录都带真实 DACL）意味着「所有人完全控制」；`grantWrite` 从该 null 构建新 ACL，撤销往返后留下的是 EMPTY（全部拒绝）DACL 而非原始 NULL DACL。POC 行为相同；真实工作区与临时目录都带真实 DACL，因此这仍是记录在案的边界情形而非守护路径。
- **受限孙进程的管道 stdio 捕获不可用（named pipe 的默认 SD 模板）。** libuv 的管道 stdio 用的是 NAMED pipe；不带安全属性调用 `CreateNamedPipeW` 时，其默认安全描述符不是内核的模板，而是 Win32 层在用户态安装的默认 SD 模板（由 KernelBase 构建——owner/SYSTEM/Admins 全权，Everyone/ANONYMOUS 只读，即 [MS 文档](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights)记载的固定模板）——**不是**令牌默认 DACL（后者才是内核在原始 SD-null 创建时应用的）——因此 client 端打开所请求的写访问没有任何 restricting SID 被授予：受限进程内 `spawn(..., { stdio: 'pipe' })` 以 EPERM 失败，这是 POC 记载的 WRITE_RESTRICTED「无法重定向输出」边界。继承（`inherit`/fd）与忽略（`ignore`）stdio 的 spawn 可用；匿名管道（CreatePipe——令牌默认 DACL 的消费者，例如 PowerShell 的管道）因受限令牌默认 DACL 携带 restricting SID 全权 ACE（init 时写入）而可用。受限进程因此无法用管道捕获孙进程输出；必须捕获输出的工具无法在受限下运行。
- **授权物化是急切的全树传播。** 在带可继承 ACE 的目录上调用 `SetNamedSecurityInfoW` 会立即遍历每个后代（**不是**按访问惰性进行——大型工作区树上实测数十秒）。按工作区身份每台机器每个工作区只付一次（在首次受限执行时惰性进行，之后每次供给在精确 ACE 常驻时完全跳过）。私有临时目录创建时为空，因此其独立授权开销很小。如果工作区巨大，该主机上的第一次受限写入相应变慢。
- **读侧隔离与网络策略不在范围内** —— `WRITE_RESTRICTED` 只交叉检查写访问；将此后端与读侧策略配对以获得更强隔离。
- **宽目录与 FAT 卷警告已推迟；FAT 类目标保持可写。** 对异常宽的目录或 FAT 类（非 ACL）卷的 UI 侧警告尚未实现，且 FAT 卷作为授权**根**只会大声失败（无 ACL 支持）。授权根**之外**的 FAT 类目标则不同：它没有安全描述符，因此受限令牌的写检查通过（Everyone 在两种列表中都在）——此类目标在**两种**受限模式下都可写。FAT 被视为遗留残留——不受支持、不围绕它设计；此处记录的是这种仅警告的立场，而非缓解措施。
- **PowerShell 语言模式因受限模式而异。** 在 `read-only` 下，PowerShell 无法在临时目录中创建 AppLocker 探针文件，因此会保守地以 ConstrainedLanguage 启动：`Add-Type`（C# 编译、P/Invoke）、非核心 .NET 静态调用（`[System.IO.*]::`、`[math]::`、`[Environment]::`）、COM 对象与反射以 `Cannot create type` / `Cannot invoke method`（「only core types」）错误失败，且 `$ExecutionContext.SessionState.LanguageMode = 'FullLanguage'` 被拒绝。交付的 `workspace-write` 路径拥有私有临时目录能力，可使该探针完成，因此除非主机范围的 WDAC/AppLocker 策略另有规定，否则 pwsh 保持 FullLanguage；直接使用 `AclSandbox` 并配置 `tempDir: null` 时则没有这一保证，探针可能像 read-only 一样失败并按 fail-closed 处理。这一区别属于 PowerShell 启动行为，不是 ACL 写入边界的一部分。`pwsh` 工具描述向模型传授这些交付模式；`danger-full-access` 调用不受限地在 FullLanguage 下运行。
