import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const fail = message => { throw new Error(`verify-market-docs: ${message}`) }
const read = path => readFileSync(resolve(packageRoot, path), 'utf8')
const readJson = path => {
  try {
    return JSON.parse(read(path))
  } catch (error) {
    fail(`${path} is not valid JSON: ${error.message}`)
  }
}
const manifest = JSON.parse(read('package.json'))

if (manifest.name !== 'dsh-community-market') fail('package name must remain dsh-community-market')
if (manifest.private !== true) {
  fail('the built-in Market workspace package must stay private to prevent unsupported standalone publication')
}
if (manifest.main !== 'lib/index.js' || manifest.types !== 'lib/index.d.ts') {
  fail('runtime package must expose the reviewed Host entry and declarations')
}
if (manifest.exports?.['./client']?.default !== './lib/client.js') {
  fail('runtime package must expose the reviewed Client entry')
}
if (manifest.dsh?.client?.platform !== 'web' || !Array.isArray(manifest.dsh?.client?.inject)) {
  fail('runtime package must declare its Web Client dependency graph')
}
for (const field of ['module', 'bin', 'optionalDependencies']) {
  if (manifest[field] !== undefined) fail(`runtime package must not declare ${field}`)
}

const publicFiles = [
  'LICENSE',
  'README.i18n.yaml',
  'README.md',
  'README.zh.md',
  'SECURITY.i18n.yaml',
  'SECURITY.md',
  'SECURITY.zh.md',
  'docs/catalog-adapter-guide.i18n.yaml',
  'docs/catalog-adapter-guide.md',
  'docs/catalog-adapter-guide.zh.md',
  'docs/catalog-provider-contract.i18n.yaml',
  'docs/catalog-provider-contract.md',
  'docs/catalog-provider-contract.zh.md',
  'docs/install-and-uninstall.i18n.yaml',
  'docs/install-and-uninstall.md',
  'docs/install-and-uninstall.zh.md',
  'docs/examples/catalog-query.example.json',
  'docs/examples/catalog-provider-page.example.json',
  'docs/examples/catalog-provider-page.minimal.example.json',
  'docs/examples/catalog-snapshot.example.json',
  'docs/examples/catalog-source.example.json',
  'docs/market-shell.i18n.yaml',
  'docs/market-shell.md',
  'docs/market-shell.zh.md',
  'docs/schemas/catalog-query.schema.json',
  'docs/schemas/catalog-provider-page.schema.json',
  'docs/schemas/catalog-snapshot.schema.json',
  'docs/schemas/catalog-source.schema.json',
]
for (const path of [...publicFiles, 'scripts/verify-docs.mjs']) {
  if (!existsSync(resolve(packageRoot, path))) fail(`${path} is missing`)
}

const expectedFiles = [
  'docs/**',
  'lib/**',
  'LICENSE',
  'README.md',
  'README.zh.md',
  'README.i18n.yaml',
  'SECURITY.md',
  'SECURITY.zh.md',
  'SECURITY.i18n.yaml',
]
if (JSON.stringify(manifest.files) !== JSON.stringify(expectedFiles)) {
  fail('package files must contain only the reviewed contract runtime and documentation surface')
}

const pairs = [
  ['README.i18n.yaml', ['README.md', 'README.zh.md']],
  ['SECURITY.i18n.yaml', ['SECURITY.md', 'SECURITY.zh.md']],
  ['docs/catalog-adapter-guide.i18n.yaml', ['docs/catalog-adapter-guide.md', 'docs/catalog-adapter-guide.zh.md']],
  ['docs/catalog-provider-contract.i18n.yaml', ['docs/catalog-provider-contract.md', 'docs/catalog-provider-contract.zh.md']],
  ['docs/install-and-uninstall.i18n.yaml', ['docs/install-and-uninstall.md', 'docs/install-and-uninstall.zh.md']],
  ['docs/market-shell.i18n.yaml', ['docs/market-shell.md', 'docs/market-shell.zh.md']],
]
for (const [recordPath, paths] of pairs) {
  const lines = read(recordPath).split(/\r?\n/u)
  for (const path of paths) {
    const hash = execFileSync('git', ['hash-object', `--path=${path}`, path], {
      cwd: packageRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
    const name = path.split('/').at(-1)
    if (!lines.includes(`${name}: ${hash}`)) fail(`${recordPath} is stale for ${path}`)
  }
}

const schemaPaths = [
  'docs/schemas/catalog-source.schema.json',
  'docs/schemas/catalog-query.schema.json',
  'docs/schemas/catalog-provider-page.schema.json',
  'docs/schemas/catalog-snapshot.schema.json',
]
const schemas = Object.fromEntries(schemaPaths.map(path => [path, readJson(path)]))
const assertClosedObjects = (value, path) => {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertClosedObjects(entry, `${path}[${index}]`))
    return
  }
  if (value === null || typeof value !== 'object') return
  if (value.type === 'object' && value.additionalProperties !== false) {
    fail(`${path} declares an object without additionalProperties: false`)
  }
  for (const [key, entry] of Object.entries(value)) assertClosedObjects(entry, `${path}.${key}`)
}
for (const [path, schema] of Object.entries(schemas)) {
  if (schema.$schema !== 'https://json-schema.org/draft/2020-12/schema') {
    fail(`${path} must use JSON Schema Draft 2020-12`)
  }
  if (typeof schema.$id !== 'string' || schema.$id.length === 0) fail(`${path} must declare $id`)
  if (schema.type !== 'object' || schema.additionalProperties !== false) {
    fail(`${path} must define a closed top-level object`)
  }
  assertClosedObjects(schema, path)
}

