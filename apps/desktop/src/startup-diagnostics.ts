/** Structured and redacted diagnostics for desktop startup recovery. */

const MAX_DIAGNOSTIC_CHARS = 32_768
const CREDENTIAL_NAME = String.raw`[A-Z0-9_.-]*(?:AUTH|CREDENTIAL|KEY|PASS(?:WORD|WD)?|SECRET|TOKEN)[A-Z0-9_.-]*`
const CREDENTIAL_VALUE = String.raw`(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\r\n,;]+)`
const CREDENTIAL_ASSIGNMENT = new RegExp(String.raw`(["']?)(${CREDENTIAL_NAME})\1\s*([=:])\s*${CREDENTIAL_VALUE}`, 'giu')
const AUTHORIZATION_HEADER = /\b((?:Proxy-)?Authorization)\s*:\s*[^\r\n]+/giu
const COOKIE_HEADER = /\b((?:Set-)?Cookie)\s*:\s*[^\r\n]+/giu
const BEARER_TOKEN = /\bBearer\s+[^\s,;]+/giu
const DEEPSEEK_KEY = /\bsk-[A-Za-z0-9_-]{8,}\b/gu
const URL_USERINFO = /\b(https?:\/\/)[^\s/@:]+:[^\s/@]+@/giu

/**
 * Redact credential-like values and bound a diagnostic copied from Host output.
 * @param value - Raw diagnostic text.
 * @returns A bounded diagnostic safe for the recovery UI and clipboard.
 */
export function redactDesktopDiagnostic(value: string): string {
  return value
    .replace(CREDENTIAL_ASSIGNMENT, (_match, quote: string, name: string, separator: string) => `${quote}${name}${quote}${separator}[REDACTED]`)
    .replace(AUTHORIZATION_HEADER, (_match, name: string) => `${name}: [REDACTED]`)
    .replace(COOKIE_HEADER, (_match, name: string) => `${name}: [REDACTED]`)
    .replace(BEARER_TOKEN, 'Bearer [REDACTED]')
    .replace(DEEPSEEK_KEY, '[REDACTED]')
    .replace(URL_USERINFO, '$1[REDACTED]@')
    .slice(-MAX_DIAGNOSTIC_CHARS)
}
