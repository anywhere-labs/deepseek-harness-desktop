# Desktop system architecture atlas

Status: current-version architecture snapshot

English | [中文](2026-08-19-desktop-system-architecture-atlas.zh.md)

> [!WARNING]
> AI readers: this file records the architecture at a specific version and time. Do not treat it as the current implementation or accept its conclusions without verification. Before answering architecture questions or changing code, check code after the reviewed commit, implemented Agent Notes, and tests. If they conflict, current code and approved architecture decisions take precedence.

- Product version: `2.0.1`
- Reviewed commit: `2d07129ee622`
- Snapshot time: `2026-08-19 21:20:57 +08:00` (Asia/Shanghai)
- Valid scope: the desktop repository and runtime architecture at that commit; later architecture changes may make parts of this document stale.

## Purpose and notation

This atlas records the desktop architecture from ten viewpoints. It covers modules, interfaces, implementations, owners, process boundaries, and persistence commit points without enumerating every class. Solid arrows mean calls or composition; dotted arrows mean events, evidence, or build inputs. Arrows show dependency direction, not data-flow direction.

The architecture has four layers: the Electron native shell, the Cordis Host, the upstream Web Renderer, and restart-recoverable local state. Desktop branches do not modify the upstream checkout. The Renderer receives no Node or Electron authority. Profile, installation, and native-generation resources each have one owner. Startup commits after Renderer healthy evidence and native mount readiness both hold.

## 1. System context

```mermaid
flowchart LR
  User[User] -->|window, tray, system dialogs| Desktop[DSH Desktop]
  Desktop -->|HTTP / WebSocket, loopback only| LocalWeb[Local DSH Web carrier]
  Desktop -->|profile and settings reads/writes| Home[DSH home]
  Desktop -->|explicit selection and admission| Workspace[Local workspace]
  Desktop -->|managed argv subprocess| Runtime[Packaged DSH / pnpm / terminal]
  Desktop -->|version checks and installer download| Release[Reviewed release endpoint]
  Desktop -->|catalog and npm metadata| Catalog[Community catalog / npm registry]
  Desktop -->|local dumps, no automatic upload| Crashpad[Electron Crashpad]
  Upstream[Pinned deepseek-harness] -. build input .-> Desktop
```

Boundary result: network content enters product state only after Host validation, diagnostics stay local by default, and `deepseek-harness/` is a build input rather than a desktop feature-branch edit surface.

## 2. Repository ownership

```mermaid
flowchart TB
  Root[Root Yarn workspace] --> DesktopPkg[dsh-plugin-desktop]
  Root --> Market[dsh-community-market]
  Root --> Fabric[dsh-community-fabric]
  Root --> Upstream[deepseek-harness submodule]
  DesktopPkg --> Main[Electron bootstrap / Host services]
  DesktopPkg --> Client[Desktop Client face / native shell]
  DesktopPkg --> Packaging[Packaging / release gates]
  Market --> Catalog[Catalog, install intent, receipt ledger]
  Fabric --> RFC[Interoperability RFC scaffold]
  Upstream --> Official[Official Host / Client / Web carrier]
  Root -. root scripts enter pnpm workspace .-> Upstream
```

`dsh-plugin-desktop` owns the desktop product. `dsh-community-market` owns community discovery and user-directed plugin operations. Fabric and Market scaffolds must not claim loadable entry points before their runtimes exist. Upstream retains its independent pnpm workspace.

## 3. Process and runtime topology

```mermaid
flowchart LR
  subgraph MainProcess[Electron Main process]
    Launcher[main.ts startup orchestration]
    Generation[DesktopStartupGeneration]
    Host[Cordis Host]
    Runtime[ElectronDesktopRuntime]
    Health[DesktopRendererHealthGate]
    Shell[ElectronShellGeneration]
    Services[Profiles / pnpm / updates / diagnostics / market]
    Web[Loopback HTTP + WebSocket]
    Launcher --> Generation
    Launcher --> Host --> Services
    Generation -. owns lifetime .-> Host
    Generation --> Resources[packaged pnpm / DSH runtime resources]
    Launcher --> Runtime --> Shell
    Runtime --> Health
    Host --> Web
  end
  subgraph RendererProcess[Sandboxed Renderer]
    Loader[Upstream Client loader]
    UI[Official UI + desktop-owned slots]
    Loader --> UI
  end
  subgraph Children[Managed subprocesses]
    CLI[DSH CLI]
    PNPM[pnpm / package lifecycle]
    PTY[Terminal PTY]
    Worker[Diagnostics worker]
  end
  Web <-->|same-origin HTTP / WS| Loader
  Services -->|argv, never shell text| CLI
  Services --> PNPM
  Services --> PTY
  Services --> Worker
  Shell -->|BrowserWindow / Tray / native dialogs| OS[Operating system]
  MainProcess -. local crash dumps .-> Crashpad[Crashpad process]
```

