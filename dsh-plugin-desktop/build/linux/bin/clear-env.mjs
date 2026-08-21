// Preloaded into packaged pnpm/node command trees: remove the Electron
// RunAsNode launch marker before a JavaScript entry runs, so children it
// spawns do not inherit Electron-only mode. Mirrors the desktop clear-env
// module emitted by desktop-runtime-environment.ts.
for (const name of Object.keys(process.env)) {
  if (name.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete process.env[name]
}
