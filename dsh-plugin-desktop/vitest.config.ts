import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
    // The published ui-primitives package imports CSS modules and KaTeX CSS;
    // inlining it lets Vite transform those imports into empty modules so the
    // jsdom component specs can import MarkdownText/ReadBlock/JsonTree.
    server: {
      deps: {
        inline: [/@deepseek-ai\/dsh-client-ui-primitives/],
      },
    },
  },
})
