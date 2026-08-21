import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import DesktopWebServer from '../src/webserver.ts'

const occupied: Server[] = []
const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(context => context.fiber.dispose()))
  await Promise.all(occupied.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
})

async function occupy(): Promise<{ server: Server; port: number }> {
  const server = createServer()
  occupied.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('test server did not expose an address')
  return { server, port: address.port }
}

describe('Desktop WebServer port policy', () => {
  it('rejects a non-loopback bind even when invoked outside profile composition', async () => {
    const context = new Context()
    contexts.push(context)

    await expect(context.plugin(DesktopWebServer, { host: '0.0.0.0', port: 43_120 }))
      .rejects.toThrow('requires a loopback host')
  })

  it('increments only after the requested loopback bind reports EADDRINUSE', async () => {
    const blocked = await occupy()
    const context = new Context()
    contexts.push(context)

    await context.plugin(DesktopWebServer, { host: '127.0.0.1', port: blocked.port })

    expect(context.get('webServer')?.port).toBe(blocked.port + 1)
  })

  it('preserves an OS-assigned port when the explicit value is zero', async () => {
    const context = new Context()
    contexts.push(context)

    await context.plugin(DesktopWebServer, { host: '127.0.0.1', port: 0 })

    expect(context.get('webServer')?.port).toBeGreaterThan(0)
  })
})
