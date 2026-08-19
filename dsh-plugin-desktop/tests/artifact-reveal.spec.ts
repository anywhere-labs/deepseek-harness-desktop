import { describe, expect, it } from 'vitest'
import { desktopArtifactRevealCopy, resolveDesktopArtifactPath } from '../src/artifact-reveal.ts'

describe('desktop artifact reveal contract', () => {
  it('resolves relative and absolute paths with the target platform grammar', () => {
    expect(resolveDesktopArtifactPath({
      cwd: '/Users/test/work',
      path: 'reports/../result.md',
    }, 'darwin')).toBe('/Users/test/work/result.md')
    expect(resolveDesktopArtifactPath({
      cwd: 'C:\\work',
      path: 'reports\\result.md',
    }, 'win32')).toBe('C:\\work\\reports\\result.md')
    expect(resolveDesktopArtifactPath({
      path: 'D:\\exports\\result.md',
    }, 'win32')).toBe('D:\\exports\\result.md')
    expect(resolveDesktopArtifactPath({
      path: '\\\\server\\share\\exports\\result.md',
    }, 'win32')).toBe('\\\\server\\share\\exports\\result.md')
  })

  it('anchors drive-less Windows roots to the session workspace root', () => {
    expect(resolveDesktopArtifactPath({
      cwd: 'D:\\work\\project',
      path: '\\reports\\result.md',
    }, 'win32')).toBe('D:\\reports\\result.md')
    expect(resolveDesktopArtifactPath({
      cwd: '\\\\server\\share\\work\\project',
      path: '/reports/result.md',
    }, 'win32')).toBe('\\\\server\\share\\reports\\result.md')
  })

  it('rejects malformed or unsupported requests before native APIs see them', () => {
    expect(() => resolveDesktopArtifactPath(null, 'darwin')).toThrow('must be an object')
    expect(() => resolveDesktopArtifactPath({ path: '' }, 'darwin')).toThrow('non-empty string')
    expect(() => resolveDesktopArtifactPath({ cwd: 'relative', path: 'file.md' }, 'darwin'))
      .toThrow('cwd must be absolute')
    expect(() => resolveDesktopArtifactPath({ cwd: '\\work', path: 'file.md' }, 'win32'))
      .toThrow('fully qualified Windows path')
    expect(() => resolveDesktopArtifactPath({ cwd: 'D:\\work', path: 'C:result.md' }, 'win32'))
      .toThrow('must not be drive-relative')
    expect(() => resolveDesktopArtifactPath({ path: '\\\\server' }, 'win32'))
      .toThrow('complete UNC path')
    expect(() => resolveDesktopArtifactPath({ path: '\\\\?\\C:\\result.md' }, 'win32'))
      .toThrow('device namespace')
    expect(() => resolveDesktopArtifactPath({ path: '/tmp/file\0.md' }, 'darwin')).toThrow('contains NUL')
    expect(() => resolveDesktopArtifactPath({ path: '/tmp/file.md' }, 'linux')).toThrow('unavailable on linux')
  })

  it('uses the native platform vocabulary in both supported locales', () => {
    expect(desktopArtifactRevealCopy('darwin', 'en').label).toBe('Reveal in Finder')
    expect(desktopArtifactRevealCopy('darwin', 'zh').label).toBe('在访达中显示')
    expect(desktopArtifactRevealCopy('win32', 'en').label).toBe('Show in File Explorer')
    expect(desktopArtifactRevealCopy('win32', 'zh').label).toBe('在文件资源管理器中显示')
  })
})
