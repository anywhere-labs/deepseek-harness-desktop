import { describe, expect, it } from 'vitest'
import { relativeTreePath } from '../src/client/desktop-file-context-path.ts'

describe('Desktop file-tree relative paths', () => {
  it('returns a slash-separated path relative to a POSIX root', () => {
    expect(relativeTreePath('/workspace/project/', '/workspace/project/src/main.ts')).toBe('src/main.ts')
    expect(relativeTreePath('/', '/workspace/project')).toBe('workspace/project')
  })

  it('rejects paths outside the root, the root itself, and traversal segments', () => {
    expect(relativeTreePath('/workspace/project', '/workspace/project-old/secret.txt')).toBeUndefined()
    expect(relativeTreePath('/workspace/project', '/workspace/project')).toBeUndefined()
    expect(relativeTreePath('/workspace/project', '/workspace/project/src/../secret.txt')).toBeUndefined()
    expect(relativeTreePath('workspace/project', '/workspace/project/file.txt')).toBeUndefined()
  })

  it('compares Windows drive paths case-insensitively and normalizes separators', () => {
    expect(relativeTreePath('C:\\Work\\Project', 'c:/work/project/src/Main.ts')).toBe('src/Main.ts')
    expect(relativeTreePath('C:\\Work\\Project', 'D:\\Work\\Project\\file.txt')).toBeUndefined()
    expect(relativeTreePath('C:\\Work\\Project', 'C:\\Work\\Project-old\\file.txt')).toBeUndefined()
  })

  it('supports UNC roots with either separator style', () => {
    expect(relativeTreePath('\\\\server\\share\\repo', '//SERVER/share/repo/src/file.ts'))
      .toBe('src/file.ts')
  })

  it('preserves case-sensitive POSIX path matching and literal backslashes', () => {
    expect(relativeTreePath('/workspace/Repo', '/workspace/repo/file.txt')).toBeUndefined()
    expect(relativeTreePath('/workspace/foo\\bar', '/workspace/foo/bar/file.txt')).toBeUndefined()
    expect(relativeTreePath('/workspace', '/workspace/foo\\bar/file.txt')).toBe('foo\\bar/file.txt')
  })
})
