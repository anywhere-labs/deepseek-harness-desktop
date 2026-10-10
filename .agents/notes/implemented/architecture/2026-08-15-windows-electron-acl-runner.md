# Agent Note: Windows Electron ACL runner

Status: implemented

English | [中文](2026-08-15-windows-electron-acl-runner.zh.md)

## Problem

The upstream Windows sandbox composes the ACL runner argv as `[process.execPath, runner.js, ...]`. This is correct under the DSH CLI because `process.execPath` is Node. DSH Desktop boots the same Host plugins inside Electron, where the value is the Electron executable during development and the installed `DSH Desktop.exe` after packaging. Starting that executable with the runner path as an argument does not establish the plain-Node process expected by the upstream runner and can instead start another desktop application instance.

The Windows sandbox has no weaker automatic provider fallback. A broken runner therefore makes ordinary workspace-write PowerShell unavailable, while silently bypassing confinement would misrepresent the selected permission mode. The upstream native spawn also deliberately omits `CREATE_NO_WINDOW` and `CREATE_NEW_CONSOLE` because restricted children fail DLL initialization with either flag. That is correct for a console Host, but the Electron Node-mode runner starts without a console. On affected Windows environments, forcing the restricted console child to create its own console fails during DLL initialization with `0xC0000142`; environments where Windows creates that console successfully still depend on behavior that differs from the console-hosted CLI path.

## Decision

The desktop package publishes `dsh-plugin-desktop/windows-pwsh-sandbox` as a Host subpath of the existing package. It is not a second npm package. The Windows desktop profile verifies that the `pwsh-sandbox` row still names the expected upstream provider, preserves its platform gate and configuration, disables that row, and inserts the desktop subpath. Compatibility and advanced presentation modes use the same Host profile and therefore receive the same execution adapter.

`DesktopWindowsPwshSandbox` extends the upstream `SandboxPwshExecutor` and uses its protected argv execution methods. It changes an invocation only when the platform is Windows, the Host is Electron, the executable equals `process.execPath`, and the next argument equals the resolved upstream Windows ACL runner. The rewritten argv inserts a private desktop trampoline between the executable and upstream runner. Direct PowerShell execution, including the explicit `danger-full-access` path, is passed through unchanged.

The adapted child receives a cloned environment with every case-insensitive `ELECTRON_RUN_AS_NODE` key removed and one `ELECTRON_RUN_AS_NODE=1` value added. The trampoline validates the exact upstream runner path, removes every form of that variable from its own environment, and then checks its Windows console state. If the process is attached to no console, it establishes one while still unrestricted and without a console window. On Windows 11 24H2, Windows Server 2025, and later, it calls `AllocConsoleWithOptions` with `ALLOC_CONSOLE_MODE_NO_WINDOW`. Elsewhere it starts an unrestricted `cmd.exe` with `CREATE_NO_WINDOW`, which owns a console that has no window, attaches to that console with `AttachConsole`, and lets the donor exit; the console survives because the trampoline stays attached. Only if both strategies fail does it call `AllocConsole()` and hide the allocated window with `ShowWindow(..., SW_HIDE)`; allocation failure at that point is fatal. A hidden ordinary console is only the last resort because Windows can delegate it to Windows Terminal when that is the default terminal application, and the terminal window ignores the hide request. Only after that host setup does the trampoline reconstruct the argv expected by the upstream module and import it. Restricted PowerShell and its descendants therefore inherit a real console without inheriting Electron's Node-mode switch.

The Electron build explicitly enables the `runAsNode` fuse because this child-launch protocol depends on it. The trampoline preserves the upstream `windows-acl-run` failure signature and exits with code 127 when its own validation or import fails, so the existing sandbox layer continues to classify runner startup failures as unavailable and fail closed.

The deploy root pins the published rc.6 Windows ACL package through a repository-owned Yarn patch. Both its pipe-capture and inherited-stdio `STARTUPINFOW` values combine `STARTF_USESHOWWINDOW` with the existing `STARTF_USESTDHANDLES` and set `wShowWindow` to `SW_HIDE`. Creation flags remain unchanged, so the restricted child inherits the trampoline's console and retains the upstream token, job, and stdio behavior. The native show-state remains defense in depth but is not used as a substitute for host console allocation. The patch is pinned to both direct and transitive rc.6 dependency descriptors; dependency tests require the sandbox provider and Desktop adapter to resolve the same patched package instance.

## Verification

Unit tests cover the exact Windows Electron match, unchanged non-Windows, plain-Node, wrong-executable, wrong-runner, and direct-PowerShell invocations, case-insensitive environment removal, parent-environment isolation, trampoline rejection, existing-console reuse including windowless consoles, windowless allocation, donor-console attachment and release, the hidden-console fallback, allocation failure, host-setup ordering, public package exports, build entries, the enabled fuse, the exact Yarn patch resolution, both hidden show-state writes, and the absence of `CREATE_NO_WINDOW`. A Windows-only test starts a detached, consoleless Node process, runs the real console setup through both the windowless-allocation and donor strategies, verifies that the process ends with a console but no console window, and then runs a real restricted `cmd.exe` that inherits it. Profile tests verify the Windows replacement, inherited configuration and gate, unchanged macOS and Linux composition, unchanged subprocess and sandbox services, and preservation of explicitly disabled or third-party providers.

The Host and Client compiler faces type-check independently. The package builds headlessly, the 201-node first-party runtime graph remains closed, and the Loader and complete-profile smokes pass. A headless Electron 43 Node-mode smoke executes the built trampoline and reaches the upstream ACL runner, which emits its signed missing-argument failure. Native Windows ACL confinement and the packaged `app.asar` path remain target-machine verification requirements.

## Alternatives considered

**Run the upstream argv unchanged.** The executable is the desktop application rather than Node, so the runner entry cannot rely on the CLI launch assumption.

**Set `ELECTRON_RUN_AS_NODE` globally.** Model tools, shells, and other subprocesses would inherit Electron-specific behavior. The variable is scoped to the one exact runner child and removed before restricted execution begins.

**Replace the Windows sandbox with local PowerShell.** This would make workspace-write execute without its declared ACL confinement. The adapter retains the upstream sandbox provider and its fail-closed behavior.

**Add `windowsHide` to the Node runner spawn.** That option affects only the Electron-to-runner process creation and cannot change the runner's direct `CreateProcessAsUserW` call. Translating it to `CREATE_NO_WINDOW` at the restricted-child layer would trigger the upstream DLL initialization failure.

**Modify the pinned upstream submodule.** The console presentation issue is specific to the desktop deploy artifact. The repository-owned Yarn patch keeps the upstream checkout unchanged and scopes the native show-state adjustment to the fixed package consumed by Desktop.

**Use Electron `utilityProcess`.** The upstream sandbox API supplies an argv prefix to the ordinary subprocess provider, while utility processes use a separate lifecycle and stream interface. Adapting only the expected runner child is smaller and preserves the existing provider composition.

## Consequences

Both desktop presentation modes can use the ordinary upstream Windows PowerShell tool with its ACL confinement while the desktop remains an additive package. The adapter is intentionally narrow: changes to the upstream runner package, argv prefix, or provider identity fail closed instead of being guessed.

The installed executable intentionally retains Electron's RunAsNode capability for this internal child protocol. Windows release verification must execute read-only and workspace-write console commands from the packaged application and confirm that the GUI runner begins without a console, the built trampoline establishes an inheritable console without a window, native ACL setup remains effective, output is captured, exits propagate, cancellation works, and temporary ACL state is cleaned up on the target operating system.
