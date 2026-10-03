/** Persist the Next data location outside the selected home so it survives relaunch. */
import { readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { privateDirectory, readPrivateFile } from './private-files.ts'

export function defaultDataDirectory(userHome = homedir()): string { return join(userHome, '.dsh') }

export function readDataDirectory(defaultHome: string, locationRoot = defaultHome): { home: string; error?: string } {
  try {
    const value = JSON.parse(readPrivateFile(join(locationRoot, 'desktop-next-location.json')) ?? 'null') as unknown
    if (value === null) return { home: defaultHome }
    if (typeof value !== 'object' || !('home' in value) || typeof value.home !== 'string' || !isAbsolute(value.home)) throw new Error('Invalid Next data directory')
    privateDirectory(value.home)
    return { home: resolve(value.home) }
  } catch (error) { return { home: defaultHome, error: String(error) } }
}

export function validateDataDirectory(target: string, current: string, defaultHome: string): string {
  if (!isAbsolute(target) || target.includes('\0')) throw new Error('Data directory must be an absolute path')
  const destination = resolve(target)
  const nested = relative(current, destination)
  if (nested && !nested.startsWith('..') && !isAbsolute(nested)) throw new Error('Choose a directory outside the current data directory')
  privateDirectory(destination)
  const entries = readdirSync(destination)
  if (destination !== defaultHome && destination !== current && entries.length > 0
    && readPrivateFile(join(destination, 'desktop-next.json')) === undefined
    && readPrivateFile(join(destination, 'profiles', 'desktop', 'package.json')) === undefined) {
    throw new Error('Choose an empty directory or an existing Next data directory')
  }
  return destination
}
