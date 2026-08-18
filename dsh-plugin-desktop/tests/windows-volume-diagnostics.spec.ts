import { describe, expect, it } from 'vitest'
import {
  diagnoseWindowsVolumes,
  evaluateWindowsWorkspaceVolume,
  formatWindowsVolumeConcern,
  windowsVolumeQuery,
  type WindowsVolumeInfo,
} from '../src/windows-volume-diagnostics.ts'

function query(info: WindowsVolumeInfo) {
  return () => info
}

describe('Windows volume diagnostics', () => {
  it.runIf(process.platform === 'win32')('queries the host volume through Windows APIs', () => {
    const info = windowsVolumeQuery()(process.cwd())

    expect(info.root).toMatch(/^[A-Z]:\\$/iu)
    expect(info.fileSystem.length).toBeGreaterThan(0)
    expect(info.driveType).toBeGreaterThan(0)
  })

  it('skips non-Windows hosts without touching the query', () => {
    const result = diagnoseWindowsVolumes('darwin', [{ label: 'DSH home', path: '/Users/a/.dsh' }], () => {
      throw new Error('should not run')
    })

    expect(result).toEqual([])
  })

  it('accepts fixed NTFS and ReFS volumes', () => {
    expect(diagnoseWindowsVolumes('win32', [{ label: 'install', path: 'C:\\App\\DSH Desktop.exe' }], query({
      root: 'C:\\',
      fileSystem: 'NTFS',
      driveType: 3,
    }))).toEqual([])
    expect(diagnoseWindowsVolumes('win32', [{ label: 'install', path: 'D:\\App\\DSH Desktop.exe' }], query({
      root: 'D:\\',
      fileSystem: 'REFS',
      driveType: 3,
    }))).toEqual([])
  })

  it('warns for non-NTFS volumes and removable drives', () => {
    expect(diagnoseWindowsVolumes('win32', [{ label: 'workspace', path: 'E:\\repo' }], query({
      root: 'E:\\',
      fileSystem: 'EXFAT',
      driveType: 2,
    }))).toEqual([expect.objectContaining({
      label: 'workspace',
      fileSystem: 'EXFAT',
      driveType: 2,
      reason: expect.stringContaining('NTFS-style ACL'),
    })])

    expect(diagnoseWindowsVolumes('win32', [{ label: 'workspace', path: 'E:\\repo' }], query({
      root: 'E:\\',
      fileSystem: 'NTFS',
      driveType: 2,
    }))).toEqual([expect.objectContaining({
      label: 'workspace',
      fileSystem: 'NTFS',
      driveType: 2,
      reason: expect.stringContaining('removable drives'),
    })])
  })

  it('allows fixed ACL-capable workspace volumes', () => {
    expect(evaluateWindowsWorkspaceVolume('win32', 'D:\\repo', query({
      root: 'D:\\',
      fileSystem: 'NTFS',
      driveType: 3,
    }))).toEqual({ action: 'allow' })
  })

  it('requires confirmation for removable NTFS workspaces', () => {
    expect(evaluateWindowsWorkspaceVolume('win32', 'E:\\repo', query({
      root: 'E:\\',
      fileSystem: 'NTFS',
      driveType: 2,
    }))).toEqual({
      action: 'confirm',
      concern: expect.objectContaining({ fileSystem: 'NTFS', driveType: 2 }),
    })
  })

  it.each([
    ['EXFAT', 2],
    ['FAT32', 2],
    ['NTFS', 4],
    ['NTFS', 0],
    ['NTFS', 1],
    ['NTFS', 5],
    ['NTFS', 6],
  ])('blocks unsupported workspace storage (%s, drive type %s)', (fileSystem, driveType) => {
    expect(evaluateWindowsWorkspaceVolume('win32', 'E:\\repo', query({
      root: 'E:\\',
      fileSystem,
      driveType,
    }))).toEqual({
      action: 'block',
      concern: expect.objectContaining({ fileSystem, driveType }),
    })
  })

  it('blocks a workspace when its volume cannot be inspected', () => {
    expect(evaluateWindowsWorkspaceVolume('win32', 'E:\\repo', () => {
      throw new Error('drive disconnected')
    })).toEqual({
      action: 'block',
      concern: expect.objectContaining({ reason: expect.stringContaining('drive disconnected') }),
    })
  })

  it('formats the concern for stderr diagnostics', () => {
    expect(formatWindowsVolumeConcern({
      label: 'DSH home',
      path: 'E:\\.dsh',
      root: 'E:\\',
      fileSystem: 'FAT32',
      driveType: 2,
      reason: 'unsupported',
    })).toContain('DSH home: unsupported (path=E:\\.dsh; root=E:\\; fs=FAT32; driveType=2)')
  })
})
