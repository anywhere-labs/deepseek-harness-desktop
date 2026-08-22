import { expect, it } from 'vitest'
import { runRepairSelfCheck } from '../src/repair-self-check.ts'
it('aggregates read-only checks into a report with a recommendation', async () => {
  const report = await runRepairSelfCheck([
    { name: 'plugin tree', run: async () => ({ ok: true, detail: 'loaded' }) },
    { name: 'core import', run: async () => ({ ok: false, detail: 'module not found' }) },
  ])
  expect(report.ok).toBe(false)
  expect(report.checks[0]).toEqual({ name: 'plugin tree', passed: true, detail: 'loaded' })
  expect(report.checks[1]).toEqual({ name: 'core import', passed: false, detail: 'module not found' })
  expect(report.recommendation).toContain('请尝试其他方案')
})
it('produces an ok report and restart prompt on full pass', async () => {
  const report = await runRepairSelfCheck([
    { name: 'core import', run: async () => ({ ok: true, detail: 'ok' }) },
  ])
  expect(report.ok).toBe(true)
  expect(report.recommendation).toContain('重新启动')
})