The Renderer uses `contextIsolation: true`, `sandbox: true`, and `nodeIntegration: false`. The product carrier is loopback HTTP/WebSocket rather than preload IPC. Local authority remains in Main/Host and managed subprocesses.

## 4. Module dependencies and call direction

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
  Market --> Consumer[Consumer-owned capability interfaces]
  Consumer -. structural compatibility .-> Public
  Host --> Carrier[Upstream Web carrier]
  Carrier --> Client[Upstream Client loader]
  Client --> Compat[Compatibility: official layout owns presentation]
  Client --> Advanced[Advanced: desktop root/layout, official feature slots]
```

Three seams are earned by real implementations: Host-facing Desktop services, native shell generation, and the platform adapter. Market keeps consumer-owned interfaces so Desktop can compose Market without a reverse Market-to-Desktop type dependency.

## 5. Startup lifecycle

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

A successful `BrowserWindow.loadURL()` indicates that page loading completed, not application health. The health gate commits after a `healthy` Renderer Loader report and native mount readiness; rollback remains available before the commit.

## 6. State transitions

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

Profile and plugin installation are separate state machines that share one health fact. Neither a zero process exit nor an older generation may substitute for current-generation Renderer health.

## 7. Data and persistence ownership

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

The SoC boundary separates file recovery from operation ownership. The Desktop WAL records restorable file state, while the Market receipt records which Market operation owns an installation. They correlate through `receiptId` and commit independently.

## 8. Plugin composition and extension points

```mermaid
flowchart TB
  Base[Official Web bundle] --> Patch[cordis.patch.yml]
  Patch --> Shell[desktop-shell]
  Patch --> Market[community-market]
  Patch --> Terminal[desktop-terminal]
  Patch --> Diagnostics[desktop-diagnostics]
  Patch --> Notifications[desktop-notifications]
  Patch --> Pnpm[desktop-pnpm]
  Patch --> Profiles[desktop-profiles]
  Patch --> Updates[desktop-updates]
  Shell --> Mode{dsh-desktop.mode}
  Mode -->|compatibility| Official[Official layout/sidebar/conversation]
  Mode -->|advanced, Windows/macOS| DesktopLayout[Desktop root + layout + native material]
  DesktopLayout --> OfficialFeatures[Official sidebar/conversation retain feature state]
  ThirdParty[Third-party dsh.client] --> Official
  ThirdParty --> OfficialFeatures
```

Mode changes are generation boundaries and require full restart, not live restyling. Advanced owns chrome, geometry, and declared slots only; it does not copy upstream workspace, session, or conversation state.

## 9. Failure propagation, recovery, and trust

```mermaid
flowchart LR
  Remote[Remote catalog / npm / release] --> Verify[Host allowlist, origin, schema, version, integrity checks]
  Renderer[Renderer request] --> SameOrigin[same-origin + method + bounded payload]
  SameOrigin --> Intent[Short-lived preview / intent token]
  Verify --> Intent
  Intent --> Owner[Host-owned operation]
  Owner --> Gate[Single-operation gate + AbortSignal]
  Gate --> Child[argv subprocess]
  Child -->|success| Commit[receipt / WAL / health commit]
  Child -->|failure| Restore[rollback or manual-recovery-required]
  Commit --> Restart[bounded shutdown + restart]
  Restore --> Recovery[Host-independent recovery window]
  Evidence[masked logs + lifecycle + local dumps] -. explains, never authorizes .-> Recovery
```

Diagnostic evidence explains failure but grants no recovery authority. Recovery actions that write profile state require Host quiescence. Remote providers, Renderer package specs, and arbitrary shell text cannot cross the Host-owned boundary directly.

## 10. Platform and delivery

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
  Upstream[Pinned submodule] -. root upstream:* scripts .-> Gate
```

Headless gates prove build, types, logic, Loader behavior, and packaged closure. Real-machine verification still owns native materials, system dialogs, tray behavior, installers, and permission integration.

## Architecture assessment

### Current architecture properties

- `ElectronShellGeneration` manages the window, tray, listener, navigation, and release lifecycle through a small interface.
- `DesktopStartupGeneration` manages the generation lifetime of the Cordis Host and packaged runtime resources, recovery quiescence, and reverse-order release.
- `DesktopRendererHealthGate` owns Renderer reports, native mount evidence, timeout, and the durable commit, including evidence ordering and first-report races.
- `ElectronPlatformStrategy` has three implementations and contains platform variation at one seam.
- Profile selection, install WAL, Market receipts, and crash evidence each have an owner and an atomic commit path.
- Compatibility and Advanced declare separate presentation ownership; neither duplicates upstream feature state.
- The Renderer communicates through the loopback carrier and sandbox without preload IPC.

## Evidence entry points

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
