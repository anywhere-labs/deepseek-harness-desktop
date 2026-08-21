# 桌面端架构图册

状态：当前版本架构快照

[English](2026-08-19-desktop-system-architecture-atlas.md) | 中文

> [!WARNING]
> AI 读取要求：本文件记录特定版本和时间点的架构，不得直接视为当前实现，也不得盲目认同其中结论。回答架构问题或修改代码前，先核对基线提交之后的代码、implemented Agent Note 和测试。发生冲突时，以当前代码和已批准的架构决策为准。

- 产品版本：`2.0.1`
- 复核基线：`2d07129ee622`
- 快照时间：`2026-08-19 21:20:57 +08:00`（Asia/Shanghai）
- 有效范围：该基线上的桌面端仓库与运行时架构；后续架构变更可能使部分内容过期。

## 目的与读法

本图册从十个角度记录桌面端架构，范围包括 module、interface、implementation、owner、进程边界和持久化提交点，不展开全部类。实线表示调用或装配，虚线表示事件、证据或构建输入；箭头表示依赖方向，不表示数据流方向。

当前架构包含四层：Electron 原生壳、Cordis Host、上游 Web Renderer、跨重启可恢复的本地状态。架构约束为：桌面分支不修改上游 checkout；Renderer 不获得 Node/Electron 权限；profile、安装和 native generation 分别由单一 owner 管理；Renderer healthy evidence 与 native mount 同时成立后提交启动成功。

## 1. 系统上下文

```mermaid
flowchart LR
  User[用户] -->|窗口、托盘、系统对话框| Desktop[DSH Desktop]
  Desktop -->|HTTP / WebSocket，仅 loopback| LocalWeb[本地 DSH Web carrier]
  Desktop -->|读写 profile 与 settings| Home[DSH home]
  Desktop -->|显式选择并校验| Workspace[本地 workspace]
  Desktop -->|受管 argv 子进程| Runtime[打包的 DSH / pnpm / terminal]
  Desktop -->|版本检查与安装包下载| Release[审核过的 release endpoint]
  Desktop -->|目录源与 npm 元数据| Catalog[社区目录 / npm registry]
  Desktop -->|本地 dump，不自动上传| Crashpad[Electron Crashpad]
  Upstream[pinned deepseek-harness] -. 构建输入 .-> Desktop
```

边界：网络内容经 Host 校验后进入产品状态；本地诊断默认保存在本机；`deepseek-harness/` 作为构建输入，不属于桌面功能分支的修改范围。

## 2. 仓库 ownership

```mermaid
flowchart TB
  Root[根 Yarn workspace] --> DesktopPkg[dsh-plugin-desktop]
  Root --> Market[dsh-community-market]
  Root --> Fabric[dsh-community-fabric]
  Root --> Upstream[deepseek-harness submodule]
  DesktopPkg --> Main[Electron bootstrap / Host services]
  DesktopPkg --> Client[Desktop Client face / native shell]
  DesktopPkg --> Packaging[packaging / release gates]
  Market --> Catalog[目录、安装意图、receipt ledger]
  Fabric --> RFC[互操作 RFC scaffold]
  Upstream --> Official[官方 Host / Client / Web carrier]
  Root -. root scripts enter pnpm workspace .-> Upstream
```

`dsh-plugin-desktop` 拥有桌面产品；`dsh-community-market` 拥有社区目录和用户驱动的插件操作；Fabric 和 Market 在运行时实现完成前不声明可加载入口；上游保留独立的 pnpm workspace。

## 3. 进程与运行拓扑

