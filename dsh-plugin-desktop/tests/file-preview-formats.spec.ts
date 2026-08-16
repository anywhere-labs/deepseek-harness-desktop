import { describe, expect, it } from 'vitest'
import {
  classifyExtensionlessText,
  classifyFileName,
  FILE_PREVIEW_FORMATS,
} from '../src/file-preview-formats.ts'

/** UTF-8 helper encoding a string into bytes for classifier tests. */
function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

/** Concise per-format expectation table for every extension in design §4. */
const EXTENSION_EXPECTATIONS: ReadonlyArray<{
  ext: string
  mediaType: string
  contentKind: 'text' | 'image'
  language?: string
}> = [
  { ext: 'js', mediaType: 'text/javascript', contentKind: 'text', language: 'javascript' },
  { ext: 'jsx', mediaType: 'text/javascript', contentKind: 'text', language: 'jsx' },
  { ext: 'ts', mediaType: 'text/typescript', contentKind: 'text', language: 'typescript' },
  { ext: 'tsx', mediaType: 'text/typescript', contentKind: 'text', language: 'tsx' },
  { ext: 'mjs', mediaType: 'text/javascript', contentKind: 'text', language: 'javascript' },
  { ext: 'cjs', mediaType: 'text/javascript', contentKind: 'text', language: 'javascript' },
  { ext: 'html', mediaType: 'text/html', contentKind: 'text', language: 'html' },
  { ext: 'css', mediaType: 'text/css', contentKind: 'text', language: 'css' },
  { ext: 'scss', mediaType: 'text/x-scss', contentKind: 'text', language: 'scss' },
  { ext: 'less', mediaType: 'text/x-less', contentKind: 'text', language: 'less' },
  { ext: 'vue', mediaType: 'text/x-vue', contentKind: 'text', language: 'vue' },
  { ext: 'svelte', mediaType: 'text/x-svelte', contentKind: 'text', language: 'svelte' },
  { ext: 'py', mediaType: 'text/x-python', contentKind: 'text', language: 'python' },
  { ext: 'go', mediaType: 'text/x-go', contentKind: 'text', language: 'go' },
  { ext: 'rs', mediaType: 'text/x-rust', contentKind: 'text', language: 'rust' },
  { ext: 'java', mediaType: 'text/x-java', contentKind: 'text', language: 'java' },
  { ext: 'kt', mediaType: 'text/x-kotlin', contentKind: 'text', language: 'kotlin' },
  { ext: 'c', mediaType: 'text/x-c', contentKind: 'text', language: 'c' },
  { ext: 'h', mediaType: 'text/x-c', contentKind: 'text', language: 'c' },
  { ext: 'cc', mediaType: 'text/x-c++', contentKind: 'text', language: 'cpp' },
  { ext: 'cpp', mediaType: 'text/x-c++', contentKind: 'text', language: 'cpp' },
  { ext: 'hpp', mediaType: 'text/x-c++', contentKind: 'text', language: 'cpp' },
  { ext: 'cs', mediaType: 'text/x-csharp', contentKind: 'text', language: 'csharp' },
  { ext: 'php', mediaType: 'text/x-php', contentKind: 'text', language: 'php' },
  { ext: 'rb', mediaType: 'text/x-ruby', contentKind: 'text', language: 'ruby' },
  { ext: 'lua', mediaType: 'text/x-lua', contentKind: 'text', language: 'lua' },
  { ext: 'swift', mediaType: 'text/x-swift', contentKind: 'text', language: 'swift' },
  { ext: 'sh', mediaType: 'application/x-sh', contentKind: 'text', language: 'bash' },
  { ext: 'bash', mediaType: 'application/x-sh', contentKind: 'text', language: 'bash' },
  { ext: 'zsh', mediaType: 'text/x-zsh', contentKind: 'text', language: 'zsh' },
  { ext: 'ps1', mediaType: 'application/x-powershell', contentKind: 'text', language: 'powershell' },
  { ext: 'json', mediaType: 'application/json', contentKind: 'text', language: 'json' },
  { ext: 'jsonc', mediaType: 'application/json', contentKind: 'text', language: 'jsonc' },
  { ext: 'yaml', mediaType: 'application/yaml', contentKind: 'text', language: 'yaml' },
  { ext: 'yml', mediaType: 'application/yaml', contentKind: 'text', language: 'yaml' },
  { ext: 'toml', mediaType: 'application/toml', contentKind: 'text', language: 'toml' },
  { ext: 'xml', mediaType: 'application/xml', contentKind: 'text', language: 'xml' },
  { ext: 'ini', mediaType: 'text/x-ini', contentKind: 'text', language: 'ini' },
  { ext: 'conf', mediaType: 'text/plain', contentKind: 'text', language: 'ini' },
  { ext: 'properties', mediaType: 'text/x-java-properties', contentKind: 'text', language: 'properties' },
  { ext: 'sql', mediaType: 'text/x-sql', contentKind: 'text', language: 'sql' },
  { ext: 'graphql', mediaType: 'application/graphql', contentKind: 'text', language: 'graphql' },
  { ext: 'proto', mediaType: 'text/x-protobuf', contentKind: 'text', language: 'protobuf' },
  { ext: 'md', mediaType: 'text/markdown', contentKind: 'text', language: 'markdown' },
  { ext: 'mdx', mediaType: 'text/markdown', contentKind: 'text', language: 'mdx' },
  { ext: 'txt', mediaType: 'text/plain', contentKind: 'text', language: 'plaintext' },
  { ext: 'log', mediaType: 'text/plain', contentKind: 'text' },
  { ext: 'diff', mediaType: 'text/plain', contentKind: 'text', language: 'diff' },
  { ext: 'patch', mediaType: 'text/plain', contentKind: 'text', language: 'diff' },
  { ext: 'png', mediaType: 'image/png', contentKind: 'image' },
  { ext: 'jpg', mediaType: 'image/jpeg', contentKind: 'image' },
  { ext: 'jpeg', mediaType: 'image/jpeg', contentKind: 'image' },
  { ext: 'gif', mediaType: 'image/gif', contentKind: 'image' },
  { ext: 'webp', mediaType: 'image/webp', contentKind: 'image' },
  { ext: 'svg', mediaType: 'image/svg+xml', contentKind: 'image' },
]

