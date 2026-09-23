import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { RUNTIME_DIR } from './paths.js'

const exec = promisify(execFile)
export function requiredJava(runtime) {
  if (runtime?.cleanroom === true || runtime?.loader === 'cleanroom') return /^0\.[0-5]\./.test(runtime.loaderVersion || '') ? 21 : 25
  const parts = /^1\.(\d+)(?:\.(\d+))?$/.exec(runtime?.mc || '')
  if (!parts) throw new Error('请填写有效的 Minecraft 版本')
  const minor = Number(parts[1]), patch = Number(parts[2] || 0)
  return minor > 20 || (minor === 20 && patch >= 5) ? 21 : minor >= 18 ? 17 : minor === 17 ? 16 : 8
}

export function validateMemory(memory = '4G', minMemory = '1G') {
  const parse = value => {
    const m = /^(\d+)([MG])$/i.exec(String(value))
    if (!m) throw new Error('内存格式无效，请使用整数和 G / M 单位')
    return Number(m[1]) * (m[2].toUpperCase() === 'G' ? 1024 : 1)
  }
  const max = parse(memory), min = parse(minMemory)
  if (min < 256 || max < min || max > 256 * 1024) throw new Error('初始内存不能大于最大内存，范围为 256 MB–256 GB')
  return { memory: String(memory).toUpperCase(), minMemory: String(minMemory).toUpperCase() }
}

export async function probeJava(executable) {
  try {
    const { stdout, stderr } = await exec(executable, ['-XshowSettings:properties', '-version'], { windowsHide: true, timeout: 6000, maxBuffer: 128 * 1024 })
    const output = stdout + stderr
    const version = /(?:java|openjdk) version "([^"]+)"/.exec(output)?.[1] || /java.version\s*=\s*(\S+)/.exec(output)?.[1]
    const major = version?.startsWith('1.') ? Number(version.split('.')[1]) : Number(version?.split(/[.+_-]/)[0])
    if (!major) return null
    return { path: executable, major, version, bits: /sun.arch.data.model\s*=\s*64|64-Bit/i.test(output) ? 64 : 32 }
  } catch { return null }
}

export async function resolveJava(runtime, preferred = '') {
  const required = requiredJava(runtime)
  const executable = process.platform === 'win32' ? 'java.exe' : 'java'
  if (preferred) {
    if (!path.isAbsolute(preferred) || path.basename(preferred).toLowerCase() !== executable) throw new Error('请选择 Java 的 java.exe / java 可执行文件')
    const found = await probeJava(preferred)
    if (!found || found.major !== required || found.bits !== 64) throw new Error(`所选 Java 不兼容：MC ${runtime.mc} 请使用 64 位 Java ${required}`)
    return found
  }
  const candidates = new Set()
  if (process.env.JAVA_HOME) candidates.add(path.join(process.env.JAVA_HOME, 'bin', executable))
  for (const dir of (process.env.PATH || '').split(path.delimiter)) if (dir) candidates.add(path.join(dir.replace(/^"|"$/g, ''), executable))
  const roots = process.platform === 'win32'
    ? [path.join(process.env.ProgramFiles || 'C:/Program Files', 'Java'), path.join(process.env.ProgramFiles || 'C:/Program Files', 'Eclipse Adoptium'), path.join(process.env.ProgramFiles || 'C:/Program Files', 'Microsoft'), path.join(process.env.ProgramFiles || 'C:/Program Files', 'Zulu'), path.join(os.homedir(), '.jdks')]
    : ['/usr/lib/jvm', '/Library/Java/JavaVirtualMachines']
  roots.push(path.join(RUNTIME_DIR, 'java'))
  const addCandidates = async (root, depth = 0, maxDepth = 0) => {
    if (depth > maxDepth) return
    for (const entry of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || entry.name.startsWith('.staging-') || entry.name.startsWith('.invalid-')) continue
      const full = path.join(root, entry.name)
      candidates.add(path.join(full, 'bin', executable))
      if (process.platform === 'darwin') candidates.add(path.join(full, 'Contents/Home/bin', executable))
      await addCandidates(full, depth + 1, maxDepth)
    }
  }
  for (const root of roots) {
    await addCandidates(root, 0, root === path.join(RUNTIME_DIR, 'java') ? 1 : 0)
  }
  for (const candidate of candidates) {
    if (!(await fs.stat(candidate).catch(() => null))?.isFile()) continue
    const found = await probeJava(candidate)
    if (found?.major === required && found.bits === 64) return found
  }
  throw new Error(`未找到兼容的 64 位 Java ${required}（MC ${runtime.mc}）。请安装或使用“选择 Java”指定 java.exe；不能直接使用其他大版本的 Java。`)
}

