/**
 * Single source of truth for the built-in file viewer's supported formats
 * (design §4). The table maps extensions and exact special file names to their
 * media type, payload kind, and optional syntax language. This module is
 * browser-loadable with no dependencies so both the Host gateway probe and the
 * Client open-path decorator can classify a path with the same lexical rules.
 * The Host remains the authorization authority; a Client pre-check is advisory.
 * @module dsh-plugin-desktop/file-preview-formats
 */

/**
 * One supported format entry. `extensions` carry no leading dot and are lower
 * case; `fileNames` are exact basenames matched without an extension (for
 * example `Dockerfile`, `Makefile`, `.env`).
 */
export interface FilePreviewFormatDefinition {
  /** Lowercased extensions with no leading dot, matched via the file basename. */
  extensions?: readonly string[]
  /** Exact basenames matched without extension rules. */
  fileNames?: readonly string[]
  /** Canonical media type of the payload. */
  mediaType: string
  /** Payload family: source text or binary/embedded image. */
  contentKind: 'text' | 'image'
  /** Optional Source-family syntax language identifier. */
  language?: string
}

/** JavaScript and web frontend formats. */
const JAVASCRIPT_WEB: readonly FilePreviewFormatDefinition[] = [
  { extensions: ['js'], contentKind: 'text', mediaType: 'text/javascript', language: 'javascript' },
  { extensions: ['jsx'], contentKind: 'text', mediaType: 'text/javascript', language: 'jsx' },
  { extensions: ['ts'], contentKind: 'text', mediaType: 'text/typescript', language: 'typescript' },
  { extensions: ['tsx'], contentKind: 'text', mediaType: 'text/typescript', language: 'tsx' },
  { extensions: ['mjs'], contentKind: 'text', mediaType: 'text/javascript', language: 'javascript' },
  { extensions: ['cjs'], contentKind: 'text', mediaType: 'text/javascript', language: 'javascript' },
  { extensions: ['html'], contentKind: 'text', mediaType: 'text/html', language: 'html' },
  { extensions: ['css'], contentKind: 'text', mediaType: 'text/css', language: 'css' },
  { extensions: ['scss'], contentKind: 'text', mediaType: 'text/x-scss', language: 'scss' },
  { extensions: ['less'], contentKind: 'text', mediaType: 'text/x-less', language: 'less' },
  { extensions: ['vue'], contentKind: 'text', mediaType: 'text/x-vue', language: 'vue' },
  { extensions: ['svelte'], contentKind: 'text', mediaType: 'text/x-svelte', language: 'svelte' },
]

/** General-purpose programming languages. */
const GENERAL_LANGUAGES: readonly FilePreviewFormatDefinition[] = [
  { extensions: ['py'], contentKind: 'text', mediaType: 'text/x-python', language: 'python' },
  { extensions: ['go'], contentKind: 'text', mediaType: 'text/x-go', language: 'go' },
  { extensions: ['rs'], contentKind: 'text', mediaType: 'text/x-rust', language: 'rust' },
  { extensions: ['java'], contentKind: 'text', mediaType: 'text/x-java', language: 'java' },
  { extensions: ['kt'], contentKind: 'text', mediaType: 'text/x-kotlin', language: 'kotlin' },
  { extensions: ['c'], contentKind: 'text', mediaType: 'text/x-c', language: 'c' },
  { extensions: ['h'], contentKind: 'text', mediaType: 'text/x-c', language: 'c' },
  { extensions: ['cc'], contentKind: 'text', mediaType: 'text/x-c++', language: 'cpp' },
  { extensions: ['cpp'], contentKind: 'text', mediaType: 'text/x-c++', language: 'cpp' },
  { extensions: ['hpp'], contentKind: 'text', mediaType: 'text/x-c++', language: 'cpp' },
  { extensions: ['cs'], contentKind: 'text', mediaType: 'text/x-csharp', language: 'csharp' },
  { extensions: ['php'], contentKind: 'text', mediaType: 'text/x-php', language: 'php' },
  { extensions: ['rb'], contentKind: 'text', mediaType: 'text/x-ruby', language: 'ruby' },
  { extensions: ['lua'], contentKind: 'text', mediaType: 'text/x-lua', language: 'lua' },
  { extensions: ['swift'], contentKind: 'text', mediaType: 'text/x-swift', language: 'swift' },
]

