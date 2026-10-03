import { defineConfig } from 'vitest/config'
import { createRequire } from 'node:module'

// Shared Desktop components must resolve the same peer module as Next's tests.
export default defineConfig({ resolve: { alias: [
  { find: /^react$/, replacement: createRequire(import.meta.url).resolve('react') },
  { find: '@deepseek-ai/dsh-client-ui-primitives', replacement: createRequire(import.meta.url).resolve('@deepseek-ai/dsh-client-ui-primitives') },
] }, test: { include: ['tests/**/*.spec.ts'], testTimeout: 20_000,
  server: { deps: { inline: ['@deepseek-ai/dsh-experimental-computer-use-cua-driver-native', '@deepseek-ai/dsh-host-open-in-app', '@deepseek-ai/dsh-native-command'] } },
} })