/**
 * Find every usable 64-bit Java installation that is visible to this process.
 * This is intentionally broader than the bundled-runtime list: users often
 * keep Temurin, Microsoft, Zulu, Oracle or a manually unpacked JDK side by
 * side. The result is for choosing/inspecting; resolveJava remains the final
 * compatibility gate for a concrete Minecraft runtime.
 */
export async function discoverJavaRuntimes() {
  const executable = process.platform === 'win32' ? 'java.exe' : 'java'
  const roots = new Set()
  if (process.env.JAVA_HOME) roots.add(path.join(process.env.JAVA_HOME, 'bin', executable))
  for (const dir of (process.env.PATH || '').split(path.delimiter)) if (dir) roots.add(path.join(dir.replace(/^"|"$/g, ''), executable))
  const baseRoots = process.platform === 'win32'
    ? [
      path.join(process.env.ProgramFiles || 'C:/Program Files', 'Java'),
      path.join(process.env.ProgramFiles || 'C:/Program Files', 'Eclipse Adoptium'),
      path.join(process.env.ProgramFiles || 'C:/Program Files', 'Microsoft'),
      path.join(process.env.ProgramFiles || 'C:/Program Files', 'Zulu'),
      path.join(process.env.ProgramFiles || 'C:/Program Files', 'Amazon Corretto'),
      path.join(process.env.ProgramFiles || 'C:/Program Files', 'BellSoft'),
      path.join(process.env.USERPROFILE || os.homedir(), '.jdks')
    ]
    : ['/usr/lib/jvm', '/Library/Java/JavaVirtualMachines']
  for (const root of baseRoots) roots.add(root)
  roots.add(path.join(RUNTIME_DIR, 'java'))
  const candidates = new Set()
  const scan = async (root, depth, maxDepth) => {
    const stat = await fs.stat(root).catch(() => null)
    if (!stat) return
    if (stat.isFile()) { if (path.basename(root).toLowerCase() === executable) candidates.add(root); return }
    if (depth > maxDepth) return
    for (const entry of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || entry.name.startsWith('.staging-') || entry.name.startsWith('.invalid-')) continue
      const full = path.join(root, entry.name)
      candidates.add(path.join(full, 'bin', executable))
      if (process.platform === 'darwin') candidates.add(path.join(full, 'Contents/Home/bin', executable))
      await scan(full, depth + 1, maxDepth)
    }
  }
  for (const root of roots) await scan(root, 0, root === path.join(RUNTIME_DIR, 'java') ? 3 : 1)
  const found = []
  for (const candidate of candidates) {
    if (!(await fs.stat(candidate).catch(() => null))?.isFile()) continue
    const result = await probeJava(candidate)
    if (!result || result.bits !== 64) continue
    if (!found.some(item => item.path.toLowerCase() === result.path.toLowerCase())) found.push(result)
  }
  return found.sort((a, b) => a.major - b.major || a.path.localeCompare(b.path))
}

