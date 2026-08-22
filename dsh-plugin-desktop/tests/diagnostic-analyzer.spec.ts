import { expect, it } from 'vitest'
import { analyzeDiagnostics } from '../src/diagnostic-analyzer.ts'
it('maps a module-not-found stack to a plain-Chinese root cause with four options', () => {
  const d = analyzeDiagnostics("Error: Cannot find module 'plugin-x'\n  at boot (main.ts:831)")
  expect(d.rootCause).toContain('缺失模块')
  expect(d.severity).toBe('medium')
  expect(d.options.map(o => o.id)).toEqual(['A', 'B', 'C', 'D'])
  expect(d.disclaimer).toContain('仅供参考')
})