const ajv = new Ajv2020({ allErrors: true, strict: true })
addFormats(ajv)
const validators = Object.fromEntries(
  Object.entries(schemas).map(([path, schema]) => [path, ajv.compile(schema)]),
)
const validateFixture = (schemaPath, fixturePath) => {
  const value = readJson(fixturePath)
  const validate = validators[schemaPath]
  if (!validate(value)) {
    fail(`${fixturePath} does not satisfy ${schemaPath}: ${ajv.errorsText(validate.errors)}`)
  }
  return value
}
const expectInvalid = (schemaPath, value, label) => {
  if (validators[schemaPath](value)) fail(`${label} must be rejected by ${schemaPath}`)
}

const sourceSchema = schemas['docs/schemas/catalog-source.schema.json']
const querySchema = schemas['docs/schemas/catalog-query.schema.json']
const providerPageSchema = schemas['docs/schemas/catalog-provider-page.schema.json']
const snapshotSchema = schemas['docs/schemas/catalog-snapshot.schema.json']
const forbiddenSourceFields = ['default', 'enabled', 'selected', 'order', 'priority', 'auth', 'headers', 'secret', 'script', 'install', 'installCommand']
for (const field of forbiddenSourceFields) {
  if (Object.hasOwn(sourceSchema.properties, field)) fail(`catalog source schema must not declare ${field}`)
}
if (!sourceSchema.required.includes('providerId') || Object.hasOwn(sourceSchema.properties, 'id')) {
  fail('catalog source schema must distinguish providerId from Host sourceRecordId')
}
const expectedQueryFields = ['q', 'category', 'capability', 'cursor', 'limit', 'sort', 'locale']
if (JSON.stringify(Object.keys(querySchema.properties)) !== JSON.stringify(expectedQueryFields)) {
  fail('catalog query schema must expose only q/category/capability/cursor/limit/sort/locale')
}
const itemSchema = snapshotSchema.$defs?.item
if (itemSchema?.additionalProperties !== false || !itemSchema.required?.includes('provenance')) {
  fail('catalog snapshot items must be closed objects with required provenance')
}
const providerMediaSchema = providerPageSchema.$defs?.media
const providerIconSchema = providerPageSchema.$defs?.remoteIconCandidate
if (
  providerMediaSchema?.additionalProperties !== false
  || JSON.stringify(providerMediaSchema.required) !== JSON.stringify(['icon'])
  || providerIconSchema?.additionalProperties !== false
  || JSON.stringify(providerIconSchema.required) !== JSON.stringify(['url'])
) {
  fail('provider media must be an optional closed icon container with a required remote HTTPS candidate URL')
}
const normalizedMediaSchema = snapshotSchema.$defs?.media
const normalizedIconSchema = snapshotSchema.$defs?.resolvedIcon
const normalizedAssetRefSchema = snapshotSchema.$defs?.assetRef
if (
  normalizedMediaSchema?.additionalProperties !== false
  || JSON.stringify(normalizedMediaSchema.required) !== JSON.stringify(['icon'])
  || normalizedIconSchema?.additionalProperties !== false
  || JSON.stringify(normalizedIconSchema.required) !== JSON.stringify(['assetRef', 'role'])
  || JSON.stringify(normalizedIconSchema.properties?.role?.enum) !== JSON.stringify(['plugin-icon', 'publisher-avatar'])
  || Object.hasOwn(normalizedIconSchema.properties ?? {}, 'url')
) {
  fail('normalized media must expose only a Host asset reference with an explicit plugin-icon or publisher-avatar role')
}
if (sourceSchema.properties?.transport?.properties?.endpoint?.maxLength !== 2048) {
  fail('standard source endpoints must keep the 2048-character transport limit')
}
if (
  normalizedAssetRefSchema?.pattern !== '^mktimg_[A-Za-z0-9_-]{32}$'
  || normalizedAssetRefSchema?.minLength !== 39
  || normalizedAssetRefSchema?.maxLength !== 39
) {
  fail('normalized media references must match the exact Host route token format')
}
if (
  providerPageSchema.$defs?.httpsUri?.pattern !== snapshotSchema.$defs?.httpsUri?.pattern
  || !providerIconSchema.properties?.url?.$ref?.endsWith('/httpsUri')
) {
  fail('provider icon candidates must use the shared strict HTTPS URI constraint')
}
if (Object.hasOwn(itemSchema.properties, 'install') || Object.hasOwn(itemSchema.properties, 'installCommand')) {
  fail('catalog snapshot items must not contain executable installation fields')
}
if (Object.hasOwn(providerPageSchema.$defs.item.properties, 'provenance')) {
  fail('provider wire items must not be allowed to supply Host provenance')
}
if (
  querySchema.$defs.categoryId.pattern !== providerPageSchema.$defs.categoryId.pattern
  || querySchema.$defs.categoryId.pattern !== snapshotSchema.$defs.categoryId.pattern
) {
  fail('category identifiers must use the same constraint in queries, provider pages, and normalized snapshots')
}
if (
  querySchema.$defs.capabilityId.pattern !== providerPageSchema.$defs.capabilityList.items.pattern
  || querySchema.$defs.capabilityId.pattern !== snapshotSchema.$defs.capabilityList.items.pattern
) {
  fail('capability identifiers must use the same constraint in queries, provider pages, and normalized snapshots')
}
for (const field of ['sourceRecordId', 'providerId', 'adapterId', 'registrationKind', 'fetchedAt', 'finalUrl']) {
  if (!snapshotSchema.$defs.source.required.includes(field)) fail(`normalized snapshots must require Host source field ${field}`)
}