export async function bundleJavaRuntime(root, javaPath, signal, onProgress) {
  // Java 8 JDKs often include a smaller, self-contained jre directory.
  let source = path.dirname(path.dirname(await fs.realpath(javaPath)))
  const executable = process.platform === 'win32' ? 'java.exe' : 'java'
  if ((await fs.stat(path.join(source, 'jre', 'bin', executable)).catch(() => null))?.isFile()) source = path.join(source, 'jre')
  const target = path.join(root, 'runtime')
  if (target.startsWith(source + path.sep)) throw new Error('Java 目录不能包含服务端输出目录')
  if ((await fs.stat(target).catch(() => null))) throw new Error('整合包已有 runtime 目录，请移除旧运行时或关闭随包携带 Java 后重试')
  const files = [], visited = new Set()
  async function walk(dir, rel = '') {
    signal?.throwIfAborted()
    const real = await fs.realpath(dir)
    if (visited.has(real)) throw new Error('Java 安装目录包含循环链接，无法打包')
    visited.add(real)
    for (const name of await fs.readdir(dir)) {
      const full = path.join(dir, name), next = path.join(rel, name), stat = await fs.stat(full)
      if (stat.isDirectory()) await walk(full, next)
      else if (stat.isFile()) files.push({ full, rel: next, size: stat.size })
    }
    visited.delete(real)
  }
  await walk(source)
  const total = files.reduce((sum, file) => sum + file.size, 0)
  if (total > 2 * 1024 ** 3) throw new Error('Java 安装目录超过 2 GB，请选择独立 JRE 或关闭随包携带 Java')
  let copied = 0
  for (const file of files) {
    signal?.throwIfAborted()
    const dest = path.join(target, file.rel)
    await fs.mkdir(path.dirname(dest), { recursive: true })
    await fs.copyFile(file.full, dest)
    copied += file.size
    onProgress?.({ copied, total, file: file.rel })
  }
  // Keep the distributor's notices when a nested JRE was used.
  if (path.basename(source).toLowerCase() === 'jre') {
    for (const name of ['LICENSE', 'COPYRIGHT', 'ASSEMBLY_EXCEPTION', 'THIRD_PARTY_README', 'THIRD_PARTY_README.txt']) {
      const notice = path.join(path.dirname(source), name)
      if ((await fs.stat(notice).catch(() => null))?.isFile() && !(await fs.stat(path.join(target, name)).catch(() => null))) await fs.copyFile(notice, path.join(target, name))
    }
  }
  return { path: 'runtime/bin/' + executable, bytes: total, platform: process.platform, arch: process.arch }
}

const windowsLauncher = String.raw`$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
try {
  $config = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'server-launch.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $candidates = New-Object 'System.Collections.Generic.List[string]'
  if ($env:MC_SERVER_JAVA) { $candidates.Add($env:MC_SERVER_JAVA) }
  $candidates.Add((Join-Path $PSScriptRoot 'runtime/bin/java.exe'))
  if ($config.javaPath) { $candidates.Add($config.javaPath) }
  if ($env:JAVA_HOME) { $candidates.Add((Join-Path $env:JAVA_HOME 'bin/java.exe')) }
  foreach ($dir in ($env:PATH -split ';')) { if ($dir) { $candidates.Add((Join-Path $dir.Trim('"') 'java.exe')) } }
  foreach ($root in @("$env:ProgramFiles/Java", "$env:ProgramFiles/Eclipse Adoptium", "$env:ProgramFiles/Microsoft", "$env:ProgramFiles/Zulu", "$env:USERPROFILE/.jdks")) {
    if (Test-Path -LiteralPath $root) { Get-ChildItem -LiteralPath $root -Directory | ForEach-Object { $candidates.Add((Join-Path $_.FullName 'bin/java.exe')) } }
  }
  $java = $null
  foreach ($candidate in ($candidates | Select-Object -Unique)) {
    if (!(Test-Path -LiteralPath $candidate -PathType Leaf -ErrorAction SilentlyContinue)) { continue }
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo.FileName = $candidate
    $process.StartInfo.Arguments = '-XshowSettings:properties -version'
    $process.StartInfo.UseShellExecute = $false
    $process.StartInfo.CreateNoWindow = $true
    $process.StartInfo.RedirectStandardError = $true
    $process.StartInfo.RedirectStandardOutput = $true
    try {
      [void]$process.Start()
      $stderr = $process.StandardError.ReadToEndAsync()
      $stdout = $process.StandardOutput.ReadToEndAsync()
      if (!$process.WaitForExit(6000)) { $process.Kill(); continue }
      $output = $stderr.Result + $stdout.Result
      if ($output -match '(?:java|openjdk) version "([^"]+)"') {
        $version = $Matches[1]
        $major = if ($version.StartsWith('1.')) { [int]($version.Split('.')[1]) } else { [int](($version -split '[.+_-]')[0]) }
        if ($major -eq $config.javaMajor -and $output -match 'sun.arch.data.model\s*=\s*64|64-Bit') { $java = $candidate; break }
      }
    } catch { continue } finally { $process.Dispose() }
  }
  if (!$java) { throw "Java $($config.javaMajor) (64-bit) is required. Install it, set MC_SERVER_JAVA, or edit javaPath in server-launch.json." }
  if ($config.memory -notmatch '^\d+[MG]$' -or $config.minMemory -notmatch '^\d+[MG]$') { throw 'Invalid memory in server-launch.json' }
  $launchArgs = @("-Xms$($config.minMemory)", "-Xmx$($config.memory)") + @($config.args)
  Write-Host "Java: $java"
  Write-Host "Memory: $($config.minMemory) - $($config.memory)"
  if ($env:MC_TOOLBOX_LAUNCH_CHECK -eq '1') { Write-Host ($launchArgs -join ' '); exit 0 }
  & $java @launchArgs
  exit $LASTEXITCODE
} catch { Write-Host $_.Exception.Message -ForegroundColor Red; exit 1 }
`

