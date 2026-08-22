import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { repairPlans } from '../src/repair-plans.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'repair-plans-'))
  roots.push(root)
  return root
}

function planById(plans: ReadonlyArray<ReturnType<typeof repairPlans>[number]>, id: string) {
  const plan = plans.find(p => p.id === id)
  if (plan === undefined) throw new Error(`missing plan ${id}`)
  return plan
}

it('registers four plans with risk and audience', () => {
  const plans = repairPlans({
    degradedStatePath: '/x',
    degradedBundle: ['plugin-x'],
    restoreLatest: async () => ({ status: 'restored', changedFiles: [], snapshotDirectory: '/s', failureGeneration: 'g' }),
  })
  expect(plans.map(p => p.id)).toEqual(['A', 'B', 'C', 'D'])
  expect(plans[0]!.risk.severity).toBe('low')
  expect(plans[1]!.audience).toBe('developer')
})

it('plan A writes the degraded bundle set and throws on a missing or empty path', async () => {
  const root = temporaryRoot()
  const statePath = join(root, 'startup-recovery', 'degraded.json')
  const plans = repairPlans({
    degradedStatePath: statePath,
    degradedBundle: ['plugin-x'],
    restoreLatest: async () => ({ status: 'restored', changedFiles: [], snapshotDirectory: '/s', failureGeneration: 'g' }),
  })

  await expect(planById(plans, 'A').apply()).resolves.toEqual({
    status: 'degraded',
    message: '已启用降级模式。请重新启动 Desktop。',
  })
  expect(JSON.parse(readFileSync(statePath, 'utf8'))).toEqual({ version: 1, bundles: ['plugin-x'] })

  const missing = repairPlans({
    degradedStatePath: undefined,
    degradedBundle: ['plugin-x'],
    restoreLatest: async () => ({ status: 'restored', changedFiles: [], snapshotDirectory: '/s', failureGeneration: 'g' }),
  })
  await expect(planById(missing, 'A').apply()).rejects.toThrow('degraded state path is required for plan A')

  const empty = repairPlans({
    degradedStatePath: '',
    degradedBundle: ['plugin-x'],
    restoreLatest: async () => ({ status: 'restored', changedFiles: [], snapshotDirectory: '/s', failureGeneration: 'g' }),
  })
  await expect(planById(empty, 'A').apply()).rejects.toThrow('degraded state path is required for plan A')
})

it('plans B and C decline with acknowledged outcomes', async () => {
  const plans = repairPlans({
    degradedStatePath: undefined,
    degradedBundle: [],
    restoreLatest: async () => { throw new Error('restore not expected') },
  })

  await expect(planById(plans, 'B').apply()).resolves.toEqual({
    status: 'acknowledged',
    message: '方案 B 需开发者二次确认，暂不自动执行。',
  })
  await expect(planById(plans, 'C').apply()).resolves.toEqual({
    status: 'acknowledged',
    message: '方案 C 需默认健康集，暂不自动执行。',
  })
})

it('plan D omits empty changed-file parens and lists files when present', async () => {
  const empty = repairPlans({
    degradedStatePath: undefined,
    degradedBundle: [],
    restoreLatest: async () => ({ status: 'restored', changedFiles: [], snapshotDirectory: '/s', failureGeneration: 'g' }),
  })
  await expect(planById(empty, 'D').apply()).resolves.toEqual({
    status: 'restored',
    message: '已恢复上次健康快照。',
  })

  const changed = repairPlans({
    degradedStatePath: undefined,
    degradedBundle: [],
    restoreLatest: async () => ({
      status: 'already-attempted',
      changedFiles: ['package.json', 'pnpm-lock.yaml'],
      snapshotDirectory: '/s',
      failureGeneration: 'g',
    }),
  })
  await expect(planById(changed, 'D').apply()).resolves.toEqual({
    status: 'already-attempted',
    message: '已恢复上次健康快照（package.json, pnpm-lock.yaml）。',
  })
})
