import { mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DESKTOP_DOWNLOAD_URLS,
  MAX_UPDATE_DOWNLOAD_BYTES,
  UpdateDownloadError,
  downloadDesktopUpdate,
  type DesktopDownloadPlatform,
  type UpdateArtifactRequest,
} from '../src/update-download.ts'

const temporaryRoots: string[] = []

async function temporaryUserData(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-update-download-'))
  temporaryRoots.push(root)
  return root
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

function chunkedResponse(chunks: readonly Uint8Array[], headers: HeadersInit = {}): Response {
  let index = 0
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index]
      index += 1
      if (chunk === undefined) controller.close()
      else controller.enqueue(chunk)
    },
  }), { status: 200, headers })
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

async function expectNoPartialFiles(userDataPath: string, version: string): Promise<void> {
  const entries = await readdir(join(userDataPath, 'updates', version))
  expect(entries.filter(entry => entry.endsWith('.partial'))).toEqual([])
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('desktop update installer download', () => {
  it('streams a macOS DMG from only the fixed endpoint and atomically completes it', async () => {
    const userDataPath = await temporaryUserData()
    const artifact = dmgArtifact()
    const calls: Array<{ url: string; init: RequestInit }> = []
    const request: UpdateArtifactRequest = async (url, init) => {
      calls.push({ url, init })
      return chunkedResponse([artifact.subarray(0, 333), artifact.subarray(333)])
    }

    const result = await downloadDesktopUpdate({
      platform: 'darwin',
      version: '2.1.0',
      userDataPath,
      request,
    })

    expect(result).toBe(join(userDataPath, 'updates', '2.1.0', 'DSH-Desktop-2.1.0-mac.dmg'))
    expect(await readFile(result)).toEqual(Buffer.from(artifact))
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(DESKTOP_DOWNLOAD_URLS.darwin)
    expect(calls[0]?.init).toMatchObject({ method: 'GET', cache: 'no-store', redirect: 'follow' })
    await expectNoPartialFiles(userDataPath, '2.1.0')
  })

  it('accepts a Windows executable only when it has both MZ and PE signatures', async () => {
    const userDataPath = await temporaryUserData()
    const artifact = windowsArtifact()
    const result = await downloadDesktopUpdate({
      platform: 'win32',
      version: '2.2.0',
      userDataPath,
      request: async (url) => {
        expect(url).toBe(DESKTOP_DOWNLOAD_URLS.win32)
        return chunkedResponse([artifact])
      },
    })

    expect(result).toBe(join(userDataPath, 'updates', '2.2.0', 'DSH-Desktop-2.2.0-windows.exe'))
    expect(await readFile(result)).toEqual(Buffer.from(artifact))
    await expectNoPartialFiles(userDataPath, '2.2.0')
  })

  it('accepts canonical stable SemVer build metadata in the private artifact path', async () => {
    const userDataPath = await temporaryUserData()
    const result = await downloadDesktopUpdate({
      platform: 'darwin',
      version: '2.8.0+build',
      userDataPath,
      request: async () => chunkedResponse([dmgArtifact()]),
    })

    expect(result).toBe(join(
      userDataPath,
      'updates',
      '2.8.0+build',
      'DSH-Desktop-2.8.0+build-mac.dmg',
    ))
  })

  it.each([
    ['darwin', new Uint8Array(1024)],
    ['win32', Object.assign(windowsArtifact(), { 0: 0 })],
    ['win32', Object.assign(windowsArtifact(), { 0x80: 0 })],
  ] as const)('rejects and removes an invalid %s artifact', async (platform, artifact) => {
    const userDataPath = await temporaryUserData()
    await expectFailure(downloadDesktopUpdate({
      platform,
      version: '2.3.0',
      userDataPath,
      request: async () => chunkedResponse([artifact]),
    }), 'invalid-artifact')
    await expectNoPartialFiles(userDataPath, '2.3.0')
    expect(await readdir(join(userDataPath, 'updates', '2.3.0'))).toEqual([])
  })

  it.each([
    ['an unsuccessful response', async () => new Response(null, { status: 503 }), 'http-status'],
    ['a missing response body', async () => new Response(null, { status: 200 }), 'empty-body'],
    ['a zero-byte response body', async () => chunkedResponse([]), 'empty-body'],
  ] as const)('rejects %s without leaving a partial file', async (_label, request, code) => {
    const userDataPath = await temporaryUserData()
    await expectFailure(downloadDesktopUpdate({
      platform: 'darwin',
      version: '2.4.0',
      userDataPath,
      request,
    }), code)
    await expectNoPartialFiles(userDataPath, '2.4.0')
  })

  it('rejects a declared body above the fixed 1 GiB limit before writing it', async () => {
    const userDataPath = await temporaryUserData()
    await expectFailure(downloadDesktopUpdate({
      platform: 'darwin',
      version: '2.5.0',
      userDataPath,
      request: async () => chunkedResponse(
        [dmgArtifact()],
        { 'content-length': String(MAX_UPDATE_DOWNLOAD_BYTES + 1) },
      ),
    }), 'response-too-large')
    await expectNoPartialFiles(userDataPath, '2.5.0')
  })

  it('passes the caller signal and removes a partial file when aborted during streaming', async () => {
    const userDataPath = await temporaryUserData()
    const controller = new AbortController()
    let requestSignal: AbortSignal | null | undefined
    const request: UpdateArtifactRequest = async (_url, init) => {
      requestSignal = init.signal
      return new Response(new ReadableStream<Uint8Array>({
        pull(stream) {
          stream.enqueue(dmgArtifact().subarray(0, 128))
          controller.abort(new DOMException('stop', 'AbortError'))
        },
      }))
    }

    await expectFailure(downloadDesktopUpdate({
      platform: 'darwin',
      version: '2.6.0',
      userDataPath,
      request,
      signal: controller.signal,
    }), 'aborted')
    expect(requestSignal).toBe(controller.signal)
    await expectNoPartialFiles(userDataPath, '2.6.0')
  })

  it('normalizes request aborts and transport failures without creating an artifact', async () => {
    const userDataPath = await temporaryUserData()
    await expectFailure(downloadDesktopUpdate({
      platform: 'darwin',
      version: '2.7.0',
      userDataPath,
      request: async () => { throw new DOMException('cancelled', 'AbortError') },
    }), 'aborted')
    await expectFailure(downloadDesktopUpdate({
      platform: 'darwin',
      version: '2.7.1',
      userDataPath,
      request: async () => { throw new Error('offline') },
    }), 'network')
    await expectNoPartialFiles(userDataPath, '2.7.0')
    await expectNoPartialFiles(userDataPath, '2.7.1')
  })

  it.each([
    ['linux', '2.8.0'],
    ['darwin', '../2.8.0'],
    ['win32', 'v2.8.0'],
    ['win32', '2.8.0-rc.1'],
  ])('rejects platform %s and version %s before requesting', async (platform, version) => {
    const userDataPath = await temporaryUserData()
    let requested = false
    await expectFailure(downloadDesktopUpdate({
      platform: platform as DesktopDownloadPlatform,
      version,
      userDataPath,
      request: async () => {
        requested = true
        return chunkedResponse([dmgArtifact()])
      },
    }), 'invalid-options')
    expect(requested).toBe(false)
  })

  it('rejects a relative user-data path before requesting', async () => {
    let requested = false
    const request = async (): Promise<Response> => {
      requested = true
      return chunkedResponse([dmgArtifact()])
    }

    await expectFailure(downloadDesktopUpdate({
      platform: 'darwin',
      version: '2.9.0',
      userDataPath: 'relative',
      request,
    }), 'invalid-options')
    expect(requested).toBe(false)
  })

  it('rejects a linked user-data path before requesting', async () => {
    const userDataPath = await temporaryUserData()
    const linked = `${userDataPath}-link`
    temporaryRoots.push(linked)
    await symlink(userDataPath, linked, process.platform === 'win32' ? 'junction' : 'dir')
    let requested = false
    const request = async (): Promise<Response> => {
      requested = true
      return chunkedResponse([dmgArtifact()])
    }

    await expectFailure(downloadDesktopUpdate({
      platform: 'darwin',
      version: '2.9.0',
      userDataPath: linked,
      request,
    }), 'invalid-options')
    expect(requested).toBe(false)
  })
})
