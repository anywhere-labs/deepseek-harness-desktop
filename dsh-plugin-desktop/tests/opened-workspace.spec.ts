import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/*
 * The macOS Dock drop is the one trigger this Desktop owns that arrives before
 * the launch pipeline exists, so its listener placement is the whole feature.
 * These assertions read the source because the ordering is what breaks: a
 * listener registered after the first await misses a cold launch, and one
 * registered after `ready` misses every drop.
 */
describe('macOS opened workspace delivery', () => {
  const main = readFileSync(join(process.cwd(), 'src', 'main.ts'), 'utf8')

  it('claims a Dock drop before the launch pipeline exists', () => {
    const openFile = main.indexOf("app.on('open-file', (event, path) => {")
    const firstAwait = main.indexOf('await getOrCreateDesktopInstallationId')
    const ready = main.indexOf('await app.whenReady()')
    const accept = main.indexOf('const acceptLaunchWorkspace = (request: DesktopLaunchWorkspaceRequest | undefined): void => {')
    const forwarder = main.indexOf('acceptOpenedWorkspacePath = (path: string): void =>')

    expect(openFile).toBeGreaterThanOrEqual(0)
    // macOS requires the listener before `ready`; before the first await is
    // stronger, and is what keeps a cold launch by drop from being missed.
    expect(openFile).toBeLessThan(firstAwait)
    expect(openFile).toBeLessThan(ready)
    // The pipeline is built after that await, so the forwarder can only be
    // bound once it exists, and the handler must tolerate that gap.
    expect(accept).toBeGreaterThan(firstAwait)
    expect(forwarder).toBeGreaterThan(accept)
  })

  it('parks the folder until the forwarder is bound', () => {
    const openFile = main.indexOf("app.on('open-file', (event, path) => {")
    const handler = main.slice(openFile, main.indexOf('let runtime!: ElectronDesktopRuntime'))

    expect(handler).toContain('event.preventDefault()')
    expect(handler).toContain('acceptOpenedWorkspacePath === undefined')
    expect(handler).toContain('pendingLaunchWorkspacePath = path')
    expect(handler).toContain('acceptOpenedWorkspacePath(path)')
  })

  it('registers the listener for darwin only', () => {
    const openFile = main.indexOf("app.on('open-file', (event, path) => {")
    const guard = main.lastIndexOf("if (process.platform === 'darwin') {", openFile)

    expect(guard).toBeGreaterThanOrEqual(0)
    // Nothing but comments may sit between the guard and the listener, so the
    // listener is inside that block rather than after it.
    expect(main.slice(guard, openFile)).not.toContain('}')
  })

  it('forwards a drop into the shared launch pipeline', () => {
    const forwarder = main.indexOf('acceptOpenedWorkspacePath = (path: string): void =>')

    expect(main.slice(forwarder, forwarder + 200))
      .toContain('acceptLaunchWorkspace({ path, explicit: true })')
  })
})
