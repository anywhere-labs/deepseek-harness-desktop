import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { NativeLocaleStore } from '../src/native-locale.ts'

const homes: string[] = []
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'next-locale-')); homes.push(home)
  const profile = join(home, 'profiles', 'work'); mkdirSync(profile, { recursive: true })
  return { home, patch: join(profile, 'cordis.patch.yml'), store: new NativeLocaleStore(home) }
}
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }) })

it('retains the resolved UI language across restart even when profile YAML prevents Host startup', () => {
  const { home, patch, store } = fixture()
  store.remember('work', 'zh-CN')
  writeFileSync(patch, '[]\nbroken: [\n')
  expect(new NativeLocaleStore(home).resolve('work', 'en-US')).toBe('zh')
  expect(readFileSync(patch, 'utf8')).toBe('[]\nbroken: [\n')
  expect(new NativeLocaleStore(home).resolve('other', 'en-US')).toBe('en')
})

it('reads an explicit locale without booting plugins or evaluating YAML expressions', () => {
  const { patch, store } = fixture()
  store.remember('work', 'en')
  writeFileSync(patch, '- id: locale\n  config: { preference: zh }\n- id: other\n  disabled: !!js "throw new Error(\'never execute\')"\n')
  expect(store.resolve('work', 'en')).toBe('zh')
  writeFileSync(patch, '- id: locale\n  config: { preference: en }\n')
  expect(store.resolve('work', 'zh')).toBe('en')
})

it('uses system Chinese on the first failed boot and tolerates damaged cache files', () => {
  const { home, patch, store } = fixture()
  writeFileSync(patch, 'invalid: [')
  writeFileSync(join(home, 'desktop-locale.json'), '{bad json')
  expect(store.resolve('work', 'zh-Hans-CN')).toBe('zh')
  store.remember('work', 'zh-CN')
  expect(store.resolve('work', 'en')).toBe('zh')
  store.remember('work', 'zh-Hant-TW')
  expect(store.resolve('work', 'en')).toBe('zh-TW')
  store.remember('work', 'not a language')
  expect(store.resolve('work', 'en')).toBe('zh-TW')
})
