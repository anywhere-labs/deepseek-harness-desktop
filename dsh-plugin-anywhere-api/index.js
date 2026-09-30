/**
 * Host half of the Anywhere 模型网关 plugin.
 *
 * Owns everything the page must not hold: the OAuth authorization-code + PKCE flow with a
 * loopback callback, the token exchange, refresh, credential storage, the user-API reads, and
 * sign-out. The Client half talks to it over same-origin routes.
 *
 * Contract: 《Anywhere 模型网关：DSH 插件后端接入说明》(2026-09-30). Tokens never reach the
 * page; the Client half only sees the display snapshot this file builds.
 */

import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { request as httpRequest, createServer } from 'node:http'
import { Agent, request as httpsRequest } from 'node:https'
import { createAccessTokenResolver } from './oauth-session.js'

/**
 * Gateway origin. TEMPORARY: the local development server. Production is
 * `https://anywhere-api.com`; this and the Client half's `WEB_BASE` must move together.
 */
const BASE_URL = 'https://localhost:8443'

/** Registered OAuth client id. A desktop client is public and holds no secret. */
const CLIENT_ID = 'dsh-plugin-anywhere-api'

/** Scopes this plugin requests; `account` is the first-party account grant. */
const SCOPES = ['profile', 'email', 'offline_access', 'account']

/** Credential record key holding this plugin's grant; opaque to every other plugin. */
const CREDENTIAL_KEY = 'anywhere-gateway/session'

/** Same-origin route prefix the Client half calls. */
export const API_BASE = '/anywhere-gateway-api'

/** An authorization code lives about two minutes; wait a little longer than that. */
const LOGIN_TIMEOUT_MS = 150_000

/** Refresh the access token this many seconds before it expires. */
const REFRESH_SKEW_S = 60

/** Recorded user agent, so the account's session list identifies this device. */
const USER_AGENT = 'DSH Anywhere plugin'

/** Loopback host the OAuth callback must use; `localhost` is not an accepted redirect host. */
const LOOPBACK_HOST = '127.0.0.1'

/**
 * The local development server serves a self-signed certificate. Relax verification for a
 * loopback origin only — never through NODE_TLS_REJECT_UNAUTHORIZED, which would weaken every
 * other request in the process.
 */
const RELAX_TLS = /^https:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(BASE_URL)

/** Keep-alive agent for gateway calls. */
const AGENT = new Agent({ keepAlive: true, rejectUnauthorized: !RELAX_TLS })

/**
 * One HTTP request to the gateway.
 * @param path - path on the gateway.
 * @param options - method, headers, and an already-encoded body.
 * @returns the status code and the parsed JSON body, when there is one.
 */
function requestGateway(path, options = {}) {
  const { method = 'GET', headers = {}, body } = options
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL)
    const send = url.protocol === 'http:' ? httpRequest : httpsRequest
    const request = send(url, { method, headers, agent: AGENT }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let parsed
        try {
          parsed = text === '' ? undefined : JSON.parse(text)
        } catch {
          parsed = undefined
        }
        resolve({ status: response.statusCode ?? 0, body: parsed })
      })
    })
    request.on('error', reject)
    if (body !== undefined) request.write(body)
    request.end()
  })
}

/** @param buffer - bytes to encode. @returns unpadded base64url text. */
function base64url(buffer) {
  return buffer.toString('base64url')
}

/**
 * Create one PKCE pair and its state value.
 * @returns the verifier, its S256 challenge, and a fresh state.
 */
function createPkce() {
  const verifier = base64url(randomBytes(48))
  const challenge = base64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge, state: base64url(randomBytes(24)) }
}

/**
 * Open a URL in the user's system browser.
 * @param url - absolute URL to open.
 * @returns nothing; a failure to spawn is reported by the caller's timeout.
 */
function openBrowser(url) {
  const [command, args] = process.platform === 'darwin'
    ? ['open', [url]]
    : process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]]
  const child = spawn(command, args, { stdio: 'ignore', detached: true })
  child.unref()
}

/**
 * Listen on a free loopback port for exactly one OAuth callback.
 * @returns the server and the concrete redirect URI to register with the gateway.
 */
function listenLoopback() {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, LOOPBACK_HOST, () => {
      const address = server.address()
      resolve({ server, redirectUri: `http://${LOOPBACK_HOST}:${address.port}/callback` })
    })
  })
}

