/** Structured and redacted diagnostics for desktop startup recovery. */

const MAX_DIAGNOSTIC_CHARS = 32_768
const CREDENTIAL_ASSIGNMENT = /\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*)\s*([=:])\s*([^\s,;]+)/giu
const BEARER_TOKEN = /\bBearer\s+[^\s,;]+/giu
const DEEPSEEK_KEY = /\bsk-[A-Za-z0-9_-]{8,}\b/gu

/**
 * Redact credential-like values and bound a diagnostic copied from Host output.
 * @param value - Raw diagnostic text.
 * @returns A bounded diagnostic safe for the recovery UI and clipboard.
 */
export function redactDesktopDiagnostic(value: string): string {
  return value
    .replace(CREDENTIAL_ASSIGNMENT, (_match, name: string, separator: string) => `${name}${separator}[REDACTED]`)
    .replace(BEARER_TOKEN, 'Bearer [REDACTED]')
    .replace(DEEPSEEK_KEY, '[REDACTED]')
    .slice(-MAX_DIAGNOSTIC_CHARS)
}
