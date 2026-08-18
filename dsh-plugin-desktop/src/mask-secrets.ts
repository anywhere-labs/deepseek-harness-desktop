/** Mask secret-shaped substrings in a rendered log line. */

const MASK = '****'
const COOKIE_HEADER = /\b(Set-Cookie|Cookie)\s*:[^\r\n]*/giu
const AUTHORIZATION_HEADER = /\bAuthorization\s*:\s*([^\r\n]*)/giu
const WEB_URL = /https?:\/\/[^\s<>"']+/giu
const SENSITIVE_QUERY_KEY = /(?:auth|code|credential|key|password|secret|signature|token)/iu
const SECRET_FIELD_NAME = String.raw`access[_-]?token|(?:x[_-])?api[_-]?key|authorization|auth|client[_-]?secret|code|credential|id[_-]?token|password|passwd|private[_-]?key|refresh[_-]?token|secret|session(?:id)?|signature|token`
const QUOTED_NAMED_SECRET = new RegExp(
  String.raw`(["'])(${SECRET_FIELD_NAME})\1(\s*:\s*)(["'])(?:\\.|(?!\4)[^\\])*\4`,
  'giu',
)
const NAMED_SECRET = new RegExp(
  String.raw`\b(${SECRET_FIELD_NAME})\b(\s*[:=]\s*)(?!(?:Bearer|Basic)\b)[^\s,;&]+`,
  'giu',
)

/** Secret-shaped patterns applied in order to a rendered log line. */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9]{12,}/gu, // OpenAI/DeepSeek-style sk- keys
  /\b[a-zA-Z0-9]{32,}\b/gu, // long hex/base64 tokens
  /Bearer\s+[A-Za-z0-9._-]+/giu, // Authorization bearer tokens
  /Basic\s+[A-Za-z0-9+/]+={0,2}/giu, // Authorization basic credentials
]

function maskUrl(raw: string): string {
  const trailing = /[),.;]+$/u.exec(raw)?.[0] ?? ''
  const value = trailing === '' ? raw : raw.slice(0, -trailing.length)
  try {
    const url = new URL(value)
    if (url.username !== '') url.username = MASK
    if (url.password !== '') url.password = MASK
    for (const name of url.searchParams.keys()) {
      if (SENSITIVE_QUERY_KEY.test(name)) url.searchParams.set(name, MASK)
    }
    return `${url.href}${trailing}`
  } catch {
    return raw
  }
}

/** Replace secret-shaped substrings, preserving a short leading prefix. */
export function maskSecrets(text: string): string {
  let out = text
    .replace(COOKIE_HEADER, (_match, name: string) => `${name}: ${MASK}`)
    .replace(WEB_URL, maskUrl)
    .replace(QUOTED_NAMED_SECRET, (_match, keyQuote: string, name: string, separator: string, valueQuote: string) =>
      `${keyQuote}${name}${keyQuote}${separator}${valueQuote}${MASK}${valueQuote}`)
    .replace(AUTHORIZATION_HEADER, (_match, value: string) => {
      const scheme = /^(Bearer|Basic)\b/iu.exec(value)?.[1]
      return `Authorization: ${scheme === undefined ? '' : `${scheme} `}${MASK}`
    })
    .replace(NAMED_SECRET, (_match, name: string, separator: string) => `${name}${separator}${MASK}`)
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match) => {
      const authorizationScheme = /^(Bearer|Basic)/iu.exec(match)?.[1]
      if (authorizationScheme !== undefined) return `${authorizationScheme} ****`
      return `${match.slice(0, 3)}${MASK}`
    })
  }
  return out
}