describe('file-preview-formats', () => {
  it.each(EXTENSION_EXPECTATIONS)('classifies .$ext with the expected metadata', ({ ext, mediaType, contentKind, language }) => {
    const { definition } = classifyFileName(`src/example.${ext}`)
    expect(definition).toBeDefined()
    expect(definition?.mediaType).toBe(mediaType)
    expect(definition?.contentKind).toBe(contentKind)
    expect(definition?.language).toBe(language)
  })

  it.each(['Dockerfile', 'Makefile', '.env'] as const)('matches the exact special file name %s', (name) => {
    const { definition, extension } = classifyFileName(name)
    expect(definition).toBeDefined()
    expect(definition?.contentKind).toBe('text')
    expect(extension).toBe('')
  })

  it('treats extensions case-insensitively', () => {
    expect(classifyFileName('file.TS')?.definition?.mediaType).toBe('text/typescript')
    expect(classifyFileName('file.Png')?.definition?.mediaType).toBe('image/png')
    expect(classifyFileName('file.MD')?.definition?.mediaType).toBe('text/markdown')
  })

  it('reports unknown extensions as undefined for delegation', () => {
    expect(classifyFileName('archive.zip')?.definition).toBeUndefined()
    expect(classifyFileName('photo.raw')?.definition).toBeUndefined()
    expect(classifyFileName('data.parquet')?.definition).toBeUndefined()
  })

  it('reports an extensionless ordinary name as a pending probe', () => {
    const { definition, extension } = classifyFileName('/some/README')
    expect(definition).toBeUndefined()
    expect(extension).toBe('')
  })

  it('accepts extensionless content that is reliable UTF-8', () => {
    const info = classifyExtensionlessText('README', utf8('hello world\n'))
    expect(info).toEqual({ mediaType: 'text/plain', contentKind: 'text' })
  })

  it('accepts extensionless content with multibyte UTF-8 characters', () => {
    expect(classifyExtensionlessText('notes', utf8('héllo—wörld 中文 🚀'))).toBeDefined()
  })

  it('rejects extensionless content containing a NUL byte', () => {
    expect(classifyExtensionlessText('bin', Uint8Array.from([0x61, 0x00, 0x62]))).toBeUndefined()
  })

  it('rejects extensionless content that is not valid UTF-8', () => {
    // A leading 0xFF is never a valid UTF-8 code point sequence.
    expect(classifyExtensionlessText('bin', Uint8Array.from([0xff, 0xfe, 0x61]))).toBeUndefined()
    // Truncated multibyte character.
    expect(classifyExtensionlessText('bin', Uint8Array.from([0x61, 0xe4, 0xb8]))).toBeUndefined()
  })

  it('exposes a non-empty single-source-of-truth format table', () => {
    expect(FILE_PREVIEW_FORMATS.length).toBeGreaterThan(0)
    const allExtensions = FILE_PREVIEW_FORMATS.flatMap(entry => entry.extensions ?? [])
    expect(new Set(allExtensions).size).toBe(allExtensions.length)
  })
})
