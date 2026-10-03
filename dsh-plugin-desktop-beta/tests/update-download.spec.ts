import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DESKTOP_DOWNLOAD_URLS,
  DESKTOP_TARGET_VERSION_HEADER,
  MAX_UPDATE_DOWNLOAD_BYTES,
  UpdateDownloadError,
  desktopUpdateFilename,
  downloadDesktopUpdate,
  pendingDesktopUpdateArtifact,
  recordDesktopUpdateArtifact,
  resolveDesktopUpdateArtifact,
  type DesktopDownloadPlatform,
  type UpdateArtifactRequest,
  type UpdateArtifactResponse,
} from '../src/update-download.ts'
import { DESKTOP_RELEASE_CHANNEL_HEADER } from '../src/update-checker.ts'

const temporaryRoots: string[] = []

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-update-download-'))
  temporaryRoots.push(root)
  return root
}

function destinationPath(root: string, platform: DesktopDownloadPlatform, version: string): string {
  return join(root, desktopUpdateFilename(platform, version))
}

function dmgArtifact(): Uint8Array {
  const artifact = Buffer.alloc(1024, 0x5a)
  artifact.write('koly', artifact.byteLength - 512, 'ascii')
  return artifact
}

function windowsArtifact(): Uint8Array {
  const artifact = Buffer.alloc(512, 0)
  artifact.write('MZ', 0, 'ascii')
  artifact.writeUInt32LE(0x80, 0x3c)
  artifact.set([0x50, 0x45, 0x00, 0x00], 0x80)
  return artifact
}

function chunkedResponse(
  chunks: readonly Uint8Array[],
  headers: HeadersInit = {},
  finalUrl: string = 'https://www.dshdesktop.cn/api/downloads/mac',
): UpdateArtifactResponse {
  let index = 0
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index]
      index += 1
      if (chunk === undefined) controller.close()
      else controller.enqueue(chunk)
    },
  }), { status: 200, headers })
  // The settled URL is reported explicitly: Electron net.fetch Responses
  // carry an empty url, so the gate must never read it off the Response.
  return { response, finalUrl }
}

async function expectFailure(
  promise: Promise<unknown>,
  code: UpdateDownloadError['code'],
): Promise<UpdateDownloadError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(UpdateDownloadError)
    expect(error).toMatchObject({ code })
    return error as UpdateDownloadError
  }
  throw new Error('Expected update download to fail.')
}

