import sharp from 'sharp'
import { describe, expect, it, vi } from 'vitest'
import {
  MarketMediaError,
  createMarketMediaService,
  createRestrictedImageFetcher,
  marketMediaAssetUrl,
  normalizeMarketImage,
  normalizeAllowedHostnames,
  validateRemoteImageUrl,
  type MarketMediaCandidate,
} from '../src/media/index.js'

const candidate = (overrides: Partial<MarketMediaCandidate> = {}): MarketMediaCandidate => ({
  remoteUrl: 'https://github.com/anywhere-labs.png?size=128',
  role: 'publisher-avatar',
  alt: 'Anywhere Labs',
  sourceRecordId: '018f1f77-a5c4-7b73-a9ae-0242ac120002',
  itemId: 'anywhere-labs/deepseek-harness-desktop',
  allowedHostnames: ['github.com', 'avatars.githubusercontent.com'],
  ...overrides,
})

describe('market media service', () => {
  it('issues an opaque reference and never treats an unknown reference as a URL', async () => {
    const fetchImage = vi.fn()
    const service = createMarketMediaService({ fetchImage })
    const assetRef = service.register(candidate())

    expect(assetRef).toMatch(/^mktimg_[A-Za-z0-9_-]{32}$/u)
    expect(assetRef).not.toContain('github')
    expect(marketMediaAssetUrl(assetRef)).toBe(`/api/community-market/assets?ref=${assetRef}`)
    await expect(service.resolve('mktimg_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', new AbortController().signal))
      .resolves.toBeUndefined()
    expect(fetchImage).not.toHaveBeenCalled()
  })

  it('normalizes to a metadata-free 128px PNG and collapses concurrent reads', async () => {
    const input = await sharp({
      create: { width: 320, height: 160, channels: 3, background: '#eab308' },
    }).jpeg().withMetadata({ exif: { IFD0: { Copyright: 'must be removed' } } }).toBuffer()
    let releaseFetch: (() => void) | undefined
    const gate = new Promise<void>(resolve => { releaseFetch = resolve })
    const fetchImage = vi.fn(async () => {
      await gate
      return {
        body: input,
        contentType: 'image/jpeg' as const,
        finalUrl: 'https://github.com/anywhere-labs.png?size=128',
      }
    })
    const service = createMarketMediaService({ fetchImage })
    const assetRef = service.register(candidate())
    const signal = new AbortController().signal
    const first = service.resolve(assetRef, signal)
    const second = service.resolve(assetRef, signal)
    releaseFetch?.()
    const [one, two] = await Promise.all([first, second])

    expect(fetchImage).toHaveBeenCalledOnce()
    expect(one).toEqual(two)
    expect(one).toMatchObject({ contentType: 'image/png', etag: expect.stringMatching(/^"sha256-/u) })
    const metadata = await sharp(one!.body).metadata()
    expect(metadata).toMatchObject({ format: 'png', width: 128, height: 128 })
    expect(metadata.exif).toBeUndefined()

    await service.resolve(assetRef, signal)
    expect(fetchImage).toHaveBeenCalledOnce()
  })

  it('deduplicates registrations and can revoke every asset from one source', async () => {
    const service = createMarketMediaService({ fetchImage: vi.fn() })
    const first = service.register(candidate())
    const second = service.register(candidate())
    expect(second).toBe(first)

    service.unregisterSource(candidate().sourceRecordId)
    await expect(service.resolve(first, new AbortController().signal)).resolves.toBeUndefined()
  })

  it('aborts owned image work and rejects new registrations after disposal', async () => {
    const fetchImage = vi.fn(async (_candidate, signal: AbortSignal) => await new Promise<never>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    }))
    const service = createMarketMediaService({ fetchImage })
    const assetRef = service.register(candidate())
    const pending = service.resolve(assetRef, new AbortController().signal)
    await vi.waitFor(() => { expect(fetchImage).toHaveBeenCalledOnce() })

    service.dispose()
    service.dispose()

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    await expect(service.resolve(assetRef, new AbortController().signal)).resolves.toBeUndefined()
    expect(() => service.register(candidate({ itemId: 'after-dispose' }))).toThrow(/disposed/u)
  })

  it('bounds registered candidates and expires the least recently used reference', async () => {
    const refs = [
      'mktimg_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      'mktimg_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    ]
    const service = createMarketMediaService({
      fetchImage: vi.fn(),
      maxRegisteredAssets: 1,
      createAssetRef: () => refs.shift()!,
    })
    const first = service.register(candidate({ itemId: 'first' }))
    const second = service.register(candidate({ itemId: 'second' }))

    expect(second).not.toBe(first)
    await expect(service.resolve(first, new AbortController().signal)).resolves.toBeUndefined()
  })

  it('bounds concurrent network and decode work across different assets', async () => {
    let active = 0
    let peak = 0
    const releases: Array<() => void> = []
    const fetchImage = vi.fn(async () => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise<void>(resolve => { releases.push(resolve) })
      active -= 1
      return {
        body: Buffer.from('fixture'),
        contentType: 'image/png' as const,
        finalUrl: 'https://github.com/fixture.png',
      }
    })
    const service = createMarketMediaService({
      fetchImage,
      normalizeImage: async image => image.body,
      maxConcurrentResolutions: 2,
    })
    const refs = ['one', 'two', 'three'].map(itemId => service.register(candidate({ itemId })))
    const pending = refs.map(ref => service.resolve(ref, new AbortController().signal))

    await vi.waitFor(() => { expect(fetchImage).toHaveBeenCalledTimes(2) })
    releases.shift()?.()
    await vi.waitFor(() => { expect(fetchImage).toHaveBeenCalledTimes(3) })
    releases.splice(0).forEach(release => release())
    await Promise.all(pending)

    expect(peak).toBe(2)
  })

  it('rejects an image whose decoded format disagrees with its declared media type', async () => {
    const body = await sharp({
      create: { width: 16, height: 16, channels: 4, background: '#ffffff' },
    }).png().toBuffer()

    await expect(normalizeMarketImage({
      body,
      contentType: 'image/jpeg',
      finalUrl: 'https://github.com/anywhere-labs.png',
    })).rejects.toMatchObject({ code: 'invalid-image' })
  })
})

