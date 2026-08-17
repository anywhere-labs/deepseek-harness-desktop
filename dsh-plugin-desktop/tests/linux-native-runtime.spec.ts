import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  LINUX_X64_NODE_PTY_DESTINATION,
  LINUX_X64_NODE_PTY_SOURCE,
  prepareLinuxNativeRuntime,
} from '../scripts/linux-native-runtime.ts'

function addon(machine = 62, nodeApi = true): Buffer {
  const value = Buffer.alloc(96)
  Buffer.from([0x7f, 0x45, 0x4c, 0x46]).copy(value)
  value[4] = 2
  value[5] = 1
  value.writeUInt16LE(machine, 18)
  if (nodeApi) value.write('napi_register_module_v1', 32)
  return value
}

function options(read: (path: string) => Buffer) {
  const mkdir = vi.fn<(path: string) => void>()
  const copy = vi.fn<(source: string, destination: string) => void>()
  const chmod = vi.fn<(path: string, mode: number) => void>()
  return {
    desktopRoot: '/desktop',
    read: vi.fn(read),
    mkdir,
    copy,
    chmod,
  }
}

describe('Linux native runtime preparation', () => {
  it('validates an existing x64 Node-API loader prebuild in place', () => {
    const value = options(() => addon())

    prepareLinuxNativeRuntime(value)

    const destination = join('/desktop', LINUX_X64_NODE_PTY_DESTINATION)
    expect(value.read).toHaveBeenCalledOnce()
    expect(value.read).toHaveBeenCalledWith(destination)
    expect(value.copy).not.toHaveBeenCalled()
    expect(value.mkdir).not.toHaveBeenCalled()
    expect(value.chmod).toHaveBeenCalledWith(destination, 0o755)
  })

  it('stages the built addon when the loader prebuild is absent', () => {
    const source = join('/desktop', LINUX_X64_NODE_PTY_SOURCE)
    const destination = join('/desktop', LINUX_X64_NODE_PTY_DESTINATION)
    const value = options(path => {
      if (path === destination) throw new Error('missing prebuild')
      return addon()
    })

    prepareLinuxNativeRuntime(value)

    expect(value.read).toHaveBeenNthCalledWith(1, destination)
    expect(value.read).toHaveBeenNthCalledWith(2, source)
    expect(value.copy).toHaveBeenCalledWith(source, destination)
    expect(value.mkdir).toHaveBeenCalledWith(join('/desktop', 'node_modules/node-pty/prebuilds/linux-x64'))
    expect(value.chmod).toHaveBeenCalledWith(destination, 0o755)
  })

  it.each([
    [addon(183), 'not a little-endian x86-64 ELF file'],
    [addon(62, false), 'does not expose the stable Node-API entrypoint'],
  ])('rejects an incompatible addon before copying it', (content, message) => {
    const value = options(() => content)

    expect(() => prepareLinuxNativeRuntime(value)).toThrow(message)
    expect(value.copy).not.toHaveBeenCalled()
    expect(value.chmod).not.toHaveBeenCalled()
  })

  it('fails when neither the loader prebuild nor build output exists', () => {
    const value = options(() => {
      throw new Error('missing addon')
    })

    expect(() => prepareLinuxNativeRuntime(value)).toThrow(
      'addon is unavailable at both loader and build paths',
    )
    expect(value.read).toHaveBeenCalledTimes(2)
    expect(value.copy).not.toHaveBeenCalled()
    expect(value.chmod).not.toHaveBeenCalled()
  })
})
