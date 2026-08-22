# 托管式 WSL Host

[English](wsl-host.md)

Windows 版 DSH Desktop 可以把完整 DeepSeek Harness Host 放进指定的 WSL 2 发行版运行，同时让 Electron 窗口和操作系统集成继续原生运行在 Windows。这是一种“运行位置”选择，不是 Linux GUI 构建，也不是另一套远程控制产品。

## 先用通俗语言理解

DSH 大体可以分成两半：

- **Host** 是真正干活的引擎。它加载 Cordis 插件树、Profile、Agent、工具、工作区、终端 provider、HTTP 服务和 WebSocket 服务。
- **桌面壳** 是面向 Windows 的部分。它管理 Electron 窗口、托盘、原生对话框、通知、安装包更新和应用退出。

选择“本机 Host”时，两部分都在 Windows Electron 进程里。选择 WSL Host 后，引擎进入 Linux，桌面壳仍留在 Windows：

```text
Windows                                      WSL 2 发行版
┌──────────────────────────────┐             ┌──────────────────────────────┐
│ Electron 桌面壳              │  stdio RPC  │ 完整 DSH Host                │
│ 窗口 / 托盘 / 对话框         │◄───────────►│ Cordis / Profile / 插件      │
│ 通知 / 更新器                │             │ Agent / 工具 / 工作区        │
└──────────────┬───────────────┘             └──────────────┬───────────────┘
               │ BrowserWindow                              │ 127.0.0.1
               └────────────── HTTP + WebSocket ────────────┘
```

浏览器页面仍是普通 DSH Web 应用。WSL 通过 localhost forwarding 把 Host 的回环地址提供给 Windows，Electron 加载的就是这个完全相同的 origin。插件仍处于常规 DSH/Cordis 组合里，不存在另一份 Electron 插件清单。

## 这些专业名词是什么意思

| 名词 | 在这里的含义 |
| --- | --- |
| Host | 运行完整 DSH 后端和插件树的 Node.js 进程。 |
| Cordis | DSH 使用的生命周期与依赖组合框架。它按依赖关系启动插件，并把一次运行中的 effect 作为一个 generation 统一释放。 |
| Profile | 一套有名字的 DSH 配置和依赖集合，例如 `desktop` 或 `web`。本机 Host 与 WSL Host 各自保存 Profile。 |
| Renderer | Electron 窗口内隔离的 Chromium 页面进程。它显示 DSH Web UI，但不会得到原始 Node.js 或 Electron API。 |
| 控制通道 | 通过受控 WSL 子进程 stdin/stdout 传输的私有、带版本 JSON-lines RPC，不是一个监听中的网络端口。 |
| 健康门 | Host、Web 页面和原生窗口都成功启动的时刻。只有越过这道门，待定 Profile/Host 目标才会被记为“已知可用”。 |
| 发行版 | 一个已经安装的 WSL Linux 环境，例如 `Ubuntu-24.04`。 |
| ext4 存储 | WSL 原生 Linux 文件系统。它比 `/mnt/c` 更好地保持 Linux 路径、权限、链接、文件监听和性能语义。 |
| 运行时 bundle | 随 Windows 应用打包的目录，包含精确版本的 Desktop、Market、第一方补丁归档、npm 锁文件和用于部署 WSL 的 SHA-256 清单。 |

## 前置条件

托管式 WSL Host 只在原生 Windows DSH Desktop 启动中提供。被选发行版必须是 WSL 2，并且下面这些程序必须能被非交互式 `wsl.exe --exec` 直接找到：

- Linux Node.js `^22.19.0` 或 `>=24.0.0`；
- npm；
- GNU Bash；
- 可写的 Linux 用户主目录；
- 首次部署时能访问所配置 npm registry 的网络。

选择前可以在 PowerShell 中检查：

```powershell
wsl -d Ubuntu-24.04 -- node --version
wsl -d Ubuntu-24.04 -- npm --version
wsl -d Ubuntu-24.04 -- bash --version
```

三个命令都必须在不预先加载交互式 shell 配置的情况下成功。`nvm` 等版本管理器经常只在 `.bashrc` 中加入 Node；这不足以支持 `wsl.exe --exec node`。请让稳定的 Linux `node` 与 `npm` 出现在发行版的非交互 PATH 中，或用该发行版常规的管理员方式安装。

## 选择 Host 位置

