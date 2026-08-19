// @vitest-environment jsdom

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { ComponentType } from 'react'
import type { ProducedFilesProps } from '@deepseek-ai/dsh-client-ui-deliverables/client'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { producedPathFromCompatibilityTarget } from '../src/client/artifact-context-menu.tsx'

// The desktop source imports the Loader bundle normally; this suite evaluates
// the real artifact explicitly below so its handoff can receive test externals.
vi.mock('@deepseek-ai/dsh-client-ui-deliverables/client', () => ({
  ProducedFiles: () => null,
  producedForClosing: () => [],
}))

interface ClientHandoff {
  id: string
  factory(requireModule: (specifier: string) => unknown): Record<string, unknown>
}

type LoaderWindow = Window & { __ModuleLoader__?: { load(handoff: ClientHandoff): void } }

async function loadProducedFilesArtifact(): Promise<ComponentType<ProducedFilesProps>> {
  const require = createRequire(import.meta.url)
  const code = readFileSync(require.resolve('@deepseek-ai/dsh-client-ui-deliverables/client'), 'utf8')
  let handoff: ClientHandoff | undefined
  ;(window as LoaderWindow).__ModuleLoader__ = { load: value => { handoff = value } }
  // The built Client face deliberately registers through the browser Loader handoff.
  // oxlint-disable-next-line typescript/no-implied-eval, typescript/no-unsafe-call
  new Function(code)()
  if (handoff === undefined) throw new Error('deliverables Client bundle did not register a Loader handoff')
  const modules = new Map<string, unknown>([
    ['react', await import('react')],
    ['react/jsx-runtime', await import('react/jsx-runtime')],
    ['@deepseek-ai/dsh-client-runtime/client', { isAppendSurfaceEvent: () => false }],
  ])
  const exports = handoff.factory((specifier) => {
    if (!modules.has(specifier)) throw new Error(`unexpected deliverables external ${specifier}`)
    return modules.get(specifier)
  })
  return exports.ProducedFiles as ComponentType<ProducedFilesProps>
}

afterEach(() => {
  cleanup()
  delete (window as LoaderWindow).__ModuleLoader__
})

describe('upstream produced-file DOM contract', () => {
  it('keeps a visible titled chip inside the marked produced-files row', async () => {
    const ProducedFiles = await loadProducedFilesArtifact()
    render(<ProducedFiles
      isLoopback
      matched={['reports/result.md']}
      openFile={() => {}}
      t={((key: string) => key) as ProducedFilesProps['t']}
      useHostDescription={((selector: (value: { canOpenPath: boolean }) => unknown) => (
        selector({ canOpenPath: true })
      )) as ProducedFilesProps['useHostDescription']}
    />)

    const chip = screen.getByTitle('reports/result.md')
    expect(chip.closest('[data-produced-files-row]')).not.toBeNull()
    expect(producedPathFromCompatibilityTarget(chip)).toBe('reports/result.md')
  })
})