```mermaid
flowchart LR
  subgraph MainProcess[Electron Main process]
    Launcher[main.ts 启动协调]
    Generation[DesktopStartupGeneration]
    Host[Cordis Host]
    Runtime[ElectronDesktopRuntime]
    Health[DesktopRendererHealthGate]
    Shell[ElectronShellGeneration]
    Services[Profiles / pnpm / updates / diagnostics / market]
    Web[loopback HTTP + WebSocket]
    Launcher --> Generation
    Launcher --> Host --> Services
    Generation -. owns lifetime .-> Host
    Generation --> Resources[packaged pnpm / DSH runtime resources]
    Launcher --> Runtime --> Shell
    Runtime --> Health
    Host --> Web
  end
  subgraph RendererProcess[Sandboxed Renderer]
    Loader[上游 Client loader]
    UI[官方 UI + desktop-owned slots]
    Loader --> UI
  end
  subgraph Children[受管子进程]
    CLI[DSH CLI]
    PNPM[pnpm / package lifecycle]
    PTY[terminal PTY]
    Worker[diagnostics worker]
  end
  Web <-->|same-origin HTTP / WS| Loader
  Services -->|argv，非 shell text| CLI
  Services --> PNPM
  Services --> PTY
  Services --> Worker
  Shell -->|BrowserWindow / Tray / native dialogs| OS[操作系统]
  MainProcess -. local crash dumps .-> Crashpad[Crashpad process]
```

Renderer 使用 `contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`。产品 carrier 使用 loopback HTTP/WebSocket，不使用 preload IPC；本地权限位于 Main/Host 和受管子进程。

## 4. module 依赖与调用方向

```mermaid
flowchart TB
  Main[main.ts composition root] --> Profile[prepareDesktopProfile]
  Main --> Boot["@deepseek-ai/dsh-app-boot"]
  Main --> Runtime[ElectronDesktopRuntime facade]
  Main --> Startup[DesktopStartupGeneration deep module]
  Runtime --> Generation[ElectronShellGeneration deep module]
  Runtime --> Platform[ElectronPlatformStrategy seam]
  Runtime --> Health[DesktopRendererHealthGate deep module]
  Startup --> Lifetime[Host + packaged runtime lifetime]
  Boot --> Host[Host plugin graph]
  Host --> Public[DesktopRuntime / DesktopProfiles / DesktopPnpm interfaces]
  Public --> Impl[Electron + profile + package implementations]
  Host --> Market[Community Market Host face]
  Market --> Consumer[consumer-owned capability interfaces]
  Consumer -. structural compatibility .-> Public
  Host --> Carrier[upstream Web carrier]
  Carrier --> Client[upstream Client loader]
  Client --> Compat[Compatibility: official layout owns presentation]
  Client --> Advanced[Advanced: desktop root/layout, official feature slots]
```

三个 seam 分别为 Host 面向的 Desktop services、native generation 和 platform adapter。Market 使用 consumer-owned interface，避免形成 Market 到 Desktop 类型的反向依赖。

## 5. 启动生命周期

```mermaid
sequenceDiagram
  participant Main as Electron Main
  participant Generation as Startup generation
  participant State as Desktop private state
  participant Host as Cordis Host
  participant Shell as Native shell generation
  participant Renderer as Sandboxed Renderer

  Main->>Main: electron-ready / shell-environment
  Main->>State: begin active-run + lifecycle evidence
  Main->>Main: runtime-bootstrap
  Main->>Generation: own packaged runtime resources
  Main->>State: consume pending profile
  Main->>State: claim install-recovery WAL
  alt recovery choice required
    Main->>Main: open Host-independent recovery window
  else startup may continue
    Main->>Main: compose profile patches
    Main->>Host: boot Host and provide Desktop services
    Main->>Generation: bindHost(Host)
    Host->>Shell: schedule shell spec
    Main->>Shell: mountScheduled()
    Shell->>Renderer: load loopback URL
    Renderer-->>Shell: settled Loader boot report
    Shell->>Main: forward report + native mount evidence to health gate
    alt healthy
      Main->>State: health gate commits install/profile health
      Main->>State: complete lifecycle evidence
    else failed or timeout
      Main->>Generation: quiesceForRecovery()
      Generation->>Host: dispose before mutable recovery
      Main->>State: record failure / choose recovery route
    end
  end
```

