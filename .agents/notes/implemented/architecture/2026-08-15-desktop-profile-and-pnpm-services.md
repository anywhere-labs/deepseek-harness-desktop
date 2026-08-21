# Agent Note: Desktop profile and package-manager services

English | [中文](2026-08-15-desktop-profile-and-pnpm-services.zh.md)

## Problem

The Electron launcher knows which DSH profile produced the current Cordis generation, but an ordinary Host plugin cannot recover that identity reliably from inner command-line arguments, `ctx.baseUrl`, settings, or Loader entries. The launcher consumes `--profile` before it provides the inner `ctx.cmdlineArgs`; a Loader base is module-resolution metadata rather than a profile capability; settings start after profile selection; and Loader inventory does not carry profile provenance.

Desktop also bundles pnpm, but finding a package-manager executable is not enough to manage DSH plugins correctly. The upstream `dsh plugin` command initializes a missing profile, anchors relative package specifications to the caller, runs pnpm in the profile directory, and reconciles `dsh.profile.bundles` against installed packages after success. Direct pnpm execution omits those DSH semantics. Ad hoc child-process code additionally produces different lifecycle, cancellation, and Windows `.cmd` behavior across plugins.

Desktop therefore needs explicit generation-scoped Host services for profile identity and managed package operations, while third-party plugins must remain usable under ordinary DSH where those Desktop services do not exist.

## Decision

The launcher supplies immutable bootstrap facts before Loader entries mount. Two normal Cordis services then own the public Desktop boundary for the lifetime of that generation: `ctx.desktopProfiles` and `ctx.desktopPnpm`. Neither service is exposed to the renderer, and neither changes the upstream profile manifest, patch format, CLI, or pinned source checkout.

These are Desktop-owned service contracts. Current upstream DSH does not provide a typed active-profile or profile-package-manager service. Consumers outside Desktop must treat both services as optional and retain their ordinary DSH behavior when the services are absent.

## `desktopProfiles`

`desktopProfiles.current` is an immutable `{ name, dir }` identity for the profile that produced the running generation. `list()` performs read-only discovery, and `select(name)` serializes selection, persists the target before requesting an orderly restart, and never mutates the current generation's identity in place.

Concurrent requests for the same target share one operation. Once another profile has been persisted as pending, a different target cannot overwrite it before restart. A retained service reference rejects use after its Cordis lifetime ends. Profile discovery and last-known-good recovery remain launcher responsibilities described in the [profile-management decision](2026-08-15-desktop-profile-management.md).

## `desktopPnpm`

`desktopPnpm` accepts only the active generation selected by the launcher. It uses the ordinary DSH subprocess service to own one operation at a time, exposes live stdout and stderr streams, settles `done` only after the complete process tree exits, and supports both an input `AbortSignal` and explicit `cancel()`. Disposal terminates and joins an active operation before releasing the service lifetime.

The provider invokes the signed application executable with the packaged pnpm and DSH entries. Its child-only environment supplies the active DSH home, the private Electron-backed Node helper, CI mode, and Electron ABI values required by native dependency installation. Arguments cross the process boundary as argv rather than shell text. Windows therefore does not depend on a caller discovering or directly spawning a `.cmd` shim.

### `run()`, `runPlugin()`, and `installPlugin()`

`run(args, signal?)` executes packaged pnpm directly with the active profile directory as its working directory. It is a low-level package-manager operation. It does not promise profile initialization, caller-relative source anchoring, or DSH bundle reconciliation and must not be treated as the plugin-management API.

`runPlugin(args, invokingDir, signal?)` starts the packaged `dsh plugin --profile <active>` command with `invokingDir` as the CLI working directory for non-install mutations such as `remove`, `update`, or recovery-time `install --no-frozen-lockfile`. It rejects `add`. The upstream CLI remains authoritative for changing into the profile directory for pnpm and reconciling `dsh.profile.bundles` after a successful mutation.

Plugin managers use `installPlugin(request)` for `add`. This deep interface binds one exact package name and version to the recovery receipt, snapshots the profile before spawn, and seals or restores the snapshot before completion. Other plugin mutations use `runPlugin()`. Consumers own their user-facing deadline and progress model; the module owns executable selection, child environment, the single-operation gate, process-tree termination, and the active profile with no consumer-supplied profile argument.

## Third-party compatibility and dshmarket

An optional Desktop-aware consumer resolves `desktopProfiles` and `desktopPnpm` dynamically after its ordinary required Host services are available. When both exist, the immutable service identity overrides config or argv guesses; install uses `installPlugin()` and other plugin mutations use `runPlugin()`. When neither exists, the consumer keeps its existing config/argv and DSH CLI path so the same package continues to work in an ordinary Web profile. A Desktop service must not become a required Cordis injection for a cross-environment plugin.

`dshmarket@1.2.3` does not implement that adapter. It resolves its target as `config.profile`, launcher argv, or `web`, then binds private child-process code that starts `dsh plugin`. Its package exports no runner or route injection seam. A Desktop patch can supply a profile name and a PATH shim can make the legacy command discoverable, but neither makes that release consume the formal services. A true integration requires a later dshmarket release or a maintained source patch; Desktop does not fork its routes.

Version `1.2.3` is not a Desktop dependency and is not preinstalled. Its npm manifest and README identify MIT, but its source repository and published tarball contain no complete license text or copyright notice. Because the MIT notice must accompany redistributed copies, Desktop treats that omission as a bundled-redistribution blocker. User-directed installation through ordinary DSH remains separate from Desktop embedding the package in its application archive or installer. Adoption requires a new audited release that both adds the optional service adapter and ships the complete notice.

## Verification

Focused contracts cover immutable profile identity, read-only discovery, serialized persistence-before-restart selection, disposed references, direct pnpm argv and working directory, `dsh plugin` argv and caller directory, child-only environment values, streaming output, cancellation, complete process-tree settlement, and the generation-wide busy gate. Windows verification asserts shell-free argv execution through the packaged entries.

Loader smoke must prove that the two public services assemble in the Desktop composition and can satisfy their declared consumer injections. The packaged-runtime gate must prove that the DSH and pnpm entries are physical runtime files. Focused service tests verify that plugin operations use the active launcher selection and expose no consumer-supplied profile argument. dshmarket must remain absent from the production dependency graph and packaged archive until a newly audited version clears both the service-adapter and license gates. Any later adoption must pin and record the exact npm version and integrity rather than relying on a mutable tag.

## Alternatives considered

**Infer the profile from argv, `baseUrl`, settings, or Loader metadata.** These values are either consumed before the plugin tree, available too late, or describe module resolution rather than launcher identity.

**Expose the terminal's complete shim directory to every Host plugin.** This would shadow user `node` and `dsh` commands and still would not define profile ownership, mutation serialization, or process lifetime.

**Use `run()` for plugin add, remove, and update.** Raw pnpm can change dependencies but omits the upstream reconciliation that controls which dependencies become DSH bundle layers.

**Fork or silently patch dshmarket 1.2.3 into the application.** That creates a permanent third-party maintenance and provenance obligation while redistributing a package that has not supplied its required license notice.

## Consequences

Desktop Host plugins have one explicit source of active-profile identity and one managed path for packaged package operations. Plugin managers preserve upstream DSH semantics, progress remains consumer-owned, cancellation tears down complete process trees, and Windows no longer requires each consumer to invent shell handling. Ordinary DSH compatibility remains possible through optional service detection, while dshmarket preinstallation stays deferred behind concrete API and redistribution gates.
