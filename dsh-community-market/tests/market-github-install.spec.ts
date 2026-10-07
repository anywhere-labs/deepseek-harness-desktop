import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { MarketInstallService, type MarketDesktopPnpm } from '../src/install/service.js'
import type { CatalogSnapshot } from '../src/contracts/index.js'

const source = {
  kind: 'github' as const,
  owner: 'example',
  repo: 'plugin',
  commit: '0123456789abcdef0123456789abcdef01234567',
  subdirectory: 'packages/plugin',
}

async function profile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'market-github-install-'))
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: 'fixture-profile',
    dependencies: {},
    dsh: { profile: { bundles: [] } },
  }))
  return dir
}

function snapshot(): CatalogSnapshot {
  return {
    schemaVersion: '1.0.0',
    source: {
      sourceRecordId: 'source-1',
      providerId: 'provider.example',
      adapterId: 'market.standard-http-v1',
      registrationKind: 'user-added',
      fetchedAt: '2026-08-26T00:00:00.000Z',
      finalUrl: 'https://example.test/plugins',
    },
    items: [{
      id: 'example/plugin',
      name: 'Example Plugin',
      displayName: 'Example Plugin',
      summary: 'Pinned GitHub plugin',
      repository: { url: 'https://github.com/example/plugin', subdirectory: 'packages/plugin' },
      installSource: source,
      provenance: { sourceRecordId: 'source-1', providerId: 'provider.example', itemId: 'example/plugin' },
    }],
    page: {},
  }
}

describe('Market GitHub install target', () => {
  it('verifies the source first and runs a pinned, shell-free pnpm target', async () => {
    const profileDir = await profile()
    const calls: string[][] = []
    const pnpm: MarketDesktopPnpm = {
      run(argv) {
        calls.push([...argv])
        return {
          stdout: Readable.from([]),
          stderr: Readable.from([]),
          done: (async () => {
            await writeFile(join(profileDir, 'package.json'), JSON.stringify({
              name: 'fixture-profile',
              dependencies: {
                // Real pnpm saves the git spec verbatim for a github: target
                // (--save-exact pins registry semver only), not the repo's semver.
                'dsh-plugin-git': 'github:example/plugin#0123456789abcdef0123456789abcdef01234567&path:/packages/plugin',
              },
              dsh: { profile: { bundles: ['dsh-plugin-git'] } },
            }))
            return { exitCode: 0, signal: null }
          })(),
          cancel: vi.fn(),
        }
      },
    }
    const verifier = {
      verify: vi.fn(async candidate => ({
        packageName: 'dsh-plugin-git',
        version: '1.2.3',
        source: candidate.source!,
      })),
    }
    const service = new MarketInstallService(
      () => ({ name: 'desktop', dir: profileDir }),
      pnpm,
      verifier,
    )
    try {
      service.observeCatalog(snapshot())
      const preview = await service.previewInstall('source-1', 'example/plugin', new AbortController().signal)
      expect(preview).toMatchObject({ packageName: 'dsh-plugin-git', version: '1.2.3' })
      await service.executePreview(preview.intent, new AbortController().signal)
      expect(calls).toEqual([[
        'add',
        '--save-exact',
        'github:example/plugin#0123456789abcdef0123456789abcdef01234567&path:/packages/plugin',
      ]])
      expect(verifier.verify).toHaveBeenCalledWith(expect.objectContaining({ source }), expect.any(AbortSignal))
      expect(JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8')).dependencies).toEqual({ 'dsh-plugin-git': 'github:example/plugin#0123456789abcdef0123456789abcdef01234567&path:/packages/plugin' })
    } finally {
      service.dispose()
      await rm(profileDir, { recursive: true, force: true })
    }
  })
})
