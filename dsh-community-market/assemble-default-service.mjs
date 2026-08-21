import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = dirname(fileURLToPath(import.meta.url))
const parts = [1, 2, 3].map((i) =>
  readFileSync(join(dir, 'src/catalog', `catalog-default-service.frag${i}.txt`), 'utf8'),
)
writeFileSync(join(dir, 'src/catalog/catalog-default-service.ts'), parts.join(''))