/**
 * Wait for the gateway to redirect back with a code, answering the browser meanwhile.
 * @param server - the loopback server from `listenLoopback`.
 * @param expected - the state and issuer this attempt expects.
 * @returns the authorization code.
 */
function waitForCallback(server, expected) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('授权超时：请在浏览器中完成登录后重试'))
    }, LOGIN_TIMEOUT_MS)
    const finish = (error, code) => {
      clearTimeout(timer)
      if (error === undefined) resolve(code)
      else reject(error)
    }
    server.on('request', (request, response) => {
      const url = new URL(request.url ?? '/', `http://${LOOPBACK_HOST}`)
      if (url.pathname !== '/callback') {
        response.writeHead(404).end()
        return
      }
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')
      const issuer = url.searchParams.get('iss')
      const failure = url.searchParams.get('error')
      const callbackValid = failure === null && code !== null && state === expected.state
        && (issuer === null || issuer.replace(/\/$/, '') === BASE_URL)
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      })
      response.end(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>Anywhere 模型网关</title>
<style>
  :root { color-scheme: dark; background: #0a0a0a; color: #fafafa;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100svh; display: grid; }
  main { display: grid; place-items: center; padding: 32px 24px; }
  section { width: 100%; max-width: 440px; text-align: center; }
  h1 { margin: 0; font-size: 24px; line-height: 1.5; font-weight: 500; letter-spacing: -.02em; }
  p { margin: 12px 0 0; color: #a3a3a3; font-size: 14px; line-height: 1.8; }
  .hint { margin-top: 36px; padding-top: 20px; border-top: 1px solid #ffffff1a; color: #737373; font-size: 12px; }
  @media (max-width: 480px) { h1 { font-size: 22px; } }
</style></head><body>
<main><section aria-labelledby="result-title">
  <h1 id="result-title">${callbackValid ? '已登录，请返回 DSH' : '授权未完成'}</h1>
  <p>${callbackValid ? '请回到 DSH 客户端继续，连接状态将在应用中更新。' : '请返回 DSH 客户端，重新发起登录。'}</p>
  <p class="hint">你可以安全关闭此页面</p>
</section></main></body></html>`)
      if (failure !== null) {
        finish(new Error(`授权未完成：${failure}`))
        return
      }
      if (code === null || state !== expected.state) {
        finish(new Error('授权回调校验失败：state 不匹配'))
        return
      }
      if (issuer !== null && issuer.replace(/\/$/, '') !== BASE_URL) {
        finish(new Error('授权回调校验失败：iss 与本网关不一致'))
        return
      }
      finish(undefined, code)
    })
  })
}

/**
 * Read this plugin's grant record.
 * @param ctx - Host context.
 * @returns the stored payload, or undefined when signed out.
 */
async function readGrant(ctx) {
  const record = await ctx.get('credentials')?.readRecord(CREDENTIAL_KEY)
  return record?.kind === 'grant' ? record.payload : undefined
}

/**
 * Replace this plugin's grant record.
 * @param ctx - Host context.
 * @param payload - JSON-safe grant the seam keeps verbatim.
 * @returns after the write.
 */
async function writeGrant(ctx, payload) {
  await ctx.get('credentials')?.modifyRecord(CREDENTIAL_KEY, async () => ({ kind: 'grant', payload }))
}

/**
 * Remove this plugin's grant record.
 * @param ctx - Host context.
 * @returns after the removal.
 */
async function clearGrant(ctx) {
  await ctx.get('credentials')?.deleteRecord(CREDENTIAL_KEY)
}

/**
 * POST a form-encoded body to the OAuth token or revoke endpoint.
 * @param path - endpoint path on the gateway.
 * @param form - form fields.
 * @returns the parsed JSON body, or undefined when the response has none.
 * @throws when the gateway rejects the request.
 */
async function postForm(path, form) {
  const { status, body } = await requestGateway(path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': USER_AGENT },
    body: new URLSearchParams(form).toString(),
  })
  if (status < 200 || status >= 300) {
    const reason = body?.error ?? body?.message ?? `HTTP ${status}`
    const error = new Error(reason === 'invalid_grant' ? '登录已失效，请重新登录' : `网关拒绝请求（${reason}）`)
    error.code = reason
    throw error
  }
  return body
}

/**
 * Exchange an authorization code for a grant.
 * @param code - the one-time code from the callback.
 * @param redirectUri - the exact redirect URI used to start the flow.
 * @param verifier - the PKCE verifier for this attempt.
 * @returns the grant payload to store.
 */
async function exchangeCode(code, redirectUri, verifier) {
  const body = await postForm('/api/oauth-server/token', {
    client_id: CLIENT_ID,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  })
  return grantFrom(body)
}

/**
 * Refresh an access token. The caller keeps one request in flight at a time.
 * @param refreshToken - the current refresh token.
 * @returns the replacement grant payload.
 */
async function refreshGrant(refreshToken) {
  const body = await postForm('/api/oauth-server/token', {
    client_id: CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  })
  return grantFrom(body, refreshToken)
}

/**
 * Normalize a token response into the stored grant payload.
 * @param body - parsed token response.
 * @param previousRefresh - refresh token to keep when the response omits one.
 * @returns the grant payload.
 */
function grantFrom(body, previousRefresh) {
  const expiresIn = Number(body?.expires_in ?? 900)
  return {
    accessToken: body?.access_token,
    refreshToken: body?.refresh_token ?? previousRefresh,
    expiresAt: Math.floor(Date.now() / 1000) + (Number.isFinite(expiresIn) ? expiresIn : 900),
    sessionId: body?.session?.sid,
    scope: body?.scope,
  }
}

/**
 * Revoke this plugin's grant. Rolled back to a local sign-out when the gateway is unreachable.
 * @param refreshToken - the refresh token to revoke; also valid once the access token expired.
 * @returns whether the gateway confirmed the revocation.
 */
async function revokeGrant(refreshToken) {
  try {
    await postForm('/api/oauth-server/revoke', { client_id: CLIENT_ID, token: refreshToken })
    return true
  } catch {
    return false
  }
}

/**
 * Current access token, refreshing first when it is close to expiry.
 * @param ctx - Host context.
 * @returns the token, or undefined when signed out.
 */
const resolveAccessToken = createAccessTokenResolver({
  key: CREDENTIAL_KEY, refresh: refreshGrant, skewSeconds: REFRESH_SKEW_S,
})

async function currentAccessToken(ctx, rejectedToken) {
  return resolveAccessToken(ctx.get('credentials'), rejectedToken)
}

/**
 * Call a user API on behalf of the account.
 * @param ctx - Host context.
 * @param path - path on the gateway.
 * @returns the parsed body's `data` field.
 * @throws when authentication cannot be repaired, or the gateway reports a failure.
 */
async function callUserApi(ctx, path) {
  let token = await currentAccessToken(ctx)
  if (token === undefined) throw new Error('未登录')
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { status, body } = await requestGateway(path, {
      headers: { authorization: `Bearer ${token}`, 'user-agent': USER_AGENT },
    })
    const code = body?.message ?? body?.data?.code
    if (code === 'AUTH_SESSION_REVOKED') {
      await clearGrant(ctx)
      throw new Error('登录已在网站被撤销，请重新登录')
    }
    if (status === 401 || code === 'AUTH_TOKEN_EXPIRED') {
      if (attempt === 1) break
      token = await currentAccessToken(ctx, token)
      if (token === undefined) break
      continue
    }
    if (status < 200 || status >= 300) throw new Error(code ?? `网关返回 HTTP ${status}`)
    // Business refusals can arrive as HTTP 200 with success:false.
    if (body?.success === false) throw new Error(body?.message ?? '网关拒绝了该请求')
    return body?.data
  }
  throw new Error('登录已过期，请重新登录')
}

/**
 * Build the display snapshot the Client half renders. Token values never leave the Host.
 * @param ctx - Host context.
 * @returns signed-out, loading, or the account figures.
 */
async function snapshot(ctx) {
  const grant = await readGrant(ctx)
  if (grant === undefined) return { signedIn: false }
  try {
    const [self, status] = await Promise.all([
      callUserApi(ctx, '/api/user/self'),
      callUserApi(ctx, '/api/status').catch(() => undefined),
    ])
    const perUnit = Number(status?.quota_per_unit ?? 500000)
    const money = value => `$${(Number(value ?? 0) / (perUnit || 500000)).toFixed(2)}`
    const now = Math.floor(Date.now() / 1000)
    const dayAgo = await callUserApi(
      ctx,
      `/api/log/self/stat?type=2&start_timestamp=${now - 86400}&end_timestamp=${now}`,
    ).catch(() => undefined)
    return {
      signedIn: true,
      profile: {
        id: self?.id,
        name: self?.display_name ?? self?.username ?? '',
        // The site stores either a URL, a data URL, or a site-relative path (AA login writes
        // whatever the identity provider returned).
        avatar: absoluteUrl(self?.avatar),
      },
      balance: money(self?.quota),
      totalSpend: money(self?.used_quota),
      totalRequests: String(self?.request_count ?? 0),
      last24h: money(dayAgo?.quota),
    }
  } catch (error) {
    return { signedIn: error?.code !== 'invalid_grant' && (await readGrant(ctx)) !== undefined,
      error: error instanceof Error ? error.message : String(error) }
  }
}

/** One in-flight login attempt, so a second click cannot start a parallel flow. */
let pending = undefined

/**
 * Run one full authorization-code + PKCE login.
 * @param ctx - Host context.
 * @returns after the grant is stored, or after a failure is recorded.
 */
async function login(ctx) {
  const pkce = createPkce()
  const { server, redirectUri } = await listenLoopback()
  try {
    const authorize = new URL('/api/oauth-server/authorize', BASE_URL)
    authorize.searchParams.set('client_id', CLIENT_ID)
    authorize.searchParams.set('redirect_uri', redirectUri)
    authorize.searchParams.set('response_type', 'code')
    authorize.searchParams.set('scope', SCOPES.join(' '))
    authorize.searchParams.set('state', pkce.state)
    authorize.searchParams.set('code_challenge_method', 'S256')
    authorize.searchParams.set('code_challenge', pkce.challenge)
    openBrowser(authorize.href)
    const code = await waitForCallback(server, { state: pkce.state })
    // A code is single-use: never retry a code whose exchange may already have been sent.
    await writeGrant(ctx, await exchangeCode(code, redirectUri, pkce.verifier))
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    server.close()
  }
}

/**
 * Sign this plugin session out: revoke on the gateway, then drop local credentials.
 * @param ctx - Host context.
 * @returns whether the gateway confirmed the revocation.
 */
async function logout(ctx) {
  const grant = await readGrant(ctx)
  const confirmed = typeof grant?.refreshToken === 'string' ? await revokeGrant(grant.refreshToken) : true
  await clearGrant(ctx)
  return { confirmed }
}

/**
 * Absolute URL for a value the gateway stores for a resource.
 * @param raw - the stored value: empty, a data URL, an absolute URL, or a site-relative path.
 * @returns the URL the page can render, or undefined when there is nothing to show.
 */
function absoluteUrl(raw) {
  if (typeof raw !== 'string' || raw === '') return undefined
  if (raw.startsWith('data:') || /^https?:\/\//.test(raw)) return raw
  return new URL(raw, BASE_URL).href
}

/** @param response - server response. @param status - HTTP status. @param body - JSON body. */
function sendJson(response, status, body) {
  const text = JSON.stringify(body)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(text)
}

/**
 * Mount the account routes once a Web server exists.
 *
 * The service is read through a nested injection rather than a one-shot `ctx.get`: plugin
 * activation order is not fixed, so a read taken while this plugin applies can miss a Web
 * server that mounts later, and a missed read would never be retried. The plugin also stays
 * active in a composition that has no Web server at all.
 * @param ctx - Host context.
 * @returns nothing; routes live until the plugin or the service generation unloads.
 */
export function apply(ctx) {
  ctx.inject(['webServer'], webCtx => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: API_BASE,
      async handler(request, response) {
        const { pathname } = new URL(request.url ?? '/', `http://${LOOPBACK_HOST}`)
        const route = pathname.slice(API_BASE.length)
        try {
          if (route === '/state' && request.method === 'GET') {
            sendJson(response, 200, { pending: pending !== undefined, ...(await snapshot(ctx)) })
            return
          }
          if (route === '/login' && request.method === 'POST') {
            if (pending === undefined) {
              pending = login(ctx).finally(() => { pending = undefined })
            }
            sendJson(response, 202, { pending: true })
            return
          }
          if (route === '/logout' && request.method === 'POST') {
            const outcome = await logout(ctx)
            sendJson(response, 200, { signedIn: false, ...outcome })
            return
          }
          sendJson(response, 404, { error: 'not found' })
        } catch (error) {
          sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }), 'anywhere-gateway: account routes')
    ctx.logger?.info(`anywhere-gateway: account routes mounted at ${API_BASE}`)
  })
}
