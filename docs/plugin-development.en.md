# DSH Desktop Plugin Development

> **Do not confuse current APIs with a Draft:** this guide describes working DSH/Cordis and Desktop services. The manifest, capability, and unified event model in `dsh-community-fabric` remains a [community RFC Draft](../dsh-community-fabric/README.md) and cannot yet be used as a dependency or release target.

## Understand the two plugin layers

A normal DSH plugin can provide Host services, commands, routes, bundles, or a Web Client. It should depend on upstream DSH contracts whenever possible so the same package can work in the CLI, an ordinary Web profile, and DSH Desktop.

Desktop adds two public Host services:

- `desktopProfiles`: reads the active profile, discovers selectable profiles, and requests a safe profile switch.
- `desktopPnpm`: runs pnpm in the active profile, or manages plugins through the official `dsh plugin` semantics.

These services live in the Host Cordis generation in Electron's main process. The renderer cannot read them directly; a plugin with browser UI should continue to use ordinary DSH Web routes, RPC, client metadata, services, and slots.

The complete types, lifecycle, and failure semantics are in [`dsh-plugin-desktop/docs/plugin-services.md`](../dsh-plugin-desktop/docs/plugin-services.md). This page focuses on selection and the minimum safe patterns.

## Desktop-only plugins

If a plugin only makes sense in Desktop, declare the services as required injections:

```ts
import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import type {} from 'dsh-plugin-desktop/profile-service'
import type { DesktopPnpmHandle } from 'dsh-plugin-desktop/pnpm'

export const name = 'example-desktop-plugin'
export const inject = ['desktopProfiles', 'desktopPnpm']

declare function persistPendingReceipt(recovery: {
  readonly packageName: string
  readonly packageVersion: string
  readonly receiptId: string
}): Promise<void>

export function apply(ctx: Context): void {
  ctx.logger.info(`profile: ${ctx.desktopProfiles.current.name}`)
  let active: DesktopPnpmHandle | undefined

  // Connect this function to an explicit user action in the plugin UI.
  async function installExample(): Promise<void> {
    const recovery = {
      packageName: 'example-plugin',
      packageVersion: '1.0.0',
      receiptId: randomUUID(),
    }
    await persistPendingReceipt(recovery)
    active = await ctx.desktopPnpm.installPlugin({
      invokingDir: process.cwd(),
      recovery,
    })
    await active.done
  }

  ctx.effect(() => {
    return async () => {
      active?.cancel()
      await active?.done.catch(() => {})
    }
  }, 'example plugin operation')
}
```

Production code should invoke package operations from an explicit user action, validate the target, durably persist the recovery receipt before installation, reconcile recovered receipt ids on startup, read stdout/stderr, set its own timeout, and check both `exitCode` and `signal`. A generation allows only one `desktopPnpm` package operation at a time; dispose must cancel and await it.

## Plugins that work in Desktop and ordinary DSH

When the same package must also run under ordinary `dsh web`, do not put Desktop services in the top-level required `inject` list. Inject ordinary dependencies first and dynamically detect Desktop:

```ts
export const inject = ['webServer', 'loader']

export function apply(ctx: Context, config: { profile?: string }): void {
  const profiles = ctx.get('desktopProfiles')
  if (profiles === undefined) {
    mountOrdinaryDshManager(ctx, config.profile ?? 'web')
    return
  }

  ctx.inject(['desktopPnpm'], (desktopPnpm) => {
    mountManager(ctx, {
      profile: profiles.current.name,
      profileDir: profiles.current.dir,
      runPlugin: (args, cwd, signal) => desktopPnpm.runPlugin(args, cwd, signal),
    })
  })
}
```

The ordinary DSH fallback remains the plugin's authoritative implementation. Do not infer the Desktop profile from `process.argv`, `ctx.baseUrl`, settings, or `$DSH_HOME`; in Desktop, use `desktopProfiles.current`.

## `run()`, `runPlugin()`, and `installPlugin()`

`desktopPnpm.run(args)` is a low-level pnpm operation with the active profile as its cwd. It does not promise DSH profile initialization, caller-relative `file:`/`link:` anchoring, or `dsh.profile.bundles` reconciliation.

`desktopPnpm.runPlugin(args, invokingDir)` runs packaged `dsh plugin --profile <active>` for non-install mutations and preserves upstream plugin-management semantics. It rejects `add`. `installPlugin(request)` is the recoverable install path: it generates the exact package target from receipt metadata and owns the profile snapshot/WAL lifecycle.

```ts
await desktopPnpm.installPlugin({
  invokingDir,
  pnpmOptions: ['--save-exact'],
  recovery: { packageName, packageVersion, receiptId },
  signal,
})
desktopPnpm.runPlugin(['remove', packageName], invokingDir, signal)
desktopPnpm.runPlugin(['update'], invokingDir, signal)
desktopPnpm.runPlugin(['install', '--no-frozen-lockfile'], invokingDir, signal)
```

Arguments are passed as argv. Do not concatenate shell strings or depend on Windows `.cmd` shims. The service settles only after the whole subprocess tree exits and terminates active operations during generation disposal.

## APIs not to depend on

`desktopRuntime`, `desktopPnpmBootstrap`, Electron `BrowserWindow`, the tray registry, private Node helpers, `ELECTRON_RUN_AS_NODE`, and generated shims are Desktop internals. Their presence in declarations or runtime context does not make them third-party compatibility contracts.

## Testing and release checks

At minimum, a plugin should cover:

- Loading under ordinary DSH without Desktop services, or staying pending by design.
- Matching the profile name and directory reported by Desktop to the user's actual selection.
- Cancellation, non-zero exit, spawn failure, and generation teardown for package operations.
- Restarting after a plugin change and seeing the bundle in the next Loader composition.

Read the [architecture](architecture.en.md) next, then use the package-level [service contract](../dsh-plugin-desktop/docs/plugin-services.md) as the API reference.

## Ecosystem vision: keep the plugin ecosystem composable

The DSH plugin ecosystem is growing quickly. The more plugins there are, the more their ability to work together matters — if every plugin assumes or overrides another plugin's internals, installing a few plugins starts to conflict and the ecosystem fragments.

We advocate a browser-plugin style of development: everyone extends the same platform against the same conventions, instead of each maintaining a modified runtime of their own. DSH Desktop is the first practitioner of this approach — the desktop shell itself is an ordinary plugin on the same composition path as official and third-party plugins, with no special privileges.

To that end we are starting a development-conventions initiative and hope it becomes a de facto standard through community adoption:

- **Composition first**: compose capabilities through official slots, services, and patches; do not assume or override other plugins' internals.
- **Declare clearly**: state the services and slots you depend on; do not rely on runtime coincidences.
- **Compatibility first**: keep upgrades backward compatible and never break existing compositions.

The manifesto is a living document that follows ecosystem practice and accepts community discussion and revisions. Once the plugin marketplace ships, plugins following shared conventions will be easier to discover, install, and evaluate for compatibility, making convention-driven development the beneficial choice for every author. See the [DSH plugin ecosystem manifesto](plugin-ecosystem.en.md) for the vision and [DSH Community Fabric](../dsh-community-fabric/README.md) for the proposed future interoperability contract.
