/** Fetch the vendored Windows Node executable and its LICENSE for the ACL runner. */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const NODE_VERSION = '22.23.2'
const VENDOR_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'vendor', 'node')
const EXECUTABLE = join(VENDOR_DIR, 'node.exe')
const LICENSE_FILE = join(VENDOR_DIR, 'LICENSE')
// SHA-256 of the extracted node.exe from the official win-x64 zip.
const NODE_EXE_SHA256 = '0d0f5e39f9f3d9587bc19f73eab3c2c9c4903fd02d6dbf9c853dd81b3d95fad4'
const FETCH_TIMEOUT_MS = 120_000

const SOURCES = [
  `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-win-x64.zip`,
  `https://npmmirror.com/mirrors/node/v${NODE_VERSION}/node-v${NODE_VERSION}-win-x64.zip`,
]

function fail(message) {
  console.error(`[vendor-node-win] ${message}`)
  process.exitCode = 1
}

function sha256Of(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

async function fetchZip(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, { redirect: 'follow', signal: controller.signal })
    if (!response.ok || response.body === null) throw new Error(`HTTP ${response.status}`)
    const chunks = []
    for await (const chunk of response.body) chunks.push(Buffer.from(chunk))
    return Buffer.concat(chunks)
  } finally {
    clearTimeout(timer)
  }
}

/** Verify the extractor toolchain before any network work. */
function preflight() {
  try {
    execFileSync('python', ['--version'], { stdio: 'ignore' })
  } catch {
    fail('python is required on PATH to extract the Node zip (unzip via Python zipfile)')
    throw new Error('preflight failed')
  }
}

async function main() {
  if (existsSync(EXECUTABLE) && existsSync(LICENSE_FILE)
    && sha256Of(EXECUTABLE) === NODE_EXE_SHA256) {
    console.log('[vendor-node-win] node.exe already vendored (sha256 ok)')
    return
  }
  preflight()
  mkdirSync(VENDOR_DIR, { recursive: true })

  const zipPath = join(VENDOR_DIR, `node-v${NODE_VERSION}-win-x64.zip`)
  let zipBuffer
  let lastError
  for (const source of SOURCES) {
    try {
      console.log(`[vendor-node-win] downloading ${source}`)
      zipBuffer = await fetchZip(source)
      lastError = undefined
      break
    } catch (cause) {
      lastError = cause
      console.error(`[vendor-node-win] source failed: ${source}: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }
  if (zipBuffer === undefined) {
    fail(`all sources failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
    throw new Error('download failed')
  }
  writeFileSync(zipPath, zipBuffer)

  console.log('[vendor-node-win] extracting node.exe and LICENSE')
  const entry = `node-v${NODE_VERSION}-win-x64/node.exe`
  const licenseEntry = `node-v${NODE_VERSION}-win-x64/LICENSE`
  const extractScript = [
    'import zipfile, sys, pathlib',
    'z = zipfile.ZipFile(sys.argv[1])',
    'out = pathlib.Path(sys.argv[2])',
    'out.parent.mkdir(parents=True, exist_ok=True)',
    'out.write_bytes(z.read(sys.argv[3]))',
    'print("extracted")',
  ].join('; ')
  const extractedExe = join(VENDOR_DIR, 'node-extracted.exe')
  execFileSync('python', ['-c', extractScript, zipPath, extractedExe, entry])
  execFileSync('python', ['-c', extractScript, zipPath, LICENSE_FILE, licenseEntry])
  if (!existsSync(extractedExe) || !existsSync(LICENSE_FILE)) {
    fail('extracted node.exe or LICENSE not found')
    throw new Error('extraction failed')
  }
  renameSync(extractedExe, EXECUTABLE)
  rmSync(zipPath, { force: true })

  const digest = sha256Of(EXECUTABLE)
  if (digest !== NODE_EXE_SHA256) {
    rmSync(EXECUTABLE, { force: true })
    fail(`checksum mismatch: got ${digest}, want ${NODE_EXE_SHA256}`)
    throw new Error('checksum mismatch')
  }
  console.log('[vendor-node-win] vendored node.exe and LICENSE (sha256 ok)')
}

main().catch(error => {
  fail(error instanceof Error ? error.message : String(error))
})
