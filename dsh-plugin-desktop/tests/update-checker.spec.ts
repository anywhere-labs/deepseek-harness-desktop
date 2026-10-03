import { describe, expect, it, vi } from 'vitest'
import {
  DESKTOP_CURRENT_VERSION_HEADER,
  DESKTOP_VERSION_ENDPOINT,
  MAX_VERSION_RESPONSE_BYTES,
  checkForStableUpdate,
  checkForDesktopUpdate,
  compareSemVerVersions,
  desktopVersionRequestHeaders,
  parseSemVer,
  type UpdateRequest,
} from '../src/update-checker.ts'
import {
  assertDesktopInstallationId,
  DESKTOP_INSTALLATION_ID_HEADER,
} from '../src/desktop-installation-id.ts'

const INSTALLATION_ID = assertDesktopInstallationId('01234567-89ab-4cde-8f01-23456789abcd')

function versionResponse(version: unknown, init: ResponseInit = {}): Response {
  return Response.json({ version }, init)
}

describe('strict SemVer parsing', () => {
  it('accepts a three-part version, optional lowercase v, prerelease, and build metadata', () => {
    expect(parseSemVer('v2.10.3-alpha.1+mac.arm64')).toEqual({
      version: '2.10.3-alpha.1+mac.arm64',
      major: '2',
      minor: '10',
      patch: '3',
      prerelease: ['alpha', '1'],
      build: ['mac', 'arm64'],
    })
    expect(parseSemVer('0.0.0')).not.toBeNull()
  })

  it.each([
    '1',
    '1.2',
    '01.2.3',
    '1.02.3',
    '1.2.03',
    '1.2.3-01',
    '1.2.3-alpha..1',
    '1.2.3+',
    'V1.2.3',
    ' 1.2.3',
  ])('rejects invalid SemVer %s', version => {
    expect(parseSemVer(version)).toBeNull()
  })

  it('compares strict versions without numeric overflow', () => {
    expect(compareSemVerVersions('2.1.0', '2.0.9')).toBeGreaterThan(0)
    expect(compareSemVerVersions('2.0.0-rc.1', '2.0.0')).toBeLessThan(0)
    expect(compareSemVerVersions('2.0', '2.0.0')).toBeNull()
    expect(compareSemVerVersions(
      '10000000000000000.0.0',
      '9007199254740992.0.0',
    )).toBeGreaterThan(0)
  })
})

