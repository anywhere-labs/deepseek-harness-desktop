/**
 * Keyless DuckDuckGo web search provider for DSH Desktop.
 *
 * Upstream ships `web_search` with a DeepSeek-backed provider that requires an
 * API key. This plugin registers an additional `WebSearchProvider` into the
 * shared `ctx.web` seam that searches the public web through DuckDuckGo's HTML
 * results page, with no credential, so the model-facing `web_search` tool works
 * out of the box. It is a *search* backend only: it does not touch `web_fetch`,
 * and it makes no credential-bearing requests (the fetch is anonymous).
 *
 * The endpoint is configurable — a self-hosted SearXNG or another
 * DuckDuckGo-compatible HTML mirror can replace the default without code
 * changes. DuckDuckGo offers no official API; HTML scraping is rate-limited and
 * may intermittently return a challenge page, which surfaces as a provider
 * error rather than a silent empty result.
 *
 * @module dsh-plugin-desktop-beta/web-search
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'

/** Stable id this provider registers under. */
export const DUCKDUCKGO_PROVIDER_ID = 'duckduckgo'

/** Stable Cordis plugin name. */
export const name = 'desktop-web-search'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Default DuckDuckGo HTML search endpoint. */
export const DUCKDUCKGO_DEFAULT_ENDPOINT = 'https://html.duckduckgo.com/html/'

/** Browser-like User-Agent; DuckDuckGo may answer a challenge to script-like agents. */
export const DUCKDUCKGO_DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

/** Keyless-search provider configuration. */
export interface Config {
  /** Search endpoint; a GET with `?q=` is appended. */
  endpoint: string
  /** HTTP timeout per search, in milliseconds. */
  timeoutMs: number
  /** Upper bound on sources returned by this provider. */
  maxResults: number
  /** User-Agent header sent on every request. */
  userAgent: string
}

/** Validated keyless-search provider configuration. */
export const Config: z<Config> = z.object({
  endpoint: z.string().default(DUCKDUCKGO_DEFAULT_ENDPOINT),
  timeoutMs: z.number().step(1).min(1000).max(120_000).default(30_000),
  maxResults: z.number().step(1).min(1).max(50).default(8),
  userAgent: z.string().default(DUCKDUCKGO_DEFAULT_USER_AGENT),
})

/**
 * One parsed DuckDuckGo result: the decoded target URL, the title, and the
 * snippet, with markup stripped and HTML entities decoded.
 */
interface ParsedResult {
  url: string
  title: string
  snippet: string
}

/** Resolve a DuckDuckGo `/l/?uddg=...` redirect URL to its real target. */
function decodeRedirect(href: string): string {
  const encoded = /[?&]uddg=([^&]+)/.exec(href)?.[1]
  if (encoded === undefined) return href
  try {
    return decodeURIComponent(encoded)
  } catch {
    return encoded
  }
}

/** Strip inline HTML tags from an excerpt. */
function stripTags(text: string): string {
  return text.replace(/<[^>]*>/g, '')
}

/** Decode the HTML entities DuckDuckGo escapes into result text. */
function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;|&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

/**
 * Extract title/URL/snippet triples from DuckDuckGo's HTML results page. Titles
 * and snippets are pulled by stable `result__a` / `result__snippet` classes and
 * paired by document order; non-HTTP redirect targets are dropped.
 * @param html - the full results page body.
 * @returns the parsed results, in result order.
 */
function parseResults(html: string): ParsedResult[] {
  const links = [...html.matchAll(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)]
  const snippets = [...html.matchAll(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)]
  const results: ParsedResult[] = []
  for (let i = 0; i < links.length; i++) {
    const link = links[i]
    const href = link?.[1]
    const titleRaw = link?.[2]
    if (href === undefined || titleRaw === undefined) continue
    const url = decodeRedirect(href)
    if (!/^https?:\/\//.test(url)) continue
    const title = decodeEntities(stripTags(titleRaw)).trim()
    if (title.length === 0) continue
    const snippetRaw = snippets[i]?.[1]
    const snippet = snippetRaw === undefined ? '' : decodeEntities(stripTags(snippetRaw)).trim()
    results.push({ url, title, snippet })
  }
  return results
}

/** A browser-like fetch timeout signal that also follows the caller's abort. */
function searchSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}

/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

/** Build the provider's stable cancellation error while retaining the caller's reason. */
function abortedError(signal?: AbortSignal): WebError {
  return new WebError('DuckDuckGo search aborted', 'WEB_ABORTED', {
    cause: signal?.aborted === true ? signal.reason : undefined,
  })
}

/**
 * The DuckDuckGo-backed search provider. Always available (no credential is
 * required) as long as the endpoint parses; a failed or challenged request
 * surfaces as a `WEB_PROVIDER_ERROR` with an actionable message.
 */
export class DuckDuckGoSearchProvider implements WebSearchProvider {
  readonly id = DUCKDUCKGO_PROVIDER_ID

  /**
   * @param config - the resolved provider values, snapshotted at registration.
   */
  constructor(private readonly config: Config) {}

  available(): boolean {
    return URL.canParse(this.config.endpoint)
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const endpoint = this.config.endpoint
    const url = `${endpoint}?q=${encodeURIComponent(request.query)}`
    let response: Response
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: {
          'user-agent': this.config.userAgent,
          'accept': 'text/html',
        },
        signal: searchSignal(signal, this.config.timeoutMs),
      })
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw abortedError(signal)
      throw new WebError(
        `DuckDuckGo search request failed: ${String(error)}`,
        'WEB_PROVIDER_ERROR',
        { cause: error },
      )
    }

    if (!response.ok) {
      const status = response.status
      if (status === 429 || status === 403) {
        throw new WebError(
          `DuckDuckGo rejected the search (HTTP ${status}); the endpoint may be rate-limiting. `
          + 'Wait and retry, or configure web-search.endpoint to another DuckDuckGo-compatible mirror.',
          'WEB_PROVIDER_ERROR',
        )
      }
      throw new WebError(`DuckDuckGo search returned HTTP ${status}`, 'WEB_PROVIDER_ERROR')
    }

    const html = await response.text()
    const parsed = parseResults(html)
    if (parsed.length === 0) {
      throw new WebError(
        'DuckDuckGo returned no parseable results; the page may be a challenge or the result markup changed.',
        'WEB_PROVIDER_ERROR',
      )
    }

    const sources: WebSearchSource[] = parsed.slice(0, this.config.maxResults).map((result) => ({
      url: result.url,
      title: result.title,
      ...(result.snippet.length > 0 ? { snippet: result.snippet } : {}),
    }))
    return { sources, truncated: false }
  }
}

/**
 * Register the keyless DuckDuckGo provider with the shared `ctx.web` seam.
 * @param ctx - host context carrying the `web` service.
 * @param config - validated endpoint, timeout, and result-bound values.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.web.registerSearchProvider(new DuckDuckGoSearchProvider(config))
}