describe('restricted market image fetcher', () => {
  it('normalizes reviewed hostnames without accepting wildcards, ports, paths, or IP literals', () => {
    expect(normalizeAllowedHostnames([
      'avatars.githubusercontent.com',
      'GitHub.com',
      'github.com',
    ])).toEqual(['avatars.githubusercontent.com', 'github.com'])

    for (const value of [
      '',
      '*.github.com',
      'github.com/avatar.png',
      'github.com:443',
      '127.0.0.1',
      'github.com@attacker.example',
    ]) {
      expect(() => normalizeAllowedHostnames([value]), value)
        .toThrow(MarketMediaError)
    }
  })

  it('validates remote image URLs against the exact reviewed host set', () => {
    const allowed = new Set(['github.com', 'avatars.githubusercontent.com'])

    expect(validateRemoteImageUrl('https://github.com/anywhere-labs.png?size=128', allowed).href)
      .toBe('https://github.com/anywhere-labs.png?size=128')
    expect(validateRemoteImageUrl('https://github.com:443/anywhere-labs.png', allowed).href)
      .toBe('https://github.com/anywhere-labs.png')

    for (const value of [
      'http://github.com/anywhere-labs.png',
      'https://github.com:444/anywhere-labs.png',
      'https://user:pass@github.com/anywhere-labs.png',
      'https://github.com/anywhere-labs.png#fragment',
      'https://github.com.attacker.example/anywhere-labs.png',
      'not a url',
    ]) {
      expect(() => validateRemoteImageUrl(value, allowed), value)
        .toThrow(MarketMediaError)
    }
  })

  it('pins every redirect DNS lookup and permits only adapter-reviewed hosts', async () => {
    const lookupAddresses = vi.fn(async (_hostname: string) => [{ address: '93.184.216.34', family: 4 as const }])
    const request = vi.fn()
      .mockResolvedValueOnce({
        statusCode: 302,
        headers: { location: 'https://avatars.githubusercontent.com/u/1?v=4' },
        body: Buffer.alloc(0),
      })
      .mockResolvedValueOnce({
        statusCode: 200,
        headers: { 'content-type': 'image/png', 'content-encoding': 'identity' },
        body: Buffer.from('not decoded at the network boundary'),
      })
    const fetchImage = createRestrictedImageFetcher({ lookupAddresses, request })

    const response = await fetchImage(candidate(), new AbortController().signal)
    expect(response.finalUrl).toBe('https://avatars.githubusercontent.com/u/1?v=4')
    expect(lookupAddresses.mock.calls.map(call => call[0])).toEqual([
      'github.com',
      'avatars.githubusercontent.com',
    ])
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('rejects private DNS results before issuing a request', async () => {
    const request = vi.fn()
    const fetchImage = createRestrictedImageFetcher({
      lookupAddresses: vi.fn(async (_hostname: string) => [{ address: '127.0.0.1', family: 4 as const }]),
      request,
    })
    await expect(fetchImage(candidate(), new AbortController().signal))
      .rejects.toMatchObject({ code: 'blocked-address' })
    expect(request).not.toHaveBeenCalled()
  })

  it('allows fake-IP proxy addresses only for an exact product-reviewed hostname', async () => {
    const request = vi.fn(async () => ({
      statusCode: 200,
      headers: { 'content-type': 'image/png' },
      body: Buffer.from('network boundary only'),
    }))
    const lookupAddresses = vi.fn(async (_hostname: string) => [{ address: '198.18.0.42', family: 4 as const }])
    const allowedFetcher = createRestrictedImageFetcher({
      syntheticProxyHostnames: ['github.com'],
      lookupAddresses,
      request,
    })
    await expect(allowedFetcher(
      candidate({ allowedHostnames: ['github.com'] }),
      new AbortController().signal,
    )).resolves.toMatchObject({ contentType: 'image/png' })

    const blockedFetcher = createRestrictedImageFetcher({ lookupAddresses, request })
    await expect(blockedFetcher(
      candidate({ allowedHostnames: ['github.com'] }),
      new AbortController().signal,
    )).rejects.toMatchObject({ code: 'blocked-address' })
  })

  it('rejects redirects outside the reviewed hostname set and non-image responses', async () => {
    const lookupAddresses = vi.fn(async (_hostname: string) => [{ address: '93.184.216.34', family: 4 as const }])
    const redirectFetcher = createRestrictedImageFetcher({
      lookupAddresses,
      request: vi.fn(async () => ({
        statusCode: 302,
        headers: { location: 'https://tracker.example/avatar.png' },
        body: Buffer.alloc(0),
      })),
    })
    await expect(redirectFetcher(candidate(), new AbortController().signal))
      .rejects.toBeInstanceOf(MarketMediaError)
    expect(lookupAddresses).toHaveBeenCalledOnce()

    const htmlFetcher = createRestrictedImageFetcher({
      lookupAddresses,
      request: vi.fn(async () => ({
        statusCode: 200,
        headers: { 'content-type': 'text/html' },
        body: Buffer.from('<html></html>'),
      })),
    })
    await expect(htmlFetcher(candidate(), new AbortController().signal))
      .rejects.toMatchObject({ code: 'response' })
  })

  it('enforces the compressed response size limit', async () => {
    const fetchImage = createRestrictedImageFetcher({
      maxBodyBytes: 8,
      lookupAddresses: vi.fn(async (_hostname: string) => [{ address: '93.184.216.34', family: 4 as const }]),
      request: vi.fn(async () => ({
        statusCode: 200,
        headers: { 'content-type': 'image/png' },
        body: Buffer.alloc(9),
      })),
    })
    await expect(fetchImage(candidate(), new AbortController().signal))
      .rejects.toMatchObject({ code: 'response' })
  })

  it('enforces the total deadline while DNS resolution remains pending', async () => {
    vi.useFakeTimers()
    try {
      const request = vi.fn()
      let releaseLookup: ((addresses: readonly [{ address: string; family: 4 }]) => void) | undefined
      const lookup = new Promise<readonly [{ address: string; family: 4 }]>(resolve => { releaseLookup = resolve })
      const fetchImage = createRestrictedImageFetcher({
        lookupAddresses: vi.fn(async () => await lookup),
        request,
        totalTimeoutMs: 30,
      })
      const result = expect(fetchImage(candidate(), new AbortController().signal))
        .rejects.toMatchObject({ code: 'timeout' })

      await vi.advanceTimersByTimeAsync(30)
      await result
      releaseLookup?.([{ address: '93.184.216.34', family: 4 }])
      await vi.advanceTimersByTimeAsync(0)
      expect(request).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
