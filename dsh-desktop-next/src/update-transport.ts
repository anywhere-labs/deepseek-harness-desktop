/** Installer transport: Chromium `net.request` follows redirects one hop at a time. */
import { Readable } from 'node:stream'
import { net, session } from 'electron'
import {
  assertSecureDownloadUrl,
  type UpdateArtifactRequest,
  type UpdateArtifactResponse,
} from '../../dsh-plugin-desktop-beta/src/update-download.ts'

/** Redirect hops accepted before the transport reports a loop. */
const MAX_REDIRECTS = 8

/**
 * Non-persistent partition for installer traffic. It starts with an empty
 * cookie jar, stores nothing, and therefore carries the `credentials: 'omit'`
 * guarantee the previous `net.fetch` request expressed directly.
 */
const UPDATE_PARTITION = 'dsh-next-update'

/** HTTP statuses whose Response must be constructed without a body stream. */
const NULL_BODY_STATUSES = new Set([204, 205, 304])

/**
 * Build the artifact transport for installer downloads.
 *
 * `net.fetch` cannot follow redirects manually: with `redirect: 'manual'` it
 * rejects with `Redirect was cancelled` instead of returning the 3xx response,
 * so a release service that redirects to storage can never be downloaded.
 * `net.request` emits a `redirect` event and waits for `followRedirect()` or
 * `abort()`, which supports the per-hop HTTPS check.
 *
 * @returns A request adapter that resolves with the settled response and URL.
 */
export function createArtifactRequest(): UpdateArtifactRequest {
  return (url, init) => requestArtifact(url, init)
}

function requestArtifact(url: string, init: RequestInit): Promise<UpdateArtifactResponse> {
  return new Promise<UpdateArtifactResponse>((resolve, reject) => {
    const signal = init.signal ?? undefined
    let current: Electron.ClientRequest | undefined
    let hops = 0
    let settled = false

    const release = (): void => { signal?.removeEventListener('abort', onAbort) }
    const finish = (value: UpdateArtifactResponse): void => {
      if (settled) return
      settled = true; release(); resolve(value)
    }
    const fail = (error: unknown): void => {
      if (settled) return
      settled = true; release()
      reject(error instanceof Error ? error : new Error(String(error)))
    }
    function onAbort(): void {
      const request = current; current = undefined
      // Settle first: aborting the request emits its own 'abort' event, which
      // must not replace the caller-visible cancellation error.
      fail(Object.assign(new Error('The update download was cancelled.'), { name: 'AbortError' }))
      try { request?.abort() } catch { /* the request may already be finished */ }
    }
    if (signal?.aborted === true) { onAbort(); return }
    signal?.addEventListener('abort', onAbort, { once: true })

    const open = (target: string): void => {
      if (settled) return
      let secure: URL
      try { secure = assertSecureDownloadUrl(target) } catch (error) { fail(error); return }
      if (hops >= MAX_REDIRECTS) { fail(new Error('Too many update redirects')); return }
      hops += 1
      // Only the first hop receives the release selectors; artifact storage
      // must not observe which release stream asked for the bytes.
      const headers = new Headers(hops === 1 ? init.headers : { Accept: 'application/octet-stream' })
      // Approximates the fetch `cache: 'no-store'` intent over the Chromium net stack.
      headers.set('cache-control', 'no-cache')

      const request = net.request({ url: secure.href, method: 'GET', redirect: 'manual',
        session: session.fromPartition(UPDATE_PARTITION) })
      current = request
      headers.forEach((value, key) => request.setHeader(key, value))
      let closing = false

      request.on('redirect', (_status, _method, redirectUrl) => {
        // Do not call followRedirect(): the next hop is issued here so every
        // hop is validated and only the first carries the release selectors.
        closing = true
        try { request.abort() } catch { /* the redirect decision already released the request */ }
        let next: string
        try { next = new URL(redirectUrl, secure.href).href } catch { fail(new Error('Update redirect has no usable location')); return }
        open(next)
      })
      request.on('response', incoming => {
        if (settled) return
        const status = incoming.statusCode
        if (status === undefined) { fail(new Error('The update download response carried no HTTP status.')); return }
        const responseHeaders = new Headers()
        for (const [key, value] of Object.entries(incoming.headers)) {
          for (const item of Array.isArray(value) ? value : [value]) responseHeaders.append(key, item)
        }
        try {
          finish({
            // Electron's IncomingMessage is a Node Readable at runtime; its
            // declared type only guarantees NodeJS.ReadableStream.
            response: new Response(
              NULL_BODY_STATUSES.has(status)
                ? null
                : Readable.toWeb(incoming as unknown as Readable) as unknown as ReadableStream<Uint8Array>,
              { status, headers: responseHeaders },
            ),
            finalUrl: secure.href,
          })
        } catch (error) { fail(error) }
      })
      request.on('abort', () => {
        if (!closing && !settled) fail(new Error('The update download request was aborted.'))
      })
      request.on('error', error => fail(error))
      // ClientRequest is a Writable: without end() the request is never sent.
      request.end()
    }

    open(url)
  })
}
