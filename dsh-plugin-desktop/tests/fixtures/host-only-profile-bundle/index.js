/** Profile-installed Host-only Bundle used by the complete Loader smoke. */

export const name = 'host-only-profile-smoke-plugin'

// These are ordinary DSH Host services. Desktop capabilities remain optional
// so the same Bundle can load in Web, headless, and Desktop profiles.
export const inject = [
  'credentials',
  'agents',
  'agentDefaultModel',
  'agentPresets',
  'permissionPresets',
  'approval',
  'systemPrompt',
]

/** Publish the services and optional Desktop identity observed at activation. */
export function apply(ctx) {
  const current = ctx.get('desktopProfiles')?.current
  ctx.provide('hostOnlyProfileProbe', Object.freeze({
    requiredServices: Object.freeze(Object.fromEntries(
      inject.map(service => [service, ctx.get(service) !== undefined]),
    )),
    desktopProfile: current === undefined
      ? undefined
      : Object.freeze({ name: current.name, dir: current.dir }),
    hasDesktopPnpm: ctx.get('desktopPnpm') !== undefined,
  }))
}
