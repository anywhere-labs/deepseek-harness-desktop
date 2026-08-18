import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compile } from 'json-schema-to-typescript'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const checkOnly = process.argv.includes('--check')
const targets = [
  ['catalog-source', 'CatalogSourceManifest'],
  ['catalog-query', 'CatalogQuery'],
  ['catalog-provider-page', 'CatalogProviderPage'],
  ['catalog-snapshot', 'CatalogSnapshot'],
]
const outputDir = resolve(packageRoot, 'src/contracts/generated')
const options = {
  bannerComment: '/* Generated from docs/schemas by scripts/generate-contract-types.mjs. Do not edit. */',
  enableConstEnums: false,
  maxItems: 5,
  style: {
    semi: false,
    singleQuote: true,
    trailingComma: 'all',
  },
}

if (!checkOnly) mkdirSync(outputDir, { recursive: true })

for (const [schemaName, typeName] of targets) {
  const schemaPath = resolve(packageRoot, `docs/schemas/${schemaName}.schema.json`)
  const outputPath = resolve(outputDir, `${schemaName}.ts`)
  const schema = { ...JSON.parse(readFileSync(schemaPath, 'utf8')), title: typeName }
  const generated = await compile(schema, typeName, options)

  if (checkOnly) {
    if (!existsSync(outputPath) || readFileSync(outputPath, 'utf8') !== generated) {
      throw new Error(`${schemaName} generated types are stale; run yarn generate:types`)
    }
    continue
  }

  writeFileSync(outputPath, generated, 'utf8')
}

process.stdout.write(`contract-types: ${targets.length} generated type files ${checkOnly ? 'are current' : 'written'}\n`)
