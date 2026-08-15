/**
 * Compatibility matrix: which upstream runtimes this shell release was
 * validated against, and which one it recommends. Shipped as a resource;
 * the contract CI updates it when a new upstream version passes the gates.
 */
import { readFileSync } from 'node:fs'

export interface ValidatedRuntimes {
  validated: string[]
  recommended: string
}

export function parseValidatedRuntimes(raw: string): ValidatedRuntimes {
  const parsed = JSON.parse(raw) as Partial<ValidatedRuntimes>
  if (!Array.isArray(parsed.validated) || typeof parsed.recommended !== 'string') {
    throw new Error('validated-runtimes.json is malformed')
  }
  return { validated: parsed.validated, recommended: parsed.recommended }
}

export function loadValidatedRuntimes(path: string): ValidatedRuntimes {
  return parseValidatedRuntimes(readFileSync(path, 'utf8'))
}

/**
 * "latest tested", not "latest": only versions this shell release actually
 * validated. Consumers surface `recommended` as the upgrade suggestion.
 */
export function isVersionValidated(matrix: ValidatedRuntimes, version: string): boolean {
  return matrix.validated.includes(version)
}
