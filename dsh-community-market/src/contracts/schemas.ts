import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { Ajv2020, type AnySchema, type ValidateFunction } from 'ajv/dist/2020.js'
import type { FormatsPlugin } from 'ajv-formats'
import type { CatalogProviderPage } from './generated/catalog-provider-page.js'
import type { CatalogQuery } from './generated/catalog-query.js'
import type { CatalogSnapshot } from './generated/catalog-snapshot.js'
import type { CatalogSourceManifest } from './generated/catalog-source.js'

type ContractValidators = {
  readonly source: ValidateFunction<CatalogSourceManifest>
  readonly query: ValidateFunction<CatalogQuery>
  readonly providerPage: ValidateFunction<CatalogProviderPage>
  readonly snapshot: ValidateFunction<CatalogSnapshot>
}

function readSchema(name: string): AnySchema {
  const url = new URL(`../../docs/schemas/${name}.schema.json`, import.meta.url)
  return JSON.parse(readFileSync(url, 'utf8')) as AnySchema
}

const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  validateFormats: true,
})
const require = createRequire(import.meta.url)
const addFormats = require('ajv-formats') as FormatsPlugin
addFormats(ajv)

export const validators: ContractValidators = {
  source: ajv.compile<CatalogSourceManifest>(readSchema('catalog-source')),
  query: ajv.compile<CatalogQuery>(readSchema('catalog-query')),
  providerPage: ajv.compile<CatalogProviderPage>(readSchema('catalog-provider-page')),
  snapshot: ajv.compile<CatalogSnapshot>(readSchema('catalog-snapshot')),
}