`BrowserWindow.loadURL()` 成功表示页面加载完成，不表示应用健康。Health gate 在 Renderer Loader 报告 `healthy` 且 native mount 完成后执行提交；提交前保留回滚能力。

## 6. 状态流转

### Profile selection

```mermaid
stateDiagram-v2
  [*] --> KnownGood
  KnownGood --> Pending: select(name) + persist
  Pending --> Verifying: next generation consumes pending
  Verifying --> KnownGood: Renderer healthy / markHealthy
  Verifying --> Rollback: startup failed
  Rollback --> KnownGood: relaunch lastKnownGood
  Pending --> Rollback: pending unavailable or invalid
```

### Plugin install recovery

```mermaid
stateDiagram-v2
  [*] --> Prepared: snapshot 3 profile files + WAL
  Prepared --> Applying: spawn exact package@version
  Applying --> Sealed: process tree success + post-image
  Applying --> RolledBack: command failure + restore before-image
  Sealed --> Verifying: next generation claims WAL
  Verifying --> Verified: Renderer healthy
  Verifying --> RecoveryChoice: startup failed or timed out
  RecoveryChoice --> RolledBack: user-authorized restore
  RecoveryChoice --> Verifying: one retry
  RolledBack --> [*]: receipt reconciled + notice persisted
  Verified --> [*]: WAL cleared
```

Profile 与 plugin install 使用独立状态机，共享同一健康结果。进程退出码 0 不作为 Renderer 健康证据；旧 generation 无权修改新 generation 的事务。

## 7. 数据与持久化 ownership

```mermaid
flowchart LR
  Settings[DSH home/settings.yaml] -->|settings providers own| Host[Host settings scopes]
  Profiles[DSH home/profiles/name] -->|upstream manifest / lock / patch| Profile[Profile composition]
  Selection[userData/profile-selection/state.json] -->|Desktop profile manager| Main[Launcher]
  PluginState[userData/plugin-management/state.json] -->|DesktopPluginsService| Recovery[Plugin recovery UI]
  WAL[userData/plugin-install-recovery/state.json + backups] -->|InstallRecoveryStore| Pnpm[DesktopPnpm]
  Update[userData/updates/state.json + artifacts] -->|updates adapter| Updates[Update plugin]
  Evidence[userData/lifecycle-events/startup.jsonl] -->|LifecycleRecorder| Diagnostics[Diagnostics export]
  Logs[userData/logs] -->|LogFileSink / Cordis exporter| Diagnostics
  Crash[userData/crash-evidence + crashDumps] -->|Crash evidence / Crashpad| Diagnostics
  Receipts[settings: dsh-community-market.installReceipts] -->|MarketInstallService| Market[Market]
```

SoC 边界：Desktop WAL 记录可恢复的文件状态，Market receipt 记录安装操作的所有权。两者通过 `receiptId` 关联，各自独立提交。

## 8. 插件装配与扩展点

```mermaid
flowchart TB
  Base[官方 Web bundle] --> Patch[cordis.patch.yml]
  Patch --> Shell[desktop-shell]
  Patch --> Market[community-market]
  Patch --> Terminal[desktop-terminal]
  Patch --> Diagnostics[desktop-diagnostics]
  Patch --> Notifications[desktop-notifications]
  Patch --> Pnpm[desktop-pnpm]
  Patch --> Profiles[desktop-profiles]
  Patch --> Updates[desktop-updates]
  Shell --> Mode{dsh-desktop.mode}
  Mode -->|compatibility| Official[官方 layout/sidebar/conversation]
  Mode -->|advanced, Windows/macOS| DesktopLayout[Desktop root + layout + native material]
  DesktopLayout --> OfficialFeatures[官方 sidebar/conversation 继续拥有 feature state]
  ThirdParty[第三方 dsh.client] --> Official
  ThirdParty --> OfficialFeatures
```