const sourceExample = validateFixture('docs/schemas/catalog-source.schema.json', 'docs/examples/catalog-source.example.json')
for (const field of forbiddenSourceFields) {
  if (Object.hasOwn(sourceExample, field)) fail(`catalog source example must not contain ${field}`)
}
if (sourceExample.manifestVersion !== '1.0.0') fail('catalog source example has an unsupported manifestVersion')
if (sourceExample.transport?.kind !== 'https-json' || sourceExample.transport?.method !== 'GET') {
  fail('catalog source example must use the standard https-json GET transport')
}
let endpoint
try {
  endpoint = new URL(sourceExample.transport.endpoint)
} catch {
  fail('catalog source example endpoint must be an absolute URL')
}
if (
  endpoint.protocol !== 'https:'
  || endpoint.username
  || endpoint.password
  || endpoint.port
  || endpoint.search
  || endpoint.hash
  || !endpoint.pathname.endsWith('/v1/plugins')
) {
  fail('catalog source example endpoint must use standard HTTPS port 443, have no credentials, query, or fragment, and end in /v1/plugins')
}
const supportedQueryFields = sourceExample.query?.supported
if (!Array.isArray(supportedQueryFields) || supportedQueryFields.some(field => !expectedQueryFields.includes(field))) {
  fail('catalog source example declares an unknown query field')
}
if (sourceExample.query.defaultLimit > sourceExample.query.maxLimit || sourceExample.query.maxLimit > 100) {
  fail('catalog source example has inconsistent query limits')
}
if (sourceExample.query.supported.includes('sort') && sourceExample.query.sorts.length === 0) {
  fail('catalog source example advertises sort without a supported sort value')
}

const queryExample = validateFixture('docs/schemas/catalog-query.schema.json', 'docs/examples/catalog-query.example.json')
if (Object.keys(queryExample).some(field => !expectedQueryFields.includes(field))) {
  fail('catalog query example contains an unknown field')
}
const allowedSorts = querySchema.properties.sort.enum
if (!Number.isInteger(queryExample.limit) || queryExample.limit < 1 || queryExample.limit > 100) {
  fail('catalog query example limit must be an integer from 1 through 100')
}
if (queryExample.sort !== undefined && !allowedSorts.includes(queryExample.sort)) {
  fail('catalog query example uses an unsupported sort')
}

const minimalProviderPageExample = validateFixture(
  'docs/schemas/catalog-provider-page.schema.json',
  'docs/examples/catalog-provider-page.minimal.example.json',
)
if (minimalProviderPageExample.items.length > 50) {
  fail('minimal catalog provider page example must stay within its recommended 50-item fixture limit')
}

