import { describe, expect, it, vi } from 'vitest'
import { WorkspacesOpenPathDecorator } from '../src/client/file-preview/open-path-decorator.ts'
import type { OpenPathSurface } from '../src/client/file-preview/open-path-decorator.ts'

/** Build a class-like surface whose openPath is an own method. */
interface OwnSurface {
  calls: string[]
  binding?: unknown
  openPath(path: string): Promise<void>
}

function makeOwnSurface(): OwnSurface {
  const surface: OwnSurface = {
    calls: [],
    binding: undefined,
    openPath: function openPath(this: OwnSurface, path: string): Promise<void> {
      surface.calls.push(path)
      surface.binding = this
      return Promise.resolve()
    },
  }
  return surface
}

/** Build an instance whose openPath is inherited from its prototype. */
class InheritedSurface implements OpenPathSurface {
  calls: string[] = []
  binding: unknown
  openPath(path: string): Promise<void> {
    this.calls.push(path)
    this.binding = this
    return Promise.resolve()
  }
}

describe('workspaces-open-path-decorator', () => {
  it('captures the original without installing anything', () => {
    const surface = makeOwnSurface()
    // Constructing captures the original without yet installing a wrapper.
    new WorkspacesOpenPathDecorator(surface, () => 's1')
    // openPath is unchanged until install().
    expect(surface.calls).toHaveLength(0)
  })

  it('calls the original directly when there is no current session', async () => {
    const surface = makeOwnSurface()
    const preview = vi.fn(async () => 'handled' as const)
    const decorator = new WorkspacesOpenPathDecorator(surface, () => undefined)
    decorator.install(preview)
    await surface.openPath('/w/file.ts')
    expect(preview).not.toHaveBeenCalled()
    expect(surface.calls).toEqual(['/w/file.ts'])
  })

  it('calls the original when preview delegates', async () => {
    const surface = makeOwnSurface()
    const preview = vi.fn(async () => 'delegate' as const)
    const decorator = new WorkspacesOpenPathDecorator(surface, () => 's1')
    decorator.install(preview)
    await surface.openPath('/w/file.ts')
    expect(preview).toHaveBeenCalledWith('s1', '/w/file.ts')
    expect(surface.calls).toEqual(['/w/file.ts'])
  })

  it('does NOT call the original when preview handles', async () => {
    const surface = makeOwnSurface()
    const preview = vi.fn(async () => 'handled' as const)
    const decorator = new WorkspacesOpenPathDecorator(surface, () => 's1')
    decorator.install(preview)
    await surface.openPath('/w/file.ts')
    expect(preview).toHaveBeenCalledWith('s1', '/w/file.ts')
    expect(surface.calls).toHaveLength(0)
  })

  it('skips the probe for an unknown extension', async () => {
    const surface = makeOwnSurface()
    const preview = vi.fn(async () => 'handled' as const)
    const decorator = new WorkspacesOpenPathDecorator(surface, () => 's1')
    decorator.install(preview)
    await surface.openPath('/w/archive.zip')
    expect(preview).not.toHaveBeenCalled()
    expect(surface.calls).toEqual(['/w/archive.zip'])
  })

  it('routes a known extension and an extensionless file through the probe', async () => {
    const surface = makeOwnSurface()
    const preview = vi.fn(async () => 'handled' as const)
    const decorator = new WorkspacesOpenPathDecorator(surface, () => 's1')
    decorator.install(preview)
    await surface.openPath('/w/file.ts')
    await surface.openPath('/w/README')
    expect(preview).toHaveBeenCalledTimes(2)
    expect(surface.calls).toHaveLength(0)
  })

  it('preserves the original `this` binding for the original method', async () => {
    const surface = makeOwnSurface()
    const preview = vi.fn(async () => 'delegate' as const)
    const decorator = new WorkspacesOpenPathDecorator(surface, () => 's1')
    decorator.install(preview)
    await surface.openPath('/w/file.ts')
    expect(surface.binding).toBe(surface)
  })

  it('propagates preview rejections to the caller', async () => {
    const surface = makeOwnSurface()
    const preview = vi.fn(async () => { throw new Error('boom') })
    const decorator = new WorkspacesOpenPathDecorator(surface, () => 's1')
    decorator.install(preview)
    await expect(surface.openPath('/w/file.ts')).rejects.toThrow('boom')
    expect(surface.calls).toHaveLength(0)
  })

  it('propagates original-method rejections', async () => {
    const surface = makeOwnSurface()
    surface.openPath = async () => { throw new Error('system-boom') }
    const preview = vi.fn(async () => 'delegate' as const)
    const decorator = new WorkspacesOpenPathDecorator(surface, () => 's1')
    decorator.install(preview)
    await expect(surface.openPath('/w/file.ts')).rejects.toThrow('system-boom')
  })

  it('restores an own-property descriptor on dispose', async () => {
    const surface = makeOwnSurface()
    const decorator = new WorkspacesOpenPathDecorator(surface, () => 's1')
    decorator.install(vi.fn(async () => 'handled' as const))
    expect(Object.hasOwn(surface, 'openPath')).toBe(true)
    const installed = surface.openPath
    decorator.dispose()
    expect(Object.hasOwn(surface, 'openPath')).toBe(true)
    expect(surface.openPath).not.toBe(installed)
    // The restored own method still works with the original receiver.
    await surface.openPath('/w/a.ts')
    expect(surface.calls).toEqual(['/w/a.ts'])
  })

  it('restores an inherited method by deleting the own wrapper', async () => {
    const surface = new InheritedSurface()
    const decorator = new WorkspacesOpenPathDecorator(surface, () => 's1')
    decorator.install(vi.fn(async () => 'handled' as const))
    expect(Object.hasOwn(surface, 'openPath')).toBe(true)
    decorator.dispose()
    expect(Object.hasOwn(surface, 'openPath')).toBe(false)
    // The inherited prototype method is back.
    await surface.openPath('/w/b.ts')
    expect(surface.calls).toEqual(['/w/b.ts'])
    expect(surface.binding).toBe(surface)
  })

  it('does not clobber a later-installed wrapper on dispose', async () => {
    const surface = makeOwnSurface()
    const previewA = vi.fn(async () => 'handled' as const)
    const previewB = vi.fn(async () => 'delegate' as const)
    const decoratorA = new WorkspacesOpenPathDecorator(surface, () => 's1')
    decoratorA.install(previewA)
    // decoratorB is constructed while A's wrapper is already installed, so B
    // captures A's wrapper as its own "original" (composition).
    const decoratorB = new WorkspacesOpenPathDecorator(surface, () => 's1')
    decoratorB.install(previewB)
    const laterWrapper = surface.openPath
    decoratorA.dispose()
    // decoratorA must not restore the true original over decoratorB's wrapper.
    expect(surface.openPath).toBe(laterWrapper)
    await surface.openPath('/w/c.ts')
    // The live wrapper is B's, so only B's preview ran and it delegates into
    // A's wrapper which handles; the true original was never reached.
    expect(previewA).toHaveBeenCalledTimes(1)
    expect(previewB).toHaveBeenCalledTimes(1)
    expect(surface.calls).toHaveLength(0)
  })

  it('repeated dispose is a no-op', async () => {
    const surface = makeOwnSurface()
    const decorator = new WorkspacesOpenPathDecorator(surface, () => 's1')
    decorator.install(vi.fn(async () => 'handled' as const))
    decorator.dispose()
    decorator.dispose()
    await surface.openPath('/w/d.ts')
    expect(surface.calls).toEqual(['/w/d.ts'])
  })

  it('explicit openSystemPath bypasses the wrapper entirely', async () => {
    const surface = makeOwnSurface()
    const preview = vi.fn(async () => 'handled' as const)
    const decorator = new WorkspacesOpenPathDecorator(surface, () => 's1')
    decorator.install(preview)
    await decorator.openSystemPath('/w/explicit.ts')
    // The wrapper was never involved, so preview was not called even for a known extension.
    expect(preview).not.toHaveBeenCalled()
    expect(surface.calls).toEqual(['/w/explicit.ts'])
  })
})
