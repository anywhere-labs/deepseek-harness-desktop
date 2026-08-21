import { resolve } from 'node:path'
import { verifyTrackedMarketDependencyDirection } from './market-dependency-direction.mjs'

const root = resolve(import.meta.dirname, '..')
const result = verifyTrackedMarketDependencyDirection(root)

process.stdout.write(
  `verify-market-dependency-direction: ${String(result.fileCount)} Market source files are independent of Desktop implementation\n`,
)
