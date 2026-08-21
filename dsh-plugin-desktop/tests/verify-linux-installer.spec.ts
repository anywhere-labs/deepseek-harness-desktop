import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyLinuxInstallers } from '../scripts/verify-linux-installer.ts'

const temporaryRoots: string[] = []

const AR_MAGIC = Buffer.from('!<arch>\n', 'ascii')
const RPM_MAGIC = Buffer.from([0xed, 0xab, 0xee, 0xdb])
const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46])

function artifact(magic: Buffer): Buffer {
  const body = Buffer.alloc(64)
  magic.copy(body, 0)
  return body
}

function fixture(version = '2.0.0'): {
  readonly root: string
  readonly deb: string
  readonly rpm: string
  readonly appImage: string
  readonly application: string
} {
  const root = mkdtempSync(join(tmpdir(), 'dsh-linux-installer-'))
  temporaryRoots.push(root)
  const dist = join(root, 'dist')
  const unpacked = join(dist, 'linux-unpacked')
  mkdirSync(unpacked, { recursive: true })
  const deb = join(dist, `DSH-Desktop-${version}-linux-amd64.deb`)
  const rpm = join(dist, `DSH-Desktop-${version}-linux-x86_64.rpm`)
  const appImage = join(dist, `DSH-Desktop-${version}-linux-x86_64.AppImage`)
  const application = join(unpacked, 'dsh-desktop')
  writeFileSync(deb, artifact(AR_MAGIC))
  writeFileSync(rpm, artifact(RPM_MAGIC))
  writeFileSync(appImage, artifact(ELF_MAGIC))
  writeFileSync(application, artifact(ELF_MAGIC))
  return { root, deb, rpm, appImage, application }
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Linux installer artifact verification', () => {
  it('accepts the exact versioned deb, rpm, AppImage, and unpacked application', () => {
    const value = fixture()

    expect(verifyLinuxInstallers({ desktopRoot: value.root, version: '2.0.0' })).toEqual({
      debPath: value.deb,
      rpmPath: value.rpm,
      appImagePath: value.appImage,
      applicationPath: value.application,
    })
  })

  it('rejects artifacts from a different version', () => {
    const value = fixture('1.9.0')

    expect(() => verifyLinuxInstallers({ desktopRoot: value.root, version: '2.0.0' }))
      .toThrow('DSH-Desktop-2.0.0-linux-amd64.deb')
  })

  it('rejects a deb without an ar archive signature', () => {
    const value = fixture()
    writeFileSync(value.deb, artifact(ELF_MAGIC))

    expect(() => verifyLinuxInstallers({ desktopRoot: value.root, version: '2.0.0' }))
      .toThrow('Linux deb package does not start with the expected signature')
  })

  it('rejects an rpm without the rpm lead signature', () => {
    const value = fixture()
    writeFileSync(value.rpm, artifact(AR_MAGIC))

    expect(() => verifyLinuxInstallers({ desktopRoot: value.root, version: '2.0.0' }))
      .toThrow('Linux rpm package does not start with the expected signature')
  })

  it('rejects an AppImage without an ELF header', () => {
    const value = fixture()
    writeFileSync(value.appImage, artifact(AR_MAGIC))

    expect(() => verifyLinuxInstallers({ desktopRoot: value.root, version: '2.0.0' }))
      .toThrow('Linux AppImage does not start with the expected signature')
  })

  it('rejects an unpacked application without an ELF header', () => {
    const value = fixture()
    writeFileSync(value.application, artifact(AR_MAGIC))

    expect(() => verifyLinuxInstallers({ desktopRoot: value.root, version: '2.0.0' }))
      .toThrow('unpacked Linux application does not start with the expected signature')
  })

  it('rejects an empty artifact', () => {
    const value = fixture()
    writeFileSync(value.appImage, Buffer.alloc(0))

    expect(() => verifyLinuxInstallers({ desktopRoot: value.root, version: '2.0.0' }))
      .toThrow('Linux AppImage is not a non-empty regular file')
  })
})
