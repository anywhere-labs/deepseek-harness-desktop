// These public Host/HTTP and installed browser-factory tests are headless and
// do not use Electron. Keep their focused gate independent of binary downloads.
export default {
  test: {
    environment: 'node',
    include: ['tests/provider-reasoning*.spec.ts'],
    maxWorkers: 1,
  },
}
