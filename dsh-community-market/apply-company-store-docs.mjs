#!/usr/bin/env node
/**
 * Idempotent inserts for Company Store partner-source notes in README / market-shell.
 * Safe to run from prepare/pretest; no-ops when paragraphs already present.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))

const patches = [
  {
    file: join(root, 'README.md'),
    marker: '**Company Store** (`company-store`) is an optional partner built-in',
    after: `It is not selected by default, preferred, recommended, or used as a fallback.\n\n`,
    insert: `**Company Store** (\`company-store\`) is an optional partner built-in that shares the 1024Store-style wire shape through a reviewed adapter. It is not selected by default, is never used as a fallback when official \`dsh-1024store\` fails, and surfaces the product disclaimer \`公司目录，收录≠安全审核\` when selected. Its placeholder public apex is \`https://plugins.company.example\`.\n\n`,
  },
  {
    file: join(root, 'docs/market-shell.md'),
    marker: '**Company Store** is an optional partner built-in (`company-store`)',
    after: `Its listings, scores, grades, \`official\`/featured labels, risk labels, and installation probes remain provider claims rather than Anywhere Labs trust decisions.\n\n`,
    insert: `**Company Store** is an optional partner built-in (\`company-store\`) that reuses the reviewed 1024Store-style adapter factory against a company catalog apex. It is not default, preferred, or a fallback when \`dsh-1024store\` fails. When selected, the Market chrome shows the disclaimer \`公司目录，收录≠安全审核\` (EN: listing means inclusion only — not a security audit).\n\n`,
  },
  {
    file: join(root, 'docs/market-shell.zh.md'),
    marker: '**公司插件目录**（`company-store`）',
    after: `它的目录收录、分数、等级、\`official\`/精选标记、风险标记和安装探测仍是 provider claim，不是 Anywhere Labs 作出的信任判断。\n\n`,
    insert: `**公司插件目录**（\`company-store\`）是可选的合作内置来源，复用经审查的 1024Store 风格 adapter factory，对接公司目录 apex。它不是默认、优先来源，也不会在 \`dsh-1024store\` 失败时作为兜底。选中后 Market 界面会显示免责声明：\`公司目录，收录≠安全审核\`。\n\n`,
  },
]

let changed = 0
for (const p of patches) {
  const text = readFileSync(p.file, 'utf8')
  if (text.includes(p.marker)) {
    console.log('skip (present):', p.file)
    continue
  }
  if (!text.includes(p.after)) {
    console.error('anchor missing:', p.file)
    process.exitCode = 1
    continue
  }
  writeFileSync(p.file, text.replace(p.after, p.after + p.insert, 1))
  console.log('patched:', p.file)
  changed += 1
}
console.log('company-store docs patches applied:', changed)
