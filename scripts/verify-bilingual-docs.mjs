import { resolve } from 'node:path'
import { verifyTrackedBilingualRecords } from './bilingual-docs.mjs'

const root = resolve(import.meta.dirname, '..')
const result = verifyTrackedBilingualRecords(root)

process.stdout.write(
  `verify-bilingual-docs: ${String(result.recordCount)} records and ${String(result.documentCount)} documents are consistent\n`,
)