1. 在 Windows 启动 DSH Desktop 并打开**设置**。
2. 进入 **Desktop** 分区，找到 **Host 位置**。
3. 选择**本机 Host**或一个 `WSL · <发行版>` 目标。
4. 确认变更。DSH Desktop 会原子保存整个目标选择，按顺序关闭当前 generation，然后重新启动。

这个选择作用于下一个完整 generation。DSH Desktop 不会把正在运行的 Cordis 树在两个操作系统之间热迁移。

从源码启动时，WSL 模式还要求用 `DSH_DESKTOP_WSL_BUNDLE_DIR` 指定预先生成的运行时 bundle。正式 Windows 安装包会把已校验 bundle 放在 `resources/wsl-runtime`，不依赖 npm 上是否发布了对应的 Desktop 或 Market 版本。

## 首次部署与数据位置

DSH Desktop 会先探测发行版、在 Windows 校验 bundle 的每个字节，再用 `wslpath` 转换路径，并把 bundle 复制到 WSL Linux 文件系统中的唯一 staging 目录。`npm ci` 只安装清单内锁定的依赖图。staging 中的 Host 版本与清单指纹通过校验后，才通过原子目录重命名成为当前 runtime；旧 runtime 会保留到新目录最终校验成功，以便失败时回滚。只有该精确指纹缺失或无效时才会重新部署。

托管路径都位于 Linux 用户主目录下：

```text
~/.local/share/dsh-desktop/runtime/<desktop-version>  精确版本的 Host package runtime
~/.local/share/dsh-desktop/home                       WSL DSH home 与 Profile
~/.local/state/dsh-desktop                            WSL launcher 状态
```

应用会用仅当前用户可访问的权限创建真实 home/state 目录。本机 Host Profile 仍在 Windows DSH home 中，WSL Host Profile 则在 WSL 中。切换目标不会复制、合并、删除或重新解释两边的数据。

Linux 项目建议放在发行版原生文件系统，例如 `/home/alice/projects/example`。这样 Linux 工具可以获得符合预期的权限、符号链接、大小写、文件监听和性能表现。

## 工作区与终端

Windows 文件夹选择器只接受被选发行版的 UNC 共享：

```text
\\wsl.localhost\Ubuntu-24.04\home\alice\projects\example
```

被选 UNC 路径会无损转换为 Linux 绝对路径，并在同一个发行版内部验证后才交给 DSH。其他发行版路径、Windows 盘符、普通文件或包含路径穿越的值都会被拒绝。拖放最终也经过同一 Host 侧验证边界。

**打开 DSH 终端**会启动 Windows Terminal，缺失时使用控制台回退，并直接进入被选发行版。终端会得到当前 WSL Profile、DSH home、托管 Node runtime 上下文和 Linux 工作目录。所有参数都作为固定 argv 传递；用户路径不会被拼接成 shell 程序。

## 跨边界的原生能力

插件看到的仍是普通 `desktopRuntime` capability。WSL 侧代理只转发那些必须留在 Windows 的操作：

- 窗口显示、隐藏、聚焦和 Renderer URL 挂载；
- 托盘项目与原生菜单动作；
- 目录选择和确认对话框；
- 隔离的 Profile 创建器、诊断隐私流程与恢复对话框；
- 通知、角标和任务栏提醒；
- 主题外观；
- 更新检查、下载和安装器交接；
- Profile/Host 目标重启与应用退出。

Windows 侧拥有真实 Electron 对象；WSL 侧拥有 DSH、Profile、插件包操作和工作区语义。这样既保留“能力通过插件组合”的 DSH 核心思想，也让操作系统 adapter 留在真正具有对应 OS API 的位置。

## 生命周期与恢复

启动采用两阶段健康规则：

1. Windows 部署并启动一个 WSL Host 子进程。
2. WSL Host 组合完整 Cordis 树并发布回环 Web endpoint。
3. Electron 挂载该 endpoint，并等待 Renderer 健康信号。
4. Windows 把 Profile generation 与 Host 目标一起提交为“已知可用”。

如果子进程在第 4 步前退出，选择不会被提交。原生恢复对话框会提供“切回本机 Host 并重启”或“退出”。WSL Profile 和数据都会保留。健康状态提交后，如果 WSL Host 意外退出，Windows 应用会有序关闭，而不会留下一个看似仍在运行的空壳。