describe('public Desktop version check', () => {
  it('uses only the fixed no-cache version endpoint and reports a newer stable version', async () => {
    const controller = new AbortController()
    const calls: Array<{ url: string, init: RequestInit }> = []
    const request: UpdateRequest = async (url, init) => {
      calls.push({ url, init })
      return versionResponse('2.10.0')
    }

    await expect(checkForStableUpdate({
      currentVersion: '2.9.9',
      installationId: INSTALLATION_ID,
      signal: controller.signal,
      request,
    })).resolves.toEqual({
      status: 'update-available',
      currentVersion: '2.9.9',
      latestVersion: '2.10.0',
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(DESKTOP_VERSION_ENDPOINT)
    expect(calls[0]?.url).not.toContain('/api/downloads/')
    expect(calls[0]?.init).toMatchObject({
      method: 'GET',
      cache: 'no-store',
      redirect: 'error',
      signal: controller.signal,
    })
    const headers = new Headers(calls[0]?.init.headers)
    expect(headers.get('accept')).toBe('application/json')
    expect(headers.get(DESKTOP_CURRENT_VERSION_HEADER)).toBe('2.9.9')
    expect(headers.get(DESKTOP_INSTALLATION_ID_HEADER)).toBe(INSTALLATION_ID)
    expect(headers.has('if-none-match')).toBe(false)
    expect(headers.has('x-github-api-version')).toBe(false)
  })

  it('builds a bounded version-check header set and rejects malformed identities', () => {
    expect(desktopVersionRequestHeaders(INSTALLATION_ID)).toEqual({
      Accept: 'application/json',
      [DESKTOP_INSTALLATION_ID_HEADER]: INSTALLATION_ID,
    })
    expect(desktopVersionRequestHeaders(INSTALLATION_ID, '2.9.9')).toEqual({
      Accept: 'application/json',
      [DESKTOP_CURRENT_VERSION_HEADER]: '2.9.9',
      [DESKTOP_INSTALLATION_ID_HEADER]: INSTALLATION_ID,
    })
    expect(desktopVersionRequestHeaders()).toEqual({ Accept: 'application/json' })
    expect(() => desktopVersionRequestHeaders(undefined, '2.9.0-rc.1')).toThrow('canonical stable SemVer')
    expect(() => desktopVersionRequestHeaders('not-a-uuid')).toThrow('canonical lowercase UUID v4')
  })

  it('skips the fixed endpoint when an invalid installation identity reaches the checker', async () => {
    const request = vi.fn(async () => versionResponse('2.1.0'))
    await expect(checkForStableUpdate({
      currentVersion: '2.0.0',
      installationId: 'not-a-uuid' as never,
      request,
    })).resolves.toBeNull()
    expect(request).not.toHaveBeenCalled()
  })

  it.each([
    ['2.0.0', '2.0.0'],
    ['2.0.1', '2.0.0'],
    ['2.0.0+installed', '2.0.0+release'],
  ])('reports no update for installed %s and service %s', async (currentVersion, latestVersion) => {
    await expect(checkForStableUpdate({
      currentVersion,
      request: async () => versionResponse(latestVersion),
    })).resolves.toEqual({
      status: 'up-to-date',
      currentVersion,
      latestVersion,
    })
  })

  it('surfaces per-platform installer digests with case normalization', async () => {
    const upper = 'A'.repeat(64)
    await expect(checkForStableUpdate({
      currentVersion: '2.0.0',
      request: async () => Response.json({
        version: '2.1.0',
        sha256: { windows: upper, mac: `  ${'b'.repeat(64)}  ` },
      }),
    })).resolves.toEqual({
      status: 'update-available',
      currentVersion: '2.0.0',
      latestVersion: '2.1.0',
      installerSha256: { win32: 'a'.repeat(64), darwin: 'b'.repeat(64) },
    })
  })

  it('ignores malformed installer digest fields without failing the check', async () => {
    await expect(checkForStableUpdate({
      currentVersion: '2.0.0',
      request: async () => Response.json({
        version: '2.1.0',
        sha256: { windows: 'not-hex', mac: 42, extra: true },
      }),
    })).resolves.toEqual({
      status: 'update-available',
      currentVersion: '2.0.0',
      latestVersion: '2.1.0',
    })
  })

  it('compares service versions without overflowing JavaScript numbers', async () => {
    await expect(checkForStableUpdate({
      currentVersion: '9007199254740992.0.0',
      request: async () => versionResponse('10000000000000000.0.0'),
    })).resolves.toMatchObject({ status: 'update-available' })
  })

  it.each([
    ['leading v', { version: 'v2.1.0' }],
    ['prerelease', { version: '2.1.0-rc.1' }],
    ['invalid SemVer', { version: '2.01.0' }],
    ['missing version', {}],
    ['non-string version', { version: 2 }],
    ['array response', ['2.1.0']],
  ])('silently ignores a service response with %s', async (_case, value) => {
    await expect(checkForStableUpdate({
      currentVersion: '2.0.0',
      request: async () => Response.json(value),
    })).resolves.toBeNull()
  })

  it('silently ignores malformed JSON and non-200 statuses', async () => {
    await expect(checkForStableUpdate({
      currentVersion: '2.0.0',
      request: async () => new Response('{'),
    })).resolves.toBeNull()
    await expect(checkForStableUpdate({
      currentVersion: '2.0.0',
      request: async () => new Response('unavailable', { status: 503 }),
    })).resolves.toBeNull()
    await expect(checkForStableUpdate({
      currentVersion: '2.0.0',
      request: async () => new Response(null, { status: 304 }),
    })).resolves.toBeNull()
  })

  it('silently ignores network failure and caller cancellation', async () => {
    await expect(checkForStableUpdate({
      currentVersion: '2.0.0',
      request: async () => { throw new TypeError('offline') },
    })).resolves.toBeNull()

    const controller = new AbortController()
    controller.abort()
    await expect(checkForStableUpdate({
      currentVersion: '2.0.0',
      signal: controller.signal,
      request: async () => { throw new DOMException('cancelled', 'AbortError') },
    })).resolves.toBeNull()
  })

  it('silently ignores declared and streamed oversized responses', async () => {
    await expect(checkForStableUpdate({
      currentVersion: '2.0.0',
      request: async () => new Response('{}', {
        headers: { 'content-length': String(MAX_VERSION_RESPONSE_BYTES + 1) },
      }),
    })).resolves.toBeNull()
    await expect(checkForStableUpdate({
      currentVersion: '2.0.0',
      request: async () => new Response('x'.repeat(MAX_VERSION_RESPONSE_BYTES + 1)),
    })).resolves.toBeNull()
  })

  it.each(['2.0', 'v2.0.0', '2.0.0-rc.1'])('skips invalid installed version %s before requesting', async currentVersion => {
    const request = vi.fn(async () => versionResponse('2.1.0'))

    await expect(checkForStableUpdate({ currentVersion, request })).resolves.toBeNull()
    expect(request).not.toHaveBeenCalled()
  })
})


describe('Next release isolation', () => {
  it.each(['2.0.14-next', '2.0.14-next.1'])('accepts installed %s and preserves its version header', async currentVersion => {
    const request = vi.fn<UpdateRequest>(async () => Response.json({ version: '2.0.17-next.1', channel: 'next' }));
    expect(await checkForDesktopUpdate({ currentVersion, channel: 'next', request })).toMatchObject({ status: 'update-available' });
    expect(new Headers(request.mock.calls[0]?.[1]?.headers).get(DESKTOP_CURRENT_VERSION_HEADER)).toBe(currentVersion);
  });
  it.each([{version:'2.0.17',channel:'stable'}, {version:'2.0.17-beta.1',channel:'next'}, {version:'2.0.17-next.1'}, {version:'2.0.17-next.01',channel:'next'}])('rejects a wrong or ambiguous Next release %j', async body => {
    expect(await checkForDesktopUpdate({ currentVersion:'2.0.14-next', channel:'next', request:async()=>Response.json(body) })).toBeNull();
  });
});