const providerPageExample = validateFixture(
  'docs/schemas/catalog-provider-page.schema.json',
  'docs/examples/catalog-provider-page.example.json',
)
if (providerPageExample.items.length > queryExample.limit) {
  fail('catalog provider page example must not exceed the effective query limit')
}
const hasDuplicateIdentity = (items, identityOf) => {
  const seen = new Set()
  for (const item of items) {
    const identity = identityOf(item)
    if (seen.has(identity)) return true
    seen.add(identity)
  }
  return false
}
if (hasDuplicateIdentity(providerPageExample.items, item => item.id)) {
  fail('catalog provider page example contains duplicate item IDs')
}
if (!providerPageExample.items[0]?.media?.icon?.url?.startsWith('https://')) {
  fail('catalog provider page example must demonstrate a direct HTTPS icon candidate')
}

const snapshotExample = validateFixture('docs/schemas/catalog-snapshot.schema.json', 'docs/examples/catalog-snapshot.example.json')
if (snapshotExample.schemaVersion !== '1.0.0') fail('catalog snapshot example has an unsupported schemaVersion')
if (!Array.isArray(snapshotExample.items)) fail('catalog snapshot example items must be an array')
const identities = new Set()
for (const item of snapshotExample.items) {
  if (!item.repository && !item.package) fail(`catalog snapshot item ${item.id ?? '<unknown>'} lacks repository or package identity`)
  if (
    item.provenance?.sourceRecordId !== snapshotExample.source?.sourceRecordId
    || item.provenance?.providerId !== snapshotExample.source?.providerId
    || item.provenance?.itemId !== item.id
  ) {
    fail(`catalog snapshot item ${item.id ?? '<unknown>'} has mismatched provenance`)
  }
  const identity = `${item.provenance.sourceRecordId}\0${item.provenance.itemId}`
  if (identities.has(identity)) fail(`catalog snapshot contains duplicate identity ${item.provenance.sourceRecordId}/${item.provenance.itemId}`)
  identities.add(identity)
  for (const field of ['install', 'installCommand', 'script', 'command']) {
    if (Object.hasOwn(item, field)) fail(`catalog snapshot item ${item.id} must not contain executable field ${field}`)
  }
  if (item.media?.icon) {
    if (typeof item.media.icon.assetRef !== 'string' || !/^mktimg_[A-Za-z0-9_-]{32}$/u.test(item.media.icon.assetRef)) {
      fail(`catalog snapshot item ${item.id} media must contain a Host asset reference`)
    }
    if (Object.hasOwn(item.media.icon, 'url')) {
      fail(`catalog snapshot item ${item.id} must not expose a remote media URL`)
    }
  }
}
if (snapshotExample.items[0]?.media?.icon?.role !== 'plugin-icon') {
  fail('catalog snapshot example must demonstrate a resolved direct provider plugin icon')
}
if (!hasDuplicateIdentity(
  [providerPageExample.items[0], { ...providerPageExample.items[0], displayName: 'Duplicate identity' }],
  item => item.id,
)) {
  fail('duplicate provider item identity guard is ineffective')
}