/** Shell and automation scripts plus their exact special file names. */
const SHELL_AUTOMATION: readonly FilePreviewFormatDefinition[] = [
  { extensions: ['sh'], contentKind: 'text', mediaType: 'application/x-sh', language: 'bash' },
  { extensions: ['bash'], contentKind: 'text', mediaType: 'application/x-sh', language: 'bash' },
  { extensions: ['zsh'], contentKind: 'text', mediaType: 'text/x-zsh', language: 'zsh' },
  { extensions: ['ps1'], contentKind: 'text', mediaType: 'application/x-powershell', language: 'powershell' },
  { extensions: [], fileNames: ['Dockerfile'], contentKind: 'text', mediaType: 'text/plain', language: 'dockerfile' },
  { extensions: [], fileNames: ['Makefile'], contentKind: 'text', mediaType: 'text/x-makefile', language: 'makefile' },
]

/** Configuration and data formats. */
const CONFIG_DATA: readonly FilePreviewFormatDefinition[] = [
  { extensions: ['json'], contentKind: 'text', mediaType: 'application/json', language: 'json' },
  { extensions: ['jsonc'], contentKind: 'text', mediaType: 'application/json', language: 'jsonc' },
  { extensions: ['yaml'], contentKind: 'text', mediaType: 'application/yaml', language: 'yaml' },
  { extensions: ['yml'], contentKind: 'text', mediaType: 'application/yaml', language: 'yaml' },
  { extensions: ['toml'], contentKind: 'text', mediaType: 'application/toml', language: 'toml' },
  { extensions: ['xml'], contentKind: 'text', mediaType: 'application/xml', language: 'xml' },
  { extensions: ['ini'], contentKind: 'text', mediaType: 'text/x-ini', language: 'ini' },
  { extensions: ['conf'], contentKind: 'text', mediaType: 'text/plain', language: 'ini' },
  { extensions: [], fileNames: ['.env'], contentKind: 'text', mediaType: 'text/plain', language: 'ini' },
  { extensions: ['properties'], contentKind: 'text', mediaType: 'text/x-java-properties', language: 'properties' },
  { extensions: ['sql'], contentKind: 'text', mediaType: 'text/x-sql', language: 'sql' },
  { extensions: ['graphql'], contentKind: 'text', mediaType: 'application/graphql', language: 'graphql' },
  { extensions: ['proto'], contentKind: 'text', mediaType: 'text/x-protobuf', language: 'protobuf' },
]

/** Text and documentation formats. */
const TEXT_DOCS: readonly FilePreviewFormatDefinition[] = [
  { extensions: ['md'], contentKind: 'text', mediaType: 'text/markdown', language: 'markdown' },
  { extensions: ['mdx'], contentKind: 'text', mediaType: 'text/markdown', language: 'mdx' },
  { extensions: ['txt'], contentKind: 'text', mediaType: 'text/plain', language: 'plaintext' },
  { extensions: ['log'], contentKind: 'text', mediaType: 'text/plain' },
]

/** Diff and patch files rendered through the Source family. */
const DIFF_PATCH: readonly FilePreviewFormatDefinition[] = [
  { extensions: ['diff'], contentKind: 'text', mediaType: 'text/plain', language: 'diff' },
  { extensions: ['patch'], contentKind: 'text', mediaType: 'text/plain', language: 'diff' },
]

