import { describe, expect, it } from 'vitest'
import type { FilePreviewDescriptor } from '../src/file-preview-contract.ts'
import { FilePreviewResourceId as brandResourceId } from '../src/file-preview-contract.ts'
import type { FilePreviewFormatDefinition } from '../src/file-preview-formats.ts'
import { FILE_PREVIEW_FORMATS } from '../src/file-preview-formats.ts'
import { FilePreviewRegistry, type FilePreviewProvider } from '../src/client/file-preview/registry.ts'

/** Dummy component fulfilling the register-time shape without rendering. */
function DummyComponent(): null {
  return null
}

/** Providers mirroring the four built-in selection rules from design §6.4. */
const JSON_PROVIDER: FilePreviewProvider = {
  id: 'json',
  priority: 400,
  loadMode: 'text',
  supports: descriptor => descriptor.extension === '.json',
  Component: DummyComponent,
}

const MARKDOWN_PROVIDER: FilePreviewProvider = {
  id: 'markdown',
  priority: 350,
  loadMode: 'text',
  supports: descriptor => descriptor.extension === '.md',
  Component: DummyComponent,
}

const IMAGE_PROVIDER: FilePreviewProvider = {
  id: 'image',
  priority: 300,
  loadMode: 'binary-url',
  supports: descriptor => descriptor.contentKind === 'image',
  Component: DummyComponent,
}

const SOURCE_PROVIDER: FilePreviewProvider = {
  id: 'source',
  priority: 100,
  loadMode: 'text',
  supports: descriptor => descriptor.contentKind === 'text',
  Component: DummyComponent,
}

/** Build one probe-style descriptor for a format-table entry. */
function descriptorFor(definition: FilePreviewFormatDefinition): FilePreviewDescriptor {
  const extension = definition.extensions?.[0] ?? ''
  return {
    availability: 'available',
    resourceId: brandResourceId('test-resource-id'),
    displayPath: 'sample',
    name: 'sample',
    extension: extension === '' ? '' : `.${extension}`,
    mediaType: definition.mediaType,
    contentKind: definition.contentKind,
    size: 1,
    ...(definition.language === undefined ? {} : { language: definition.language }),
  }
}

/** Expected provider id for a table entry under the built-in selection rules. */
function expectedProviderId(definition: FilePreviewFormatDefinition): string {
  if (definition.extensions?.includes('json')) return 'json'
  if (definition.extensions?.includes('md')) return 'markdown'
  if (definition.contentKind === 'image') return 'image'
  return 'source'
}

function makeRegistry(): FilePreviewRegistry {
  const registry = new FilePreviewRegistry()
  registry.register(JSON_PROVIDER)
  registry.register(MARKDOWN_PROVIDER)
  registry.register(IMAGE_PROVIDER)
  registry.register(SOURCE_PROVIDER)
  return registry
}

describe('file-preview-registry', () => {
  it('resolves the highest priority provider for a matched descriptor', () => {
    const registry = makeRegistry()
    // JSON and Markdown are both text contentKind, so Source also matches; the
    // higher priorities must win.
    expect(registry.resolve(descriptorFor({ extensions: ['json'], mediaType: 'application/json', contentKind: 'text' }))?.id).toBe('json')
    expect(registry.resolve(descriptorFor({ extensions: ['md'], mediaType: 'text/markdown', contentKind: 'text' }))?.id).toBe('markdown')
    expect(registry.resolve(descriptorFor({ extensions: ['png'], mediaType: 'image/png', contentKind: 'image' }))?.id).toBe('image')
    expect(registry.resolve(descriptorFor({ extensions: ['properties'], mediaType: 'text/x-java-properties', contentKind: 'text' }))?.id).toBe('source')
  })

  it('breaks same-priority ties by earliest registration order', () => {
    const registry = new FilePreviewRegistry()
    const first: FilePreviewProvider = {
      id: 'first', priority: 10, loadMode: 'text', supports: () => true, Component: DummyComponent,
    }
    const second: FilePreviewProvider = {
      id: 'second', priority: 10, loadMode: 'text', supports: () => true, Component: DummyComponent,
    }
    const third: FilePreviewProvider = {
      id: 'third', priority: 10, loadMode: 'text', supports: () => true, Component: DummyComponent,
    }
    registry.register(second)
    registry.register(first)
    registry.register(third)
    const descriptor = descriptorFor({ extensions: ['txt'], mediaType: 'text/plain', contentKind: 'text' })
    // 'second' registered before 'first' before 'third'; earliest wins.
    expect(registry.resolve(descriptor)?.id).toBe('second')
  })

  it('throws immediately on a duplicate provider id', () => {
    const registry = makeRegistry()
    expect(() => registry.register({ ...JSON_PROVIDER, id: 'json' })).toThrow(/duplicate file preview provider id/)
  })

  it('registration disposer removes only its own registration idempotently', () => {
    const registry = new FilePreviewRegistry()
    const disposerA = registry.register({ ...JSON_PROVIDER })
    const disposerB = registry.register({ ...MARKDOWN_PROVIDER })
    expect(registry.list()).toHaveLength(2)
    disposerA()
    // Idempotent: a second call is a no-op.
    disposerA()
    expect(registry.list().map(p => p.id)).toEqual(['markdown'])
    disposerB()
    disposerB()
    expect(registry.list()).toHaveLength(0)
  })

  it('every format-table entry resolves to exactly one expected provider', () => {
    const registry = makeRegistry()
    for (const definition of FILE_PREVIEW_FORMATS) {
      const resolved = registry.resolve(descriptorFor(definition))
      expect(resolved, definition.mediaType).toBeDefined()
      expect(resolved?.id).toBe(expectedProviderId(definition))
    }
  })

  it('asserts the specific contract mappings the design calls out', () => {
    const registry = makeRegistry()
    const jsonc = descriptorFor({ extensions: ['jsonc'], mediaType: 'application/json', contentKind: 'text' })
    expect(registry.resolve(jsonc)?.id).toBe('source')
    const mdx = descriptorFor({ extensions: ['mdx'], mediaType: 'text/markdown', contentKind: 'text' })
    expect(registry.resolve(mdx)?.id).toBe('source')
    const json = descriptorFor({ extensions: ['json'], mediaType: 'application/json', contentKind: 'text' })
    expect(registry.resolve(json)?.id).toBe('json')
    const md = descriptorFor({ extensions: ['md'], mediaType: 'text/markdown', contentKind: 'text' })
    expect(registry.resolve(md)?.id).toBe('markdown')
    const specialDockerfile = descriptorFor({ fileNames: ['Dockerfile'], mediaType: 'text/plain', contentKind: 'text' })
    expect(registry.resolve(specialDockerfile)?.id).toBe('source')
  })

  it('has no provider when none supports the descriptor', () => {
    const unsupported = descriptorFor({ mediaType: 'application/octet-stream', contentKind: 'text' })
    // image provider matches contentKind 'image' only; this is text but no
    // source provider registered (remove it) should leave no match.
    const solo = new FilePreviewRegistry()
    solo.register(IMAGE_PROVIDER)
    expect(solo.resolve(unsupported)).toBeUndefined()
  })
})