越过健康门时，WSL 会像本机 Host 一样保存一份有大小限制的 Profile 配置检查点。用户显式请求**恢复最近一次成功的 Profile**时，系统先校验当前选择与 last-known-good，向页面返回已经接受的响应，然后停止 Cordis 树，再修改文件。Windows 会在不上传的前提下保存恢复诊断；WSL 恢复已封存的检查点，并针对 Linux Node ABI 执行 `pnpm install --frozen-lockfile`，成功后才提交选择并重启。如果恢复失败，错误仍由 Windows 原生恢复界面处理，并可安全切回本机 Host。非活动的 WSL Profile 也使用与本机 Profile 相同的选择状态、安装恢复事务、插件状态和检查点保护来删除。

正常退出按相反方向进行：Windows 发送有时限的 shutdown 请求，WSL Host 释放 Cordis generation，Windows 等待 `wsl.exe` 退出。Host 主动请求重启时，控制通道会先确认接收，再让 Windows 开始关闭，避免双方互相等待。超时路径有明确的 kill/exit 回退，防止任何一边无限期遗留另一边。

## 安全边界

- 控制协议带版本，每个 JSON-lines frame 上限为 1 MiB。
- 控制流量只经过受控子进程 stdio，不新增 TCP 控制监听端口。
- 进程使用 executable + argv API 启动，并设置 `shell: false`；固定脚本只通过位置参数接收值。
- DSH HTTP/WebSocket endpoint 仍仅绑定回环地址，Electron 导航仍被限制到精确 origin。
- WSL 发行版名称会被校验，并且必须来自当前 WSL 2 探测结果。
- 工作区被限制在所选发行版内，并在 Linux 中再次验证。
- WSL Host package 版本必须与 Windows desktop 版本完全一致。
- package graph 由 `package-lock.json` 固定；本地与补丁归档以及 package metadata 在跨入 WSL 前都由 SHA-256 清单封存。
- WSL stderr 会镜像到 Windows 应用日志，因此常规诊断可以看到启动和运行失败。

控制通道是同一个 desktop generation 启动并拥有的两个进程之间的可信内部 capability 边界。它不是通用 Remote Host API，因此不会作为公开 package subpath 导出。

## 开发与验证

在仓库根目录构建并运行无界面 gate：

```sh
corepack yarn workspace dsh-plugin-desktop build
corepack yarn workspace dsh-plugin-desktop typecheck
corepack yarn workspace dsh-plugin-desktop test
corepack yarn workspace dsh-plugin-desktop verify:closure
```

package build 会生成私有 `lib/wsl-host.js` 入口。打包校验要求应用归档包含该入口及其完整 runtime closure，但 `package.json` 有意不导出 `./wsl-host`。

测试源码构建时，先构建两个 workspace，生成与正式打包相同的校验 bundle，再让 Windows 进程指向这个 Windows 目录：

```powershell
corepack.cmd yarn workspace dsh-community-market build
corepack.cmd yarn workspace dsh-plugin-desktop build
node .\dsh-plugin-desktop\scripts\wsl-runtime-bundle.ts .\dsh-plugin-desktop\build\wsl-runtime
$env:DSH_DESKTOP_WSL_BUNDLE_DIR=(Resolve-Path .\dsh-plugin-desktop\build\wsl-runtime).Path
node .\dsh-plugin-desktop\lib\bin.js
```

bundle 版本和清单中的每个 hash 都必须与应用版本匹配。这个显式变量可以防止开发构建静默安装无关或过期的 package graph。

## 故障排查

- **没有发行版可选：**确认 `wsl --list --verbose` 报告的版本为 `2`，然后重启 DSH Desktop。
- **Node.js 前置条件错误：**运行上面的三条 PowerShell 检查。只有执行 `source ~/.nvm/nvm.sh` 后才出现的 Node 对托管 launcher 不可见。
- **部署失败：**检查发行版的 npm registry/网络访问和 Windows DSH Desktop 日志。外部依赖按 bundle 内的锁文件下载；未发布的第一方 package 直接来自 bundle。UI 中的安装错误会被净化，详细子进程 stderr 会写入日志。
- **工作区被拒绝：**请选择 `\\wsl.localhost\<被选发行版>\...` 下的目录，不要选择 `C:\...` 或另一个发行版。
- **看不到本机数据：**本机 Host 与 WSL Host 有意使用不同 DSH home。切回原 Host 即可；系统不会自动迁移数据。
- **WSL Host 启动后退出：**导出普通 Desktop 诊断；Windows 日志文件中包含 WSL stderr。
