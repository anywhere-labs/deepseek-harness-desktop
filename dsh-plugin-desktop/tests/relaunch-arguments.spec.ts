import { spawn as spawnProcess, type SpawnOptions } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DESKTOP_WORKSPACE_ARGUMENT } from '../src/launch-workspace-path.ts'
import {
  DESKTOP_RECOVERY_MODE_ARGUMENT,
  DESKTOP_APPIMAGE_RELAUNCH_SCRIPT,
  DESKTOP_SAFE_MODE_ARGUMENT,
  type DesktopRelaunchSpawn,
  desktopAppImagePath,
  desktopAppImageExtractingRuntimePid,
  desktopAppImageRelaunchEnvironment,
  desktopDefaultRelaunchArguments,
  desktopRecoveryModeRequested,
  desktopRecoveryRelaunchArguments,
  desktopSafeModeRelaunchArguments,
  desktopSafeModeRequested,
  relaunchDesktopApp,
} from '../src/relaunch-arguments.ts'

describe('Desktop relaunch arguments', () => {
  const argv = [
    '/Applications/DSH Desktop.app/Contents/MacOS/DSH Desktop',
    'desktop-main.cjs',
    '--profile=work',
    DESKTOP_RECOVERY_MODE_ARGUMENT,
    DESKTOP_SAFE_MODE_ARGUMENT,
  ]

  it('strips one-shot markers, including Safe Mode, from an ordinary relaunch', () => {
    expect(desktopDefaultRelaunchArguments(argv)).toEqual(['desktop-main.cjs', '--profile=work'])
  })

  it('adds exactly one recovery marker for a recovery relaunch', () => {
    expect(desktopRecoveryRelaunchArguments(argv)).toEqual([
      'desktop-main.cjs', '--profile=work', DESKTOP_RECOVERY_MODE_ARGUMENT,
    ])
  })

  it('never carries a one-shot launch folder into any relaunch shape', () => {
    const folder = resolve('work')
    const launched = [argv[0]!, 'desktop-main.cjs', DESKTOP_WORKSPACE_ARGUMENT, folder, '--profile=work']
    expect(desktopDefaultRelaunchArguments(launched)).toEqual(['desktop-main.cjs', '--profile=work'])
    expect(desktopRecoveryRelaunchArguments(launched)).toEqual([
      'desktop-main.cjs', '--profile=work', DESKTOP_RECOVERY_MODE_ARGUMENT,
    ])
    expect(desktopSafeModeRelaunchArguments(launched)).toEqual([
      'desktop-main.cjs', '--profile=work', DESKTOP_SAFE_MODE_ARGUMENT,
    ])
    expect(desktopDefaultRelaunchArguments([argv[0]!, 'desktop-main.cjs', folder]))
      .toEqual(['desktop-main.cjs'])
  })

  it('recognizes only an exact process argument', () => {
    expect(desktopRecoveryModeRequested(argv)).toBe(true)
    expect(desktopRecoveryModeRequested([argv[0]!, `${DESKTOP_RECOVERY_MODE_ARGUMENT}=true`])).toBe(false)
  })

  it('uses a mutually exclusive Safe Mode marker', () => {
    expect(desktopSafeModeRelaunchArguments(argv)).toEqual([
      'desktop-main.cjs', '--profile=work', DESKTOP_SAFE_MODE_ARGUMENT,
    ])
    expect(desktopSafeModeRequested(argv)).toBe(true)
    expect(desktopSafeModeRequested([argv[0]!, `${DESKTOP_SAFE_MODE_ARGUMENT}=true`])).toBe(false)
  })
  describe('AppImage relaunch', () => {
    const appImage = '/home/user/Apps/DSH-Desktop.AppImage'

    function recorder() {
      const relaunches: Array<{ args?: string[] } | undefined> = []
      const spawns: Array<{ command: string, args: readonly string[], options: SpawnOptions }> = []
      const unref = vi.fn()
      const on = vi.fn()
      const spawn: DesktopRelaunchSpawn = (command, args, options) => {
        spawns.push({ command, args, options })
        return { on, unref } as unknown as ReturnType<DesktopRelaunchSpawn>
      }
      return { app: { relaunch: (options?: { args?: string[] }) => { relaunches.push(options) } }, relaunches, spawns, spawn, on, unref }
    }

    it('only resolves APPIMAGE on Linux', () => {
      expect(desktopAppImagePath({ APPIMAGE: appImage }, 'linux')).toBe(appImage)
      expect(desktopAppImagePath({ APPIMAGE: '' }, 'linux')).toBeUndefined()
      expect(desktopAppImagePath({}, 'linux')).toBeUndefined()
      expect(desktopAppImagePath({ APPIMAGE: appImage }, 'win32')).toBeUndefined()
      expect(desktopAppImagePath({ APPIMAGE: appImage }, 'darwin')).toBeUndefined()
    })

    it('keeps using Electron relaunch outside an AppImage', () => {
      const run = recorder()
      relaunchDesktopApp(run.app, ['--profile=work'], { appImage: undefined, spawn: run.spawn })
      relaunchDesktopApp(run.app, undefined, { appImage: undefined, spawn: run.spawn })
      expect(run.relaunches).toEqual([{ args: ['--profile=work'] }, undefined])
      expect(run.spawns).toEqual([])
    })

    it('hands an AppImage relaunch to a detached shell that waits for this process', () => {
      const run = recorder()
      const env = { APPDIR: '/tmp/.mount_DSH-abc', HOME: '/home/user' }
      relaunchDesktopApp(run.app, ['--profile=work'], { appImage, env, pid: 4242, runtimePid: undefined, spawn: run.spawn })
      expect(run.relaunches).toEqual([])
      expect(run.spawns).toEqual([{
        command: '/usr/bin/env',
        args: ['bash', '-c', DESKTOP_APPIMAGE_RELAUNCH_SCRIPT, '4242', appImage, '--profile=work'],
        options: { detached: true, stdio: 'ignore', env },
      }])
      expect(run.on).toHaveBeenCalledWith('error', expect.any(Function))
      expect(run.unref).toHaveBeenCalledOnce()
    })

    it('carries the current command line when a bare relaunch targets the AppImage', () => {
      const run = recorder()
      const mounted = ['/tmp/.mount_DSH-abc/dsh-desktop', '--profile=work', DESKTOP_SAFE_MODE_ARGUMENT]
      relaunchDesktopApp(run.app, undefined, { appImage, argv: mounted, env: {}, pid: 7, runtimePid: undefined, spawn: run.spawn })
      expect(run.spawns[0]?.args.slice(4)).toEqual([appImage, '--profile=work', DESKTOP_SAFE_MODE_ARGUMENT])
    })

    it('waits for an extracting runtime and restarts extracted', () => {
      const run = recorder()
      const env = { APPDIR: '/tmp/appimage_extracted_0123abcd', HOME: '/home/user' }
      relaunchDesktopApp(run.app, ['--profile=work'], { appImage, env, pid: 4242, runtimePid: 4241, spawn: run.spawn })
      expect(run.spawns[0]?.args.slice(3)).toEqual(['4242 4241', appImage, '--profile=work'])
      expect(run.spawns[0]?.options.env).toEqual({ ...env, APPIMAGE_EXTRACT_AND_RUN: '1' })
      expect(env).toEqual({ APPDIR: '/tmp/appimage_extracted_0123abcd', HOME: '/home/user' })
    })

    it('recognizes only the AppImage file itself as an extracting runtime parent', () => {
      const exes: Record<string, string> = { '/proc/10/exe': appImage, '/proc/20/exe': '/usr/bin/bash', [appImage]: appImage }
      const resolve = (path: string) => {
        const target = exes[path]
        if (target === undefined) throw new Error(`ENOENT: ${path}`)
        return target
      }
      expect(desktopAppImageExtractingRuntimePid(appImage, 10, resolve)).toBe(10)
      expect(desktopAppImageExtractingRuntimePid(appImage, 20, resolve)).toBeUndefined()
      expect(desktopAppImageExtractingRuntimePid(appImage, 30, resolve)).toBeUndefined()
    })

    it('drops only this mount from the search paths AppRun extended', () => {
      const appDir = '/tmp/.mount_DSH-abc'
      expect(desktopAppImageRelaunchEnvironment({
        APPDIR: appDir,
        APPIMAGE: appImage,
        PATH: `${appDir}:${appDir}/usr/sbin:/usr/local/bin:/usr/bin:/tmp/.mount_DSH-abcdef/bin`,
        LD_LIBRARY_PATH: `${appDir}/usr/lib`,
        XDG_DATA_DIRS: `${appDir}/usr/share/:/usr/share/gnome:/usr/share/`,
        GSETTINGS_SCHEMA_DIR: `${appDir}/usr/share/glib-2.0/schemas:/opt/schemas`,
        HOME: '/home/user',
      })).toEqual({
        APPDIR: appDir,
        APPIMAGE: appImage,
        PATH: '/usr/local/bin:/usr/bin:/tmp/.mount_DSH-abcdef/bin',
        XDG_DATA_DIRS: '/usr/share/gnome:/usr/share/',
        GSETTINGS_SCHEMA_DIR: '/opt/schemas',
        HOME: '/home/user',
      })
      const withoutAppDir = { PATH: '/usr/bin' }
      expect(desktopAppImageRelaunchEnvironment(withoutAppDir)).toEqual(withoutAppDir)
    })

    it.skipIf(process.platform === 'win32')('closes inherited descriptors and starts only after every listed process exits', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'dsh-relaunch-'))
      try {
        const marker = join(dir, 'started')
        const hold = (ms: number) => {
          const holder = spawnProcess(process.execPath, ['-e', `setTimeout(() => {}, ${ms})`], { stdio: 'ignore' })
          return { pid: holder.pid, exited: new Promise(done => holder.once('exit', done)) }
        }
        const short = hold(200)
        const long = hold(900)
        const target = 'if [ -e /proc/self/fd/3 ]; then state=leaked; else state=closed; fi; echo "$state $*" > "$0"'
        const waiter = spawnProcess('/usr/bin/env', ['bash', '-c', DESKTOP_APPIMAGE_RELAUNCH_SCRIPT, `${short.pid} ${long.pid}`,
          'bash', '-c', target, marker, 'a b', '--c'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe'] })
        const waiterExited = new Promise(done => waiter.once('exit', done))
        await short.exited
        await new Promise(done => setTimeout(done, 300))
        expect(existsSync(marker)).toBe(false)
        await long.exited
        await waiterExited
        expect(readFileSync(marker, 'utf8')).toBe('closed a b --c\n')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })
  })
})