async function expectNoPartialFiles(directory: string): Promise<void> {
  const entries = await readdir(directory)
  expect(entries.filter(entry => entry.endsWith('.partial'))).toEqual([])
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('desktop update installer download', () => {
  it('pins a Beta artifact request to its channel and target version', async () => {
    const directory = await temporaryDirectory()
    const artifact = dmgArtifact()
    const destination = join(directory, 'DSH-Desktop-Beta-2.0.6-beta.1-mac.dmg')
    const result = await downloadDesktopUpdate({
      platform: 'darwin',
      version: '2.0.6-beta.1',
      channel: 'beta',
      destinationPath: destination,
      request: async (_url, init) => {
        const headers = new Headers(init.headers)
        expect(headers.get(DESKTOP_RELEASE_CHANNEL_HEADER)).toBe('beta')
    expect(headers.get(DESKTOP_TARGET_VERSION_HEADER)).toBe('2.0.6-beta.1')
        return chunkedResponse([artifact], {
          [DESKTOP_RELEASE_CHANNEL_HEADER]: 'beta',
      [DESKTOP_TARGET_VERSION_HEADER]: '2.0.6-beta.1',
        })
      },
    })
    expect(result).toBe(destination)
    expect(desktopUpdateFilename('darwin', '2.0.6-beta.1', 'beta'))
      .toBe('DSH-Desktop-Beta-2.0.6-beta.1-mac.dmg')
  })

  it('accepts a Beta artifact without response identity headers', async () => {
    const directory = await temporaryDirectory()
    const result = await downloadDesktopUpdate({
      platform: 'darwin',
      version: '2.0.6-beta.1',
      channel: 'beta',
      destinationPath: join(directory, 'DSH-Desktop-Beta-2.0.6-beta.1-mac.dmg'),
      request: async () => chunkedResponse([dmgArtifact()], {}, 'https://cdn-lfs-cn-1.modelscope.cn/installer.dmg'),
    })
    expect(result).toBe(join(directory, 'DSH-Desktop-Beta-2.0.6-beta.1-mac.dmg'))
  })

  it('streams a macOS DMG from only the fixed endpoint and atomically completes it', async () => {
    const directory = await temporaryDirectory()
    const artifact = dmgArtifact()
    const calls: Array<{ url: string; init: RequestInit }> = []
    const request: UpdateArtifactRequest = async (url, init) => {
      calls.push({ url, init })
      return chunkedResponse([artifact.subarray(0, 333), artifact.subarray(333)])
    }

    const result = await downloadDesktopUpdate({
      platform: 'darwin',
      version: '2.1.0',
      destinationPath: destinationPath(directory, 'darwin', '2.1.0'),
      request,
    })

    expect(result).toBe(join(directory, 'DSH-Desktop-2.1.0-mac.dmg'))
    expect(await readFile(result)).toEqual(Buffer.from(artifact))
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(DESKTOP_DOWNLOAD_URLS.darwin)
    expect(calls[0]?.init).toMatchObject({ method: 'GET', cache: 'no-store', redirect: 'follow' })
    await expectNoPartialFiles(directory)
  })

  it('accepts a Windows executable only when it has both MZ and PE signatures', async () => {
    const directory = await temporaryDirectory()
    const artifact = windowsArtifact()
    const result = await downloadDesktopUpdate({
      platform: 'win32',
      version: '2.2.0',
      destinationPath: destinationPath(directory, 'win32', '2.2.0'),
      request: async (url) => {
        expect(url).toBe(DESKTOP_DOWNLOAD_URLS.win32)
        return chunkedResponse([artifact], {}, 'https://www.dshdesktop.cn/api/downloads/windows')
      },
    })

    expect(result).toBe(join(directory, 'DSH-Desktop-2.2.0-windows.exe'))
    expect(await readFile(result)).toEqual(Buffer.from(artifact))
    await expectNoPartialFiles(directory)
  })

  it.each([
    'https://modelscope.cn/models/t4wefan/deepseek-harness-desktop/resolve/master/installer.dmg',
    'https://cdn-lfs-cn-1.modelscope.cn/installer.dmg',
    'https://other.example/installer.dmg',
    'https://modelscope.cn/models/another-user/another-repo/installer.dmg',
  ])('accepts a valid installer from an HTTPS redirect to %s', async finalUrl => {
    const directory = await temporaryDirectory()
    const artifact = dmgArtifact()
    const result = await downloadDesktopUpdate({
      platform: 'darwin',
      version: '2.2.1',
      destinationPath: destinationPath(directory, 'darwin', '2.2.1'),
      request: async () => chunkedResponse(
        [artifact],
        {},
        finalUrl,
      ),
    })
    expect(await readFile(result)).toEqual(Buffer.from(artifact))
  })

  it.each([
    ['an https downgrade', 'http://www.dshdesktop.cn/api/downloads/mac'],
    ['embedded credentials', 'https://user:password@cdn.example/installer.dmg'],
    ['a non-HTTPS port', 'https://cdn.example:8080/installer.dmg'],
    ['a missing final URL', ''],
  ] as const)('rejects a download that settles on %s', async (_label, finalUrl) => {
    const directory = await temporaryDirectory()
    await expectFailure(downloadDesktopUpdate({
      platform: 'darwin',
      version: '2.3.0',
      destinationPath: destinationPath(directory, 'darwin', '2.3.0'),
      request: async () => chunkedResponse([dmgArtifact()], {}, finalUrl),
    }), 'redirect-origin')
    await expectNoPartialFiles(directory)
  })

  it('cancels the response body when the HTTPS check rejects the settled URL', async () => {
    const directory = await temporaryDirectory()
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull(stream) { stream.enqueue(dmgArtifact()) },
      cancel() { cancelled = true },
    })
    await expectFailure(downloadDesktopUpdate({
      platform: 'darwin',
      version: '2.3.0',
      destinationPath: destinationPath(directory, 'darwin', '2.3.0'),
      request: async () => ({
        response: new Response(body, { status: 200 }),
        finalUrl: 'http://cdn.example/installer.dmg',
      }),
    }), 'redirect-origin')
    expect(cancelled).toBe(true)
    await expectNoPartialFiles(directory)
  })

  it('cancels the response body when the HTTP status is unsuccessful', async () => {
    const directory = await temporaryDirectory()
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull(stream) { stream.enqueue(Buffer.from('service unavailable')) },
      cancel() { cancelled = true },
    })
    await expectFailure(downloadDesktopUpdate({
      platform: 'darwin',
      version: '2.4.1',
      destinationPath: destinationPath(directory, 'darwin', '2.4.1'),
      request: async () => ({
        response: new Response(body, { status: 503 }),
        finalUrl: 'https://www.dshdesktop.cn/api/downloads/mac',
      }),
    }), 'http-status')
    expect(cancelled).toBe(true)
    await expectNoPartialFiles(directory)
  })

  it('enforces an expected installer digest before completing the download', async () => {
    const directory = await temporaryDirectory()
    const artifact = dmgArtifact()
    const digest = createHash('sha256').update(artifact).digest('hex')
    const valid = await downloadDesktopUpdate({
      platform: 'darwin',
      version: '2.3.1',
      destinationPath: destinationPath(directory, 'darwin', '2.3.1'),
      request: async () => chunkedResponse([artifact]),
      expectedSha256: digest,
    })
    expect(await readFile(valid)).toEqual(Buffer.from(artifact))

    // Hex case is normalized, matching the version-checker parsing path.
    const upper = await downloadDesktopUpdate({
      platform: 'darwin',
      version: '2.3.4',
      destinationPath: destinationPath(directory, 'darwin', '2.3.4'),
      request: async () => chunkedResponse([artifact]),
      expectedSha256: digest.toUpperCase(),
    })
    expect(await readFile(upper)).toEqual(Buffer.from(artifact))

    const otherDirectory = await temporaryDirectory()
    await expectFailure(downloadDesktopUpdate({
      platform: 'darwin',
      version: '2.3.2',
      destinationPath: destinationPath(otherDirectory, 'darwin', '2.3.2'),
      request: async () => chunkedResponse([artifact]),
      expectedSha256: 'a'.repeat(64),
    }), 'invalid-artifact')
    await expectNoPartialFiles(otherDirectory)
  })

  it('rejects a malformed expected digest before issuing any request', async () => {
    const directory = await temporaryDirectory()
    const request = vi.fn()
    await expectFailure(downloadDesktopUpdate({
      platform: 'darwin',
      version: '2.3.3',
      destinationPath: destinationPath(directory, 'darwin', '2.3.3'),
      request,
      expectedSha256: 'not-a-sha256',
    }), 'invalid-options')
    expect(request).not.toHaveBeenCalled()
    await expectNoPartialFiles(directory)
  })

  it('accepts canonical stable SemVer build metadata in the private artifact path', async () => {
    const directory = await temporaryDirectory()
    const result = await downloadDesktopUpdate({
      platform: 'darwin',
      version: '2.8.0+build',
      destinationPath: destinationPath(directory, 'darwin', '2.8.0+build'),
      request: async () => chunkedResponse([dmgArtifact()]),
    })

    expect(result).toBe(join(
      directory,
      'DSH-Desktop-2.8.0+build-mac.dmg',
    ))
  })

  it.each([
    ['darwin', new Uint8Array(1024)],
    ['win32', Object.assign(windowsArtifact(), { 0: 0 })],
    ['win32', Object.assign(windowsArtifact(), { 0x80: 0 })],
  ] as const)('rejects and removes an invalid %s artifact', async (platform, artifact) => {
    const directory = await temporaryDirectory()
    await expectFailure(downloadDesktopUpdate({
      platform,
      version: '2.3.0',
      destinationPath: destinationPath(directory, platform, '2.3.0'),
      request: async () => chunkedResponse([artifact]),
    }), 'invalid-artifact')
    await expectNoPartialFiles(directory)
    expect(await readdir(directory)).toEqual([])
  })

  it('keeps an existing destination until its validated replacement is ready', async () => {
    const directory = await temporaryDirectory()
    const path = destinationPath(directory, 'win32', '2.3.1')
    const existing = Buffer.from('existing installer')
    await writeFile(path, existing)

    await expectFailure(downloadDesktopUpdate({
      platform: 'win32',
      version: '2.3.1',
      destinationPath: path,
      request: async () => chunkedResponse([Buffer.alloc(128)]),
    }), 'invalid-artifact')
    expect(await readFile(path)).toEqual(existing)

    const replacement = windowsArtifact()
    await downloadDesktopUpdate({
      platform: 'win32',
      version: '2.3.1',
      destinationPath: path,
      request: async () => chunkedResponse([replacement]),
    })
    expect(await readFile(path)).toEqual(Buffer.from(replacement))
    await expectNoPartialFiles(directory)
  })

  it.each([
    ['an unsuccessful response', async (): Promise<UpdateArtifactResponse> => ({
      response: new Response(null, { status: 503 }),
      finalUrl: 'https://www.dshdesktop.cn/api/downloads/mac',
    }), 'http-status'],
    ['a missing response body', async (): Promise<UpdateArtifactResponse> => ({
      response: new Response(null, { status: 200 }),
      finalUrl: 'https://www.dshdesktop.cn/api/downloads/mac',
    }), 'empty-body'],
    ['a zero-byte response body', async () => chunkedResponse([]), 'empty-body'],
  ] as const)('rejects %s without leaving a partial file', async (_label, request, code) => {
    const directory = await temporaryDirectory()
    await expectFailure(downloadDesktopUpdate({
      platform: 'darwin',
      version: '2.4.0',
      destinationPath: destinationPath(directory, 'darwin', '2.4.0'),
      request,
    }), code)
    await expectNoPartialFiles(directory)
  })

  it('rejects a declared body above the fixed 1 GiB limit before writing it', async () => {
    const directory = await temporaryDirectory()
    await expectFailure(downloadDesktopUpdate({
      platform: 'darwin',
      version: '2.5.0',
      destinationPath: destinationPath(directory, 'darwin', '2.5.0'),
      request: async () => chunkedResponse(
        [dmgArtifact()],
        { 'content-length': String(MAX_UPDATE_DOWNLOAD_BYTES + 1) },
      ),
    }), 'response-too-large')
    await expectNoPartialFiles(directory)
  })

  it('passes the caller signal and removes a partial file when aborted during streaming', async () => {
    const directory = await temporaryDirectory()
    const controller = new AbortController()
    let requestSignal: AbortSignal | null | undefined
    const request: UpdateArtifactRequest = async (_url, init) => {
      requestSignal = init.signal
      const response = new Response(new ReadableStream<Uint8Array>({
        pull(stream) {
          stream.enqueue(dmgArtifact().subarray(0, 128))
          controller.abort(new DOMException('stop', 'AbortError'))
        },
      }))
      return { response, finalUrl: 'https://www.dshdesktop.cn/api/downloads/mac' }
    }

    await expectFailure(downloadDesktopUpdate({
      platform: 'darwin',
      version: '2.6.0',
      destinationPath: destinationPath(directory, 'darwin', '2.6.0'),
      request,
      signal: controller.signal,
    }), 'aborted')
    expect(requestSignal).toBe(controller.signal)
    await expectNoPartialFiles(directory)
  })

  it('normalizes request aborts and transport failures without creating an artifact', async () => {
    const directory = await temporaryDirectory()
    await expectFailure(downloadDesktopUpdate({
      platform: 'darwin',
      version: '2.7.0',
      destinationPath: destinationPath(directory, 'darwin', '2.7.0'),
      request: async () => { throw new DOMException('cancelled', 'AbortError') },
    }), 'aborted')
    await expectFailure(downloadDesktopUpdate({
      platform: 'darwin',
      version: '2.7.1',
      destinationPath: destinationPath(directory, 'darwin', '2.7.1'),
      request: async () => { throw new Error('offline') },
    }), 'network')
    await expectNoPartialFiles(directory)
  })

  it.each([
    ['linux', '2.8.0'],
    ['darwin', '../2.8.0'],
    ['win32', 'v2.8.0'],
    ['win32', '2.8.0-rc.1'],
  ])('rejects platform %s and version %s before requesting', async (platform, version) => {
    const directory = await temporaryDirectory()
    let requested = false
    await expectFailure(downloadDesktopUpdate({
      platform: platform as DesktopDownloadPlatform,
      version,
      destinationPath: join(directory, 'installer.dmg'),
      request: async () => {
        requested = true
        return chunkedResponse([dmgArtifact()])
      },
    }), 'invalid-options')
    expect(requested).toBe(false)
  })

  it('rejects a relative destination path before requesting', async () => {
    let requested = false
    const request = async (): Promise<UpdateArtifactResponse> => {
      requested = true
      return chunkedResponse([dmgArtifact()])
    }

    await expectFailure(downloadDesktopUpdate({
      platform: 'darwin',
      version: '2.9.0',
      destinationPath: 'relative.dmg',
      request,
    }), 'invalid-options')
    expect(requested).toBe(false)
  })

  it('rejects a linked destination directory before requesting', async () => {
    const directory = await temporaryDirectory()
    const linked = `${directory}-link`
    temporaryRoots.push(linked)
    await symlink(directory, linked, process.platform === 'win32' ? 'junction' : 'dir')
    let requested = false
    const request = async (): Promise<UpdateArtifactResponse> => {
      requested = true
      return chunkedResponse([dmgArtifact()])
    }

    await expectFailure(downloadDesktopUpdate({
      platform: 'darwin',
      version: '2.9.0',
      destinationPath: join(linked, 'installer.dmg'),
      request,
    }), 'invalid-options')
    expect(requested).toBe(false)
  })
})

