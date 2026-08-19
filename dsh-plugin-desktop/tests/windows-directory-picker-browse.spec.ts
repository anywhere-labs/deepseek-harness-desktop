import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import DesktopWindowsBrowseDirectoryPicker, {
  filterUnreadableDirectoryLinks,
  isEnterableDirectoryLink,
} from '../src/windows-directory-picker-browse.ts'

describe('Windows browse directory-picker adapter', () => {
  it('uses opendir to distinguish inaccessible junctions from enterable directory links', async () => {
    const close = vi.fn(async () => {})
    const regular = vi.fn(async () => ({ isSymbolicLink: () => false }))
    const link = vi.fn(async () => ({ isSymbolicLink: () => true }))
    const open = vi.fn(async () => ({ close }))

    await expect(isEnterableDirectoryLink('C:\\Work', undefined, regular, open)).resolves.toBe(true)
    expect(open).not.toHaveBeenCalled()

    await expect(isEnterableDirectoryLink('C:\\Users\\tester\\OneDrive', undefined, link, open))
      .resolves.toBe(true)
    expect(open).toHaveBeenCalledWith('C:\\Users\\tester\\OneDrive')
    expect(close).toHaveBeenCalledOnce()

    const denied = vi.fn(async () => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
    })
    await expect(isEnterableDirectoryLink('C:\\Users\\tester\\My Documents', undefined, link, denied))
      .resolves.toBe(false)
  })

  it('filters only entries rejected by the accessibility probe', async () => {
    const listing = {
      path: 'C:\\Users\\tester',
      home: 'C:\\Users\\tester',
      crumbs: [],
      entries: [
        { name: 'Documents', path: 'C:\\Users\\tester\\Documents', hidden: false },
        { name: 'My Documents', path: 'C:\\Users\\tester\\My Documents', hidden: false },
        { name: 'OneDrive', path: 'C:\\Users\\tester\\OneDrive', hidden: false },
      ],
      truncated: false,
    }
    const probe = vi.fn(async (path: string) => !path.endsWith('My Documents'))

    const filtered = await filterUnreadableDirectoryLinks(listing, undefined, probe)

    expect(filtered).toEqual({
      ...listing,
      entries: [listing.entries[0], listing.entries[2]],
    })
    expect(probe).toHaveBeenCalledTimes(3)
  })

  it('retains the upstream browse capability and accessible junction behavior', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-directory-picker-'))
    const projects = join(root, 'projects')
    await mkdir(projects)
    await symlink(projects, join(root, 'linked'), 'junction')
    const ctx = new Context()
    const fiber = ctx.plugin(DesktopWindowsBrowseDirectoryPicker)
    await fiber.await()
    try {
      const capability = ctx.get('directoryPicker')!.capability()
      expect(capability.kind).toBe('browse')
      if (capability.kind !== 'browse') throw new Error('browse capability expected')
      await expect(capability.list(root)).resolves.toMatchObject({
        entries: [
          { name: 'linked', path: join(root, 'linked') },
          { name: 'projects', path: projects },
        ],
      })
      expect(ctx.get('directoryPicker')!.capability()).toBe(capability)
    } finally {
      await fiber.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('propagates caller cancellation instead of treating it as an unreadable link', async () => {
    const controller = new AbortController()
    controller.abort(new Error('caller left'))

    await expect(isEnterableDirectoryLink(
      'C:\\Users\\tester\\My Documents',
      controller.signal,
      async () => ({ isSymbolicLink: () => true }),
    )).rejects.toThrow('caller left')
  })
})
