import type { ErrorObject } from 'ajv'

export type CatalogContractName = 'source' | 'query' | 'provider-page' | 'snapshot' | 'local-source' | 'identity'

export interface CatalogContractIssue {
  readonly path: string
  readonly message: string
  readonly keyword: string
}

export class CatalogContractError extends Error {
  readonly contract: CatalogContractName
  readonly issues: readonly CatalogContractIssue[]

  constructor(contract: CatalogContractName, issues: readonly CatalogContractIssue[]) {
    super(`${contract} contract rejected: ${issues.map(issue => `${issue.path} ${issue.message}`).join('; ')}`)
    this.name = 'CatalogContractError'
    this.contract = contract
    this.issues = issues
  }
}

export function schemaIssues(errors: readonly ErrorObject[] | null | undefined): readonly CatalogContractIssue[] {
  if (!errors?.length) {
    return [{ path: '/', message: 'is invalid', keyword: 'validation' }]
  }

  return errors.map(error => ({
    path: error.instancePath || '/',
    message: error.message ?? 'is invalid',
    keyword: error.keyword,
  }))
}

export function semanticIssue(path: string, message: string): CatalogContractIssue {
  return { path, message, keyword: 'semantic' }
}