/** Development asset images served through the controlled binary data plane. */
const DEV_IMAGES: readonly FilePreviewFormatDefinition[] = [
  { extensions: ['png'], contentKind: 'image', mediaType: 'image/png' },
  { extensions: ['jpg'], contentKind: 'image', mediaType: 'image/jpeg' },
  { extensions: ['jpeg'], contentKind: 'image', mediaType: 'image/jpeg' },
  { extensions: ['gif'], contentKind: 'image', mediaType: 'image/gif' },
  { extensions: ['webp'], contentKind: 'image', mediaType: 'image/webp' },
  { extensions: ['svg'], contentKind: 'image', mediaType: 'image/svg+xml' },
]

/**
 * Complete supported-format table (design §4), exported so the Provider
 * registry contract tests in stage 2 can iterate every entry.
 */
export const FILE_PREVIEW_FORMATS: readonly FilePreviewFormatDefinition[] = [
  ...JAVASCRIPT_WEB,
  ...GENERAL_LANGUAGES,
  ...SHELL_AUTOMATION,
  ...CONFIG_DATA,
  ...TEXT_DOCS,
  ...DIFF_PATCH,
  ...DEV_IMAGES,
]

/** Lowercase extension lookup built once from the format table. */
const EXTENSION_MAP = new Map<string, FilePreviewFormatDefinition>()

/** Exact file-name lookup built once from the format table. */
const FILE_NAME_MAP = new Map<string, FilePreviewFormatDefinition>()

for (const definition of FILE_PREVIEW_FORMATS) {
  for (const extension of definition.extensions ?? []) EXTENSION_MAP.set(extension, definition)
  for (const fileName of definition.fileNames ?? []) FILE_NAME_MAP.set(fileName, definition)
}

/** Result of classifying a file's basename along with its derived label parts. */
export interface FileNameClassification {
  /** The matched format definition, or undefined when no table entry matches. */
  definition: FilePreviewFormatDefinition | undefined
  /** Lowercased extension without the leading dot, or `''` when absent. */
  extension: string
  /** The basename passed in, unchanged. */
  baseName: string
}

/**
 * Classify a file basename against the format table. Extension comparison is
 * case-insensitive and special file names are exact. A path with an
 * unrecognized extension returns a classification with `definition ===
 * undefined` and the caller should delegate; a path with no extension and no
 * exact file-name match returns `definition === undefined` and `extension ===
 * ''` so the caller can probe it as extensionless text.
 * @param name - final path segment (basename).
 * @returns the classification with the matched definition, normalized
 *   extension, and unchanged basename.
 */
export function classifyFileName(name: string): FileNameClassification {
  const baseName = name
  const exact = FILE_NAME_MAP.get(name)
  if (exact !== undefined) return { definition: exact, extension: '', baseName }
  const lastDot = name.lastIndexOf('.')
  if (lastDot <= 0) return { definition: undefined, extension: '', baseName }
  const extension = name.slice(lastDot + 1).toLowerCase()
  const definition = EXTENSION_MAP.get(extension)
  return { definition, extension, baseName }
}

/** Structural result of classifying an extensionless file's content. */
export interface ExtensionlessTextInfo {
  /** Canonical media type always `text/plain` for accepted extensionless text. */
  mediaType: 'text/plain'
  /** Payload family always `text` for accepted extensionless text. */
  contentKind: 'text'
}

/**
 * Classify an extensionless file's raw bytes as reliable UTF-8 text. Returns
 * the descriptor info when the bytes contain no NUL and decode as UTF-8 with a
 * fatal decoder (a BOM is tolerated but stripped by the reader, not here), and
 * `undefined` when the content is binary or malformed so the caller delegates.
 * @param _name - the extensionless basename, currently unused by classification.
 * @param bytes - the full file bytes read within the text limit.
 * @returns the extensionless text info, or `undefined` to delegate.
 */
export function classifyExtensionlessText(_name: string, bytes: Uint8Array): ExtensionlessTextInfo | undefined {
  if (bytes.includes(0)) return undefined
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return undefined
  }
  return { mediaType: 'text/plain', contentKind: 'text' }
}