expectInvalid(
  'docs/schemas/catalog-source.schema.json',
  { ...sourceExample, enabled: true },
  'a source manifest with local enabled state',
)
expectInvalid(
  'docs/schemas/catalog-source.schema.json',
  { ...sourceExample, transport: { ...sourceExample.transport, endpoint: 'http://catalog.example/v1/plugins' } },
  'an insecure source endpoint',
)
expectInvalid(
  'docs/schemas/catalog-source.schema.json',
  { ...sourceExample, transport: { ...sourceExample.transport, endpoint: 'https://catalog.example:8443/v1/plugins' } },
  'a source endpoint on a nonstandard port',
)
expectInvalid(
  'docs/schemas/catalog-source.schema.json',
  { ...sourceExample, transport: { ...sourceExample.transport, endpoint: `https://catalog.example/${'a'.repeat(2_048)}/v1/plugins` } },
  'an oversized source endpoint',
)
expectInvalid(
  'docs/schemas/catalog-source.schema.json',
  { ...sourceExample, attribution: { ...sourceExample.attribution, url: 'https://user@example.org/' } },
  'a credential-bearing attribution URL',
)
expectInvalid(
  'docs/schemas/catalog-query.schema.json',
  { ...queryExample, limit: 0 },
  'a zero query limit',
)
expectInvalid(
  'docs/schemas/catalog-query.schema.json',
  { ...queryExample, unknown: true },
  'an unknown query property',
)
expectInvalid(
  'docs/schemas/catalog-query.schema.json',
  { ...queryExample, category: ['User Interface'] },
  'an unstable category identifier',
)
expectInvalid(
  'docs/schemas/catalog-query.schema.json',
  { ...queryExample, capability: ['UI:Panel'] },
  'an invalid capability identifier',
)
expectInvalid(
  'docs/schemas/catalog-provider-page.schema.json',
  {
    ...providerPageExample,
    items: providerPageExample.items.map(item => ({ ...item, install: 'pnpm add unsafe' })),
  },
  'a provider page with an executable install field',
)
expectInvalid(
  'docs/schemas/catalog-provider-page.schema.json',
  {
    ...providerPageExample,
    items: providerPageExample.items.map(item => ({ ...item, displayName: 'Safe\u202Eexe.txt' })),
  },
  'a provider page with bidirectional spoofing controls',
)
expectInvalid(
  'docs/schemas/catalog-provider-page.schema.json',
  {
    ...providerPageExample,
    items: providerPageExample.items.map(item => ({
      ...item,
      media: { icon: { ...item.media.icon, url: 'http://plugins.example.org/unsafe.png' } },
    })),
  },
  'a provider page with an insecure icon candidate',
)
expectInvalid(
  'docs/schemas/catalog-provider-page.schema.json',
  {
    ...providerPageExample,
    items: providerPageExample.items.map(item => ({
      ...item,
      media: { icon: { ...item.media.icon, url: 'https://user@plugins.example.org/unsafe.png' } },
    })),
  },
  'a provider page with a credential-bearing icon candidate',
)
expectInvalid(
  'docs/schemas/catalog-provider-page.schema.json',
  {
    ...providerPageExample,
    items: providerPageExample.items.map(item => ({
      ...item,
      media: { icon: { ...item.media.icon, url: 'https://plugins.example.org:8443/icon.png' } },
    })),
  },
  'a provider page with an icon candidate on a nonstandard port',
)
expectInvalid(
  'docs/schemas/catalog-snapshot.schema.json',
  {
    ...snapshotExample,
    items: snapshotExample.items.map(({ provenance, ...item }) => item),
  },
  'a normalized snapshot without Host provenance',
)
expectInvalid(
  'docs/schemas/catalog-snapshot.schema.json',
  {
    ...snapshotExample,
    items: snapshotExample.items.map(({ repository, package: packageIdentity, ...item }) => item),
  },
  'a normalized snapshot without a package or repository identity',
)
expectInvalid(
  'docs/schemas/catalog-snapshot.schema.json',
  {
    ...snapshotExample,
    items: snapshotExample.items.map(item => ({
      ...item,
      media: { icon: { url: 'https://plugins.example.org/unsafe.png', role: 'plugin-icon' } },
    })),
  },
  'a normalized snapshot that exposes a remote icon URL to the Renderer',
)
expectInvalid(
  'docs/schemas/catalog-snapshot.schema.json',
  {
    ...snapshotExample,
    items: snapshotExample.items.map(item => ({
      ...item,
      media: { icon: { ...item.media.icon, assetRef: 'https://plugins.example.org/unsafe.png' } },
    })),
  },
  'a normalized snapshot that disguises a remote URL as an asset reference',
)
expectInvalid(
  'docs/schemas/catalog-snapshot.schema.json',
  {
    ...snapshotExample,
    items: snapshotExample.items.map(item => ({
      ...item,
      media: { icon: { ...item.media.icon, assetRef: 'mktimg_too-short' } },
    })),
  },
  'a normalized snapshot with a malformed Host asset reference',
)
expectInvalid(
  'docs/schemas/catalog-snapshot.schema.json',
  {
    ...snapshotExample,
    items: snapshotExample.items.map(item => ({
      ...item,
      media: { icon: { ...item.media.icon, role: 'provider-logo' } },
    })),
  },
  'a normalized snapshot with an unknown media role',
)

const markdownFiles = publicFiles.filter(path => path.endsWith('.md'))
for (const path of markdownFiles) {
  const source = read(path)
  for (const match of source.matchAll(/\]\(([^)]+)\)/gu)) {
    const target = match[1].trim().replace(/^<|>$/gu, '')
    if (/^(?:https?:|mailto:|#)/u.test(target)) continue
    const localPath = decodeURIComponent(target.split('#', 1)[0])
    if (!localPath) continue
    if (!existsSync(resolve(packageRoot, dirname(path), localPath))) {
      fail(`${path} links to missing ${localPath}`)
    }
  }
}

process.stdout.write(`verify-market-docs: ${markdownFiles.length} Markdown files, ${pairs.length} bilingual pairs, and ${schemaPaths.length} schemas are consistent\n`)