export async function writeLaunchFiles(root, runtime, args, { memory = '4G', minMemory = '1G', javaPath = '' } = {}) {
  const mem = validateMemory(memory, minMemory)
  const javaMajor = requiredJava(runtime)
  await fs.writeFile(path.join(root, 'server-launch.json'), JSON.stringify({ javaPath, javaMajor, ...mem, args }, null, 2))
  await fs.writeFile(path.join(root, 'start.ps1'), '\uFEFF' + windowsLauncher.replace(/\r?\n/g, '\r\n'))
  await fs.writeFile(path.join(root, 'start.bat'), '@echo off\r\nsetlocal\r\ncd /d "%~dp0"\r\ntitle Minecraft Server\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"\r\npause\r\n')
  const quote = value => "'" + String(value).replace(/'/g, "'\\''") + "'"
  // A Windows path is deliberately not used on Unix; portable packs can use JAVA_HOME or MC_SERVER_JAVA.
  const preferred = process.platform === 'win32' ? '' : javaPath
  const sh = `#!/bin/sh
cd "$(dirname "$0")" || exit 1
JAVA_EXE="\${MC_SERVER_JAVA:-}"
if [ -z "$JAVA_EXE" ] && [ -x ${quote(preferred)} ]; then JAVA_EXE=${quote(preferred)}; fi
if [ -z "$JAVA_EXE" ] && [ -x ./runtime/bin/java ]; then JAVA_EXE=./runtime/bin/java; fi
if [ -z "$JAVA_EXE" ] && [ -n "$JAVA_HOME" ]; then JAVA_EXE="$JAVA_HOME/bin/java"; fi
if [ -z "$JAVA_EXE" ]; then JAVA_EXE=java; fi
DETAILS=$("$JAVA_EXE" -XshowSettings:properties -version 2>&1)
VERSION=$(printf '%s' "$DETAILS" | sed -n 's/.*version "\\([^"]*\\)".*/\\1/p' | head -n 1)
case "$VERSION" in 1.*) MAJOR=$(printf '%s' "$VERSION" | cut -d. -f2);; *) MAJOR=$(printf '%s' "$VERSION" | sed 's/[.+_-].*//');; esac
if [ "$MAJOR" != '${javaMajor}' ] || ! printf '%s' "$DETAILS" | grep -Eq 'sun.arch.data.model[[:space:]]*=[[:space:]]*64|64-Bit'; then
  echo 'Java ${javaMajor} (64-bit) required. Set JAVA_HOME or MC_SERVER_JAVA to a compatible Java.'; exit 1
fi
# Adjust the memory limits here for Unix; Windows uses server-launch.json.
exec "$JAVA_EXE" -Xms${mem.minMemory} -Xmx${mem.memory} ${args.map(quote).join(' ')}
`
  await fs.writeFile(path.join(root, 'start.sh'), sh)
  await fs.chmod(path.join(root, 'start.sh'), 0o755).catch(() => {})
  await fs.writeFile(path.join(root, '启动说明.txt'), `Minecraft ${runtime.mc} / ${runtime.loader} ${runtime.loaderVersion || ''}\n需要 64 位 Java ${javaMajor}。Windows 运行 start.bat；Linux/macOS 运行 start.sh。\n初始内存 ${mem.minMemory}，最大内存 ${mem.memory}。Windows 可编辑 server-launch.json 调整 javaPath / memory / minMemory；Unix 可编辑 start.sh 或设置 MC_SERVER_JAVA。\n移动服务端后，Windows 会重新查找兼容 Java；不会直接使用不兼容的系统默认 Java。若包含 runtime 文件夹，则已携带制作电脑对应系统的 Java；Windows Java 不能在 Linux/macOS 使用。\n首次启动请阅读 Minecraft EULA，并自行确认是否接受。\n复杂整合包仍可能需要作者的服务端专用配置、依赖及模组调整。\n`)
  return { javaMajor, javaPath, ...mem }
}
