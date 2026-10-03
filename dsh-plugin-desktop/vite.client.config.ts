import { readFileSync } from 'node:fs'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, type Plugin } from 'vite'

const { name } = JSON.parse(readFileSync('package.json', 'utf8'))

// The official Loader owns styles created inside a client factory. Keep the
// existing native components' CSS active only while their onboarding is shown.
function onboardingStyles(): Plugin {
  return {
    name: 'desktop-onboarding-styles',
    enforce: 'post',
    generateBundle: { order: 'post', handler(_options, bundle) {
      const client = bundle['client.js']
      if (client?.type !== 'chunk') throw new Error('Missing Desktop client entry')
      for (const [file, asset] of Object.entries(bundle)) {
        if (asset.type !== 'asset' || !file.endsWith('.css')) continue
        // Within @scope, Tailwind's root theme must target the scope itself.
        const source = String(asset.source).replace(/:root,\s*:host\s*\{/gu, ':scope {')
        const css = `@scope (:root:has(.dshDesktopOnboardingContent)) { ${source} }`
        const install = `const style = document.createElement('style'); style.textContent = ${JSON.stringify(css)}; document.head.appendChild(style);`
        const anchor = 'var exports = module.exports;'
        if (!client.code.includes(anchor)) throw new Error('Missing Desktop client factory')
        client.code = client.code.replace(anchor, () => anchor + install)
        delete bundle[file]
      }
    } },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), onboardingStyles()],
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    outDir: 'lib', emptyOutDir: false, target: 'es2022', minify: false,
    lib: { entry: 'src/client/index.ts', formats: ['cjs'], fileName: () => 'client.js' },
    rollupOptions: {
      external: id => /^(react(?:-dom)?(?:\/|$)|@deepseek-ai\/)/u.test(id),
      output: {
        codeSplitting: false,
        banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(name)}, factory: (require) => {`,
        intro: 'var module = { exports: {} }; var exports = module.exports;',
        footer: 'return module.exports; } });',
      },
    },
  },
})