模式切换以 generation 为边界，通过完整 restart 生效，不支持运行时热切换。Advanced 接管 chrome、geometry 和声明的 slot，不复制 workspace、session、conversation 等上游 feature state。

## 9. 失败传播、恢复与信任流

```mermaid
flowchart LR
  Remote[远端目录 / npm / release] --> Verify[Host allowlist、origin、schema、version、integrity 校验]
  Renderer[Renderer 请求] --> SameOrigin[same-origin + method + bounded payload]
  SameOrigin --> Intent[短时 preview / intent token]
  Verify --> Intent
  Intent --> Owner[Host-owned operation]
  Owner --> Gate[单操作 gate + AbortSignal]
  Gate --> Child[argv 子进程]
  Child -->|success| Commit[receipt / WAL / health commit]
  Child -->|failure| Restore[rollback 或 manual-recovery-required]
  Commit --> Restart[有界 shutdown + restart]
  Restore --> Recovery[Host-independent recovery window]
  Evidence[masked logs + lifecycle + local dumps] -. 诊断，不授予权限 .-> Recovery
```

诊断证据用于解释失败，不授予恢复权限。涉及 profile 写入的恢复操作在 Host quiesce 后执行；远端 provider、Renderer package spec 和 shell text 不直接越过 Host owner。

## 10. 平台与交付

```mermaid
flowchart TB
  Source[Outer Yarn workspace] --> Gate[build + typecheck + unit tests + layout checks]
  Gate --> Package[electron-builder packaging]
  Package --> Win[Windows installer / portable]
  Package --> Mac[macOS app / installer]
  Package --> Linux[Linux compatibility runtime]
  Strategy[ElectronPlatformStrategy] --> Win
  Strategy --> Mac
  Strategy --> Linux
  Win --> WCap[advanced + picker + update download + Mica]
  Mac --> MCap[advanced + update download + vibrancy]
  Linux --> LCap[compatibility only; explicit unsupported capabilities]
  Upstream[pinned submodule] -. root upstream:* scripts .-> Gate
```

Headless gate 证明构建、类型、逻辑、Loader 和 packaged closure；真实系统验证仍负责 native material、系统对话框、托盘、安装器和权限集成。

## 架构评估

### 当前架构属性

- `ElectronShellGeneration` 通过小 interface 管理 window、tray、listener、navigation 和 release 的完整生命周期。
- `DesktopStartupGeneration` 管理 Cordis Host 与 packaged runtime resources 的 generation lifetime、recovery quiesce 和 reverse-order release。
- `DesktopRendererHealthGate` 统一管理 Renderer report、native mount、timeout 和 durable commit，处理 evidence ordering 和 first-report 竞态。
- `ElectronPlatformStrategy` 包含三种 implementation，平台差异集中在该 seam。
- Profile selection、install WAL、Market receipts 和 Crash evidence 分别具有 owner 和原子提交路径。
- Compatibility/Advanced 分别声明 presentation ownership；桌面层不复制上游 feature state。
- Renderer 通过 loopback carrier 和 sandbox 通信，不使用 preload IPC。

## 证据入口

- `dsh-plugin-desktop/src/main.ts`
- `dsh-plugin-desktop/src/electron-runtime.ts`
- `dsh-plugin-desktop/src/electron-shell-generation.ts`
- `dsh-plugin-desktop/src/electron-platform.ts`
- `dsh-plugin-desktop/src/profile-manager.ts`
- `dsh-plugin-desktop/src/install-recovery.ts`
- `dsh-plugin-desktop/src/lifecycle-events.ts`
- `dsh-plugin-desktop/src/renderer-health.ts`
- `dsh-plugin-desktop/src/startup-generation.ts`
- `dsh-plugin-desktop/src/runtime.ts`
- `dsh-plugin-desktop/cordis.patch.yml`
- `dsh-community-market/src/install/service.ts`
- `dsh-community-market/src/host/routes.ts`
- `.agents/notes/implemented/architecture/`