describe('desktop update artifact cleanup', () => {
  it('rejects malformed cleanup state with a typed failure', async () => {
    const userDataPath = await temporaryDirectory()
    const updates = join(userDataPath, 'updates')
    await mkdir(updates)
    await writeFile(join(updates, 'pending-installer.json'), '{}')

    await expectFailure(
      pendingDesktopUpdateArtifact(userDataPath, '2.1.0', 'win32'),
      'invalid-options',
    )
  })

  it('offers a recorded artifact only after the installed version reaches the update', async () => {
    const userDataPath = await temporaryDirectory()
    const downloads = await temporaryDirectory()
    const path = destinationPath(downloads, 'win32', '2.1.0')
    await writeFile(path, windowsArtifact())

    await recordDesktopUpdateArtifact(userDataPath, {
      platform: 'win32',
      version: '2.1.0',
      path,
    })

    await expect(pendingDesktopUpdateArtifact(userDataPath, '2.0.1', 'win32')).resolves.toBeUndefined()
    await expect(pendingDesktopUpdateArtifact(userDataPath, '2.1.0', 'win32')).resolves.toEqual({
      platform: 'win32',
      version: '2.1.0',
      path,
    })
  })

  it.each([false, true])('resolves one cleanup choice with remove=%s', async (remove) => {
    const userDataPath = await temporaryDirectory()
    const downloads = await temporaryDirectory()
    const artifact = {
      platform: 'darwin' as const,
      version: '2.1.0',
      path: destinationPath(downloads, 'darwin', '2.1.0'),
    }
    await writeFile(artifact.path, dmgArtifact())
    await recordDesktopUpdateArtifact(userDataPath, artifact)

    await resolveDesktopUpdateArtifact(userDataPath, artifact, remove)

    await expect(pendingDesktopUpdateArtifact(userDataPath, '2.1.0', 'darwin')).resolves.toBeUndefined()
    if (remove) await expect(access(artifact.path)).rejects.toMatchObject({ code: 'ENOENT' })
    else await expect(access(artifact.path)).resolves.toBeUndefined()
  })
})


it('downloads Next with a pinned release, a distinct filename and byte progress', async () => {
  const root = await temporaryDirectory();
  const progress = vi.fn();
  const request = vi.fn<UpdateArtifactRequest>(async () => chunkedResponse([dmgArtifact()], {'content-length':'1024'}));
  const filename = desktopUpdateFilename('darwin', '2.0.14-next', 'next');
  expect(filename).toContain('DSH-NEXT-2.0.14-next');
  const path = await downloadDesktopUpdate({platform:'darwin',version:'2.0.14-next',channel:'next',destinationPath:join(root,filename),request,onProgress:progress});
  expect((await readFile(path)).byteLength).toBe(1024);
  expect(progress).toHaveBeenLastCalledWith(1024,1024);
  const headers = new Headers(request.mock.calls[0]?.[1]?.headers);
  expect(headers.get(DESKTOP_RELEASE_CHANNEL_HEADER)).toBe('next');
  expect(headers.get(DESKTOP_TARGET_VERSION_HEADER)).toBe('2.0.14-next');
});
