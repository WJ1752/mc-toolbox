// Java 运行时发现与选择。
//
// 除了 PATH / JAVA_HOME / 常见 JDK 目录，还扫描官方启动器的 .minecraft/runtime、
// PrismLauncher 的 java 目录和工具箱自己下载的 Java。所有候选都会真实执行
// `java -version` 校验 64 位与大版本，绝不只凭目录名猜测。
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { RUNTIME_DIR } from '../paths.js'
import { probeJava } from '../server-launch.js'
import { javaCompatible } from './launch-plan.js'

const CACHE_MS = 60 * 1000
let cache = { at: 0, items: [] }
let scanning = null

function executableName() {
  return process.platform === 'win32' ? 'java.exe' : 'java'
}

function candidateRoots() {
  const exe = executableName()
  const roots = new Set()
  if (process.env.JAVA_HOME) roots.add(path.join(process.env.JAVA_HOME, 'bin', exe))
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (dir) roots.add(path.join(dir.replace(/^"|"$/g, ''), exe))
  }
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  const programFiles = process.env.ProgramFiles || 'C:/Program Files'
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)'

  const dirs = [
    path.join(programFiles, 'Java'),
    path.join(programFiles, 'Eclipse Adoptium'),
    path.join(programFiles, 'Microsoft'),
    path.join(programFiles, 'Zulu'),
    path.join(programFiles, 'Amazon Corretto'),
    path.join(programFiles, 'BellSoft'),
    path.join(programFiles, 'OpenJDK'),
    path.join(programFiles, 'AdoptOpenJDK'),
    path.join(programFilesX86, 'Java'),
    path.join(localAppData, 'Programs', 'Eclipse Adoptium'),
    path.join(os.homedir(), '.jdks'),
    path.join(os.homedir(), '.gradle', 'jdks'),
    path.join(RUNTIME_DIR, 'java'),
    path.join(appData, '.minecraft', 'runtime'),
    path.join(appData, 'PrismLauncher', 'java'),
    path.join(appData, '.hmcl', 'java'),
    path.join(appData, '.hmcl', 'javas'),
    path.join(appData, '.hmcl', 'runtime'),
    path.join(appData, 'PCL', 'Java'),
    path.join(appData, 'PCL2', 'Java')
  ]
  for (const dir of dirs) roots.add(dir)
  return [...roots]
}

async function scanRoot(root, depth, maxDepth, found, seen) {
  let stat
  try { stat = await fs.stat(root) } catch { return }
  if (stat.isFile()) {
    if (path.basename(root).toLowerCase() === executableName()) found.push(root)
    return
  }
  if (!stat.isDirectory() || depth > maxDepth) return
  let entries = []
  try { entries = await fs.readdir(root, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (/^(\.staging-|\.invalid-|\.download-|cache$|logs?$|natives?$)/i.test(entry.name)) continue
    if (seen.has(entry.name.toLowerCase()) && entry.name.toLowerCase() !== 'jdk') {
      // allow duplicates like "jdk-17.0.8" to still be probed once by full path below
    }
    const full = path.join(root, entry.name)
    const bin = path.join(full, 'bin', executableName())
    if (!seen.has(bin.toLowerCase())) {
      seen.add(bin.toLowerCase())
      found.push(bin)
    }
    if (process.platform === 'darwin') {
      const mac = path.join(full, 'Contents', 'Home', 'bin', executableName())
      if (!seen.has(mac.toLowerCase())) { seen.add(mac.toLowerCase()); found.push(mac) }
    }
    await scanRoot(full, depth + 1, maxDepth, found, seen)
  }
}

async function probeAll(candidates) {
  const results = []
  const seen = new Set()
  for (const file of candidates) {
    const key = file.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const stat = await fs.stat(file).catch(() => null)
    if (!stat?.isFile()) continue
    const info = await probeJava(file)
    if (!info || info.bits !== 64) continue
    if (results.some((item) => item.path.toLowerCase() === info.path.toLowerCase())) continue
    results.push(info)
  }
  return results.sort((a, b) => b.major - a.major || a.path.localeCompare(b.path))
}

export async function discoverJava({ force = false } = {}) {
  if (!force && cache.items.length && Date.now() - cache.at < CACHE_MS) return cache.items
  if (scanning) return scanning
  scanning = (async () => {
    const found = []
    const seen = new Set()
    for (const root of candidateRoots()) await scanRoot(root, 0, 3, found, seen)
    const items = await probeAll(found)
    cache = { at: Date.now(), items }
    return items
  })()
  try { return await scanning } finally { scanning = null }
}

/**
 * Pick a Java for the requested major version.
 * Returns the preferred path only when it truly matches; otherwise falls back
 * to the best discovered runtime so the UI can explain what will be used.
 */
export async function pickJava({ required = 0, preferred = '', force = false, preferHighest = false } = {}) {
  const req = Number(required) || 0
  if (preferred) {
    const info = await probeJava(preferred).catch(() => null)
    if (info && info.bits === 64 && (!req || javaCompatible(req, info.major))) return { ...info, requested: true }
  }
  const items = await discoverJava({ force })
  const compatible = items.filter((item) => !req || javaCompatible(req, item.major))
  if (!compatible.length) return null
  const exact = compatible.find((item) => item.major === req)
  if (preferHighest) {
    return [...compatible].sort((a, b) => b.major - a.major || a.path.localeCompare(b.path))[0]
  }
  // Prefer the smallest major >= required to avoid running old packs on Java 25.
  const sorted = [...compatible].sort((a, b) => {
    if (req) {
      const da = a.major >= req ? a.major - req : 999 + req - a.major
      const db = b.major >= req ? b.major - req : 999 + req - b.major
      if (da !== db) return da - db
    }
    return b.major - a.major || a.path.localeCompare(b.path)
  })
  return exact || sorted[0] || null
}

export async function javaForInstance(instance, { required = 0, force = false } = {}) {
  return pickJava({ required, preferred: instance?.javaPath || '', force })
}

export function clearJavaCache() {
  cache = { at: 0, items: [] }
}
