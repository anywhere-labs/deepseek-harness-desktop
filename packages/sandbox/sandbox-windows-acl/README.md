# @deepseek-ai/dsh-sandbox-windows-acl

English | [中文](README.zh.md)

Windows write-restriction sandbox backend for the [harness sandbox seam](../sandbox/): a Node.js/[koffi](https://koffi.dev/) port of the mechanism in [huoyaoyuan/windows-acl-restrict-poc](https://github.com/huoyaoyuan/windows-acl-restrict-poc) (`10e4dfb`, the fixed revision), mounted as the `enforcement: 'partial'` win32 rung of the [`@deepseek-ai/dsh-sandbox-local`](../sandbox-local/) chain (`workspace-write` / `read-only` modes); the same package carries the Linux/macOS backends.

Mechanism in one line: the caller's token is duplicated into a `WRITE_RESTRICTED` token whose restricting SIDs carry separate workspace and private-temp capabilities. The workspace SID is derived deterministically from the canonical workspace path (`workspaceWriteSid`), so the workspace-root ACE materializes once per workspace per machine and every later session, call, or restart hits the exact-ACE skip. Each live session/workspace pair instead receives a random temp directory and a SID derived from that path (`tempWriteSid`), so sessions share the intended workspace authority without inheriting one another's temp authority. Windows grants a write only where BOTH the caller's normal access AND the restricting-SID intersection allow it. These SIDs are the primary allowlists and grant nothing elsewhere, but the check also inherits ambient write ACEs of the OTHER restricting SIDs (the keep-alive group logon SID + Everyone), and NTFS ACLs belong to file objects rather than paths; the Everyone and hard-link boundaries are why the rung reports partial rather than full enforcement.

Building directly on the raw ACL mechanism is the recorded design choice: it implements both confinement modes without the problems the rejected container options carry — see the [design note](../../../.agents/notes/implemented/feature/2026-08-08-windows-acl-restricted-token-sandbox.md) ([mxc](https://github.com/microsoft/mxc/blob/main/docs/process-container/os-version-support.md) needs an OS floor of Windows 11 24H2 and wholesale host DACL writes for arbitrary-path reads; AppContainer cannot do arbitrary-path reads at all).

## Usage

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

A direct `AclSandbox` requires an explicit private temp directory (or `tempDir: null`; the ambient temp root is never an implicit grant), grants the workspace ACEs STANDING (dispose() leaves them — they are the cross-instance reuse cache), and grants the distinct temp SID revocably. The server-side reuse is the `AclWriteGrant` class: `add(path, standing)` per directory, `dispose()` revokes the revocable paths and frees the SID — see the runner contract below. Every Win32 API call in this package is checked; failures throw `Win32Error` carrying the API name, the exact Win32 code, the `FormatMessageW` system text, and the failing path/context. This is deliberate: the POC ignored every return value and, when `CreateRestrictedToken` failed, silently ran the child with the FULL unrestricted token (fail-open). This port fails closed by construction.

## The confinement runner

The seam-facing shape is the **runner entry** (`./runner`), the argv-prefix wrapper `@deepseek-ai/dsh-sandbox-local` spawns in place of the caller's command — the same architecture as bwrap/landlock-run/sandbox-exec, so the sandbox seam's `confine()` contract needs no change. Stable argv contract:

```sh
node runner.js --workspace <dir> --temp <dir> --mode <read-only|workspace-write> [--write-sid <S-1-4-…> --temp-write-sid <S-1-4-…>] -- <argv...>
```

The runner creates the restricted token, spawns the wrapped argv under it with the caller's stdio passed straight through (the caller's pipes, made inheritable around the spawn — Node clears stdio inheritability at startup, which raw spawns must compensate for), requests a hidden child window through `STARTF_USESHOWWINDOW` plus `SW_HIDE`, wraps the child in a `KILL_ON_JOB_CLOSE` job (a dead runner kills the child), ignores its own console Ctrl+C so the child handles its own, mirrors the child's exit code, and revokes its self-managed temp grant on exit (workspace ACEs stand). The child keeps the host console because the restricted token cannot use `CREATE_NO_WINDOW`; the show-window hint suppresses visible console UI while preserving inherited and redirected stdio. Every runner-side failure prints `windows-acl-run: <detail>` to stderr and exits 127 — the seam's `RUNNER_FAILURE_RULES` match that signature, so a runner refusal is never mistaken for a denial.

**Workspace reuse and temp isolation**: the seam materializes the deterministic workspace SID's ACE STANDING (once per workspace per server lifetime, never revoked — it is the reuse cache), then creates a random private temp directory and distinct revocable SID for each live session/workspace pair. It passes both identities as the required `--write-sid`/`--temp-write-sid` pair; the runner verifies each against its owning path and neither grants nor revokes (`manageDacls: false`). A fork receives a different temp capability, and a fresh provider gives even the same resumed session a new path and SID, so crash residue is inert litter rather than a collision or inherited capability. Without the pair, `--temp` names a root: an agentless/standalone workspace-write runner creates a random private child, self-manages its temp SID, rewrites TMP/TEMP, and removes the child on exit. A workspace equal to or containing that root is rejected before any grant because its inheritable workspace ACE would otherwise authorize every private child; the direct API likewise rejects overlap between any writable root and the actual private temp directory. Re-granting the standing workspace ACE after a restart is idempotent: `grantWrite` reads the current DACL and skips `SetNamedSecurityInfoW` when the exact ACE already stands (that apply eagerly re-propagates the identical ACE across the whole tree — minutes on large workspaces). Known cost: the first grant on a big workspace tree blocks for that eager propagation once per workspace per machine.

Modes (the token's restricting-SID list follows the mode; the keep-alive group is logon SID + Everyone in BOTH modes — early DLL init dies with `0xC0000142` and CNG crashes pwsh with `0xE0434352` without them):
- `workspace-write` (logon SID, Everyone, workspace SID, temp SID): the workspace and the session's PRIVATE temp subdirectory carry separate Write grants; other ACL-addressable writes are denied except for the documented Everyone and hard-link boundaries.
- `read-only` (logon SID, Everyone — NO write SID): no explicit write-SID grants. The write SID stays OUT of the list on purpose: the standing workspace grant ACE from an earlier workspace-write period (a `/permission` downgrade, or a crash-resumed session) remains INERT under read-only because the write-restricted pass-2 check grants only what the restricting list carries — while the standing ACE keeps the re-upgrade free of re-propagation. Everyone's ambient rights remain the documented partial boundary. NUL writes are AMBIENT, not granted: the device DACL grants Everyone read+write+execute (`0x1201BF`), so openers whose mask fits it (cmd `> NUL`, node `\\.\NUL`) can write it in BOTH modes — the sandbox cannot zero-grant the NUL device while Everyone stays in the keep-alive group. `Set-Content NUL` fails in both modes (a PowerShell/.NET-layer effect, pinned by the read-only suite — the device DACL is not the denying party); PowerShell's `> $null` redirection keeps working (it discards without opening NUL).

Authenticated Users is absent from BOTH lists — the WMI namespace security check fails (`0x80041003`), so CIM cmdlets and `Get-ComputerInfo` (which silently returns incomplete results rather than an error) are unavailable in EVERY confined mode, and the C:\-root tree-creation escape (standing `AU:(AD)` + `AU:(OI)(CI)(IO)(M)` ACEs) is closed in both — the model-facing documentation states that contract, not a prompt promise. INTERACTIVE/LOCAL are absent from BOTH lists too: the host's Public tree grants write to INTERACTIVE, so Public writes are denied — pinned by the runner's ambient-writable Public-probe regression (see the design note).

The `AclSandbox` class (explicit private `tempDir` + `tempWriteSid`, or `tempDir: null` to disable temp writes) remains the programmatic API for direct spawns; `AclWriteGrant` is the server-side materialization half of the grant lifecycle.

## Header verification

All constants, signatures, and struct layouts were verified against the Windows headers on the development machine (MinGW `winnt.h` / `accctrl.h` / `aclapi.h` / `securitybaseapi.h` / `sddl.h` / `processthreadsapi.h` / `fileapi.h` / `namedpipeapi.h` / `synchapi.h` / `winbase.h`) and are cross-checked at runtime by [`verify/abi-probe.cpp`](verify/abi-probe.cpp) (sizes, offsets, enum values, static asserts):

```sh
g++ -std=c++20 -municode -O2 -o abi-probe.exe verify/abi-probe.cpp -ladvapi32 && ./abi-probe.exe
```

The koffi struct definitions assert their sizes against the probe at module load, so a header/koffi layout drift fails loudly instead of corrupting memory.

## Verified boundaries (inherent to restricted tokens, not this port)

- **Everyone grants remain ambient write authority.** Everyone must stay in both restricting lists: removing it breaks early DLL initialization and CNG. An external NTFS object whose normal DACL grants Everyone a requested write right therefore clears both access checks and stays writable under both modes. The real runner suite provisions an external `Everyone:Modify` directory and pins that behavior; the provider reports `enforcement: 'partial'` so callers can reject or surface the weaker boundary.
- **Hard links are file-object aliases, not path aliases.** An inheritable workspace ACE propagated onto an existing NTFS hard link changes the one underlying file security descriptor, so the same object is writable through an external alias. Rejecting every multiply-linked workspace file is not viable for ordinary pnpm installations, which use hard links into their content-addressable store; the native runner suite pins the gap and the provider's partial report names its consequence.
- **Writes are restricted; reads, network, and process visibility are not.** `WRITE_RESTRICTED` intersects write accesses only, so a confined child can read any caller-readable file and open sockets. `read-only` mode therefore cannot be expressed by this mechanism alone; pair it with a read-side policy or an AppContainer/`S-1-15-2` capability token for stronger confinement.
- **Console isolation is unavailable; visible child windows are suppressed.** Under the restricted token, children created with `CREATE_NO_WINDOW` / `CREATE_NEW_CONSOLE` die during DLL initialization with `STATUS_DLL_INIT_FAILED` (`0xC0000142`). The POC tried to fix this by adding the console logon SID (`S-1-2-1`) to the restricting list; on Windows 11 26200 `CreateWellKnownSid(WinLocalLogonSid)` fails with `ERROR_INVALID_PARAMETER` (87), the correct `WinConsoleLogonSid` yields a valid `S-1-2-1` but the child still dies, and the POC's final revision removed both the SID and console isolation. Children therefore share the host console. Both spawn paths set `STARTF_USESHOWWINDOW` and `SW_HIDE` while leaving creation flags unchanged, which suppresses a visible child window and preserves inherited or redirected stdio.
- **ACL grants are standing directory mutations.** They persist if the process dies mid-run; workspace ACEs are standing BY DESIGN (never revoked — the reuse cache), temp ACEs are revoked by `dispose()` (`init()` also revokes an already-applied temp grant when a later step fails). The POC's documented manual cleanup (`icacls <dir> /remove '*S-1-4-…'`) fails on this platform with `ERROR_NONE_MAPPED` (1332) — revoke through this module instead. An unclean shutdown needs no self-healing for the workspace ACE: the derived SID re-hits the standing ACE on the next provision (skipping the apply); the write-SID ACE never accumulates a second identity per restart because the identity IS the workspace.
- **Granted directories must be caller-owned.** The owner's implicit `WRITE_DAC` is what lets the sandbox edit the DACL without elevation.
- **The ambient temp root is never granted implicitly.** A direct `AclSandbox` workspace-write caller must supply an existing private `tempDir` plus its distinct `tempWriteSid`, or explicitly disable temp writes with `tempDir: null`. The actual temp directory must be disjoint from every writable root. The seam creates a random private directory; agentless runner calls treat `--temp` as the parent root and create their own random child, but reject a workspace equal to or containing that parent before any ACL mutation.
- **The confined child's temp capability is private per live session/workspace pair.** The runner rewrites TMP/TEMP via `SetEnvironmentVariableW` to that private directory before the spawn and the child inherits the rewritten block (bwrap `--tmpfs /tmp` semantics). The temp ACE and directory are removed on provider disposal, or after each agentless invocation. A crash can leave inert `%TEMP%` litter, but a resumed provider chooses a new random path and SID instead of colliding with or reauthorizing the residue. The native runner suite proves that two tokens sharing the same workspace SID cannot write one another's temp directories.
- **`whoami` and token-inspection cmdlets fail under the restricted token.** `GetTokenInformation` on the duplicate is partially unavailable to the child, so `whoami /all` reports errors — diagnostic noise of the restriction scheme, not an operational failure; the denial surfaces that matter (file writes) are unaffected.

## Model Experience

Indirectly, through [`dsh-bash-sandbox`](../../shell/bash-sandbox/README.md), [`dsh-pwsh-sandbox`](../../shell/pwsh-sandbox/README.md), and their tools, which render this backend's partial-enforcement and denial facts (the confined stderr the tool layer classifies through `denialSignatures`) while the [`dsh-sandbox`](../sandbox/README.md) seam owns the `SANDBOX_UNAVAILABLE` text and runner selection.

#### KV Cache effect

None directly; the denial surface belongs to the tool layer.

## Known Limitations and Deferred Work

- **One write allowlist per workspace** — the write SID is the unit of the allowlist and IS the workspace identity; reusing one sandbox instance across two workspaces widens both grants to both roots (the same SID would then name two roots). Create one instance per workspace root — the seam does exactly this, keyed by the workspace path.
- **Cleanup is best-effort by design** — `dispose()` attempts every temp revocation and aggregates failures into an `AggregateError`; a cleanup failure can leave the random directory and its temp-SID-only ACE behind. Once the process exits no future token carries that SID, so the residue is inert until OS temp hygiene or manual directory removal reclaims it.
- **Standing workspace ACEs are invisible residue.** Renaming a workspace derives a new SID; the old ACEs on the old path stay (inert, write-SID-only). A future cleanup command may reap them; nothing re-propagates because of them.
- **NULL-DACL directories are not identity-preserving under grant+revoke.** A directory with a NULL DACL (rare — Windows-created directories carry real DACLs) means "everyone full control"; `grantWrite` builds the new ACL from that null, and the revoke round-trip leaves an EMPTY (deny-all) DACL rather than the original NULL DACL. The POC shares the behavior; real workspace and temp directories carry real DACLs, so this stays a documented edge rather than a guarded path.
- **Piped stdio capture is impossible for confined grandchildren (the named-pipe default SD template).** libuv's pipe stdio uses NAMED pipes; `CreateNamedPipeW` without security attributes installs the Win32 layer's user-mode default SD template (built by KernelBase — owner/SYSTEM/Admins full, Everyone/ANONYMOUS read-only, the fixed template [MS documents](https://learn.microsoft.com/en-us/windows/win32/ipc/named-pipe-security-and-access-rights)) — NOT the token default DACL, which is what the kernel applies to a raw SD-null create — so the client-end open requests write access no restricting SID is granted: `spawn(..., { stdio: 'pipe' })` inside a confined process fails with EPERM, the POC-documented "no output redirection" boundary of WRITE_RESTRICTED tokens. Inherited (`inherit`/fd) and ignored (`ignore`) stdio spawns work, and anonymous pipes (CreatePipe — a token-default-DACL consumer, e.g. PowerShell pipelines) work because the restricted token's default DACL carries a full-access restricting-SID ACE (set at init). A confined process therefore cannot capture a grandchild's output through a pipe; tools that must capture output cannot run confined.
- **Grant materialization is an eager full-tree propagation.** `SetNamedSecurityInfoW` on a directory with inheritable ACEs walks every descendant immediately (NOT lazily per access — measured at tens of seconds on large workspace trees). The per-workspace identity pays it once per workspace per machine (lazily at the first confined execution ever, skipped entirely on every later provision when the exact ACE stands). Private temp directories start empty, so their distinct grant is cheap. If a workspace is huge, the first confined write on this host is correspondingly slow.
- **Read-side confinement and network policy are out of scope** — `WRITE_RESTRICTED` intersects write accesses only; pair this backend with a read-side policy for stronger confinement.
- **Wide-directory and FAT-volume warnings are deferred; FAT-class targets stay writable.** The UI-side warnings for granting unusually wide directories or FAT-class (non-ACL) volumes are not yet implemented, and a FAT volume as a grant ROOT simply fails the grant loudly (no ACL support). A FAT-class target OUTSIDE the granted roots is different: it has no security descriptors, so the restricted token's write check passes (Everyone sits in both lists) and such targets are writable under BOTH confined modes. FAT is treated as a legacy residue — unsupported and not engineered around; this warn-only posture is documented here rather than mitigated.
- **PowerShell language mode differs by confined mode.** Under `read-only`, PowerShell cannot create its AppLocker probe files in temp and conservatively starts in ConstrainedLanguage: `Add-Type` (C# compile, P/Invoke), non-core .NET static calls (`[System.IO.*]::`, `[math]::`, `[Environment]::`), COM objects, and reflection fail with `Cannot create type` / `Cannot invoke method` ("only core types") errors, and `$ExecutionContext.SessionState.LanguageMode = 'FullLanguage'` is refused. Under the shipped `workspace-write` path, the private-temp capability lets that probe complete, so pwsh stays in FullLanguage unless host-wide WDAC/AppLocker policy says otherwise; a direct `AclSandbox` configured with `tempDir: null` has no such guarantee and can fail the probe closed like read-only. This split is PowerShell startup behavior, not part of the ACL write boundary. The `pwsh` tool description teaches the shipped modes to the model; `danger-full-access` calls run unconfined at FullLanguage.
