import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = dirname(fileURLToPath(import.meta.url))
const catalog = join(dir, 'src/catalog')
const frag1 = readFileSync(join(catalog, 'catalog-default-service.frag1.txt'), 'utf8')
const decodeParts = (prefix) => Buffer.from(
  ['a', 'b'].map((s) => readFileSync(join(catalog, `catalog-default-service.${prefix}${s}.b64.txt`), 'utf8').replace(/\s+/g, '')).join(''),
  'base64',
).toString('utf8')
writeFileSync(join(catalog, 'catalog-default-service.ts'), frag1 + decodeParts('frag2') + decodeParts('frag3'))
