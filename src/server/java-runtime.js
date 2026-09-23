import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { RUNTIME_DIR } from './paths.js'
import { httpFetch } from './http.js'
import { downloadVerified } from './verified-download.js'
import { probeJava } from './server-launch.js'

const supported = new Set([8, 16, 17, 21, 25])
const finished = new Set(['done', 'failed', 'cancelled'])

// Only verified runtimes are published. Inject dependencies for offline failure tests.
export function createJavaRuntimeManager({ root = path.join(RUNTIME_DIR, 'java'), fetcher = httpFetch, download = downloadVerified, probe = probeJava,
  platform = process.platform, arch = process.arch, extract = async (...args) => (await import('./pack-converter.js')).extractZip(...args) } = {}) {
  const jobs = new Map()
  const executable = platform === 'win32' ? 'java.exe' : 'java'
  const findJava = async (dir, depth = 0) => {
    if (depth > 4) return null
    for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) { const hit = await findJava(full, depth + 1); if (hit) return hit }
      else if (e.isFile() && e.name === executable && path.basename(dir) === 'bin') return full
    }
    return null
  }
  const inspect = async (dir, major) => {
    const file = await findJava(dir)
    const result = file && await probe(file)
    return result?.major === major && result.bits === 64 ? result : null
  }
  async function list() {
    const out = []
    for (const e of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (!e.isDirectory() || !/^\d+$/.test(e.name)) continue
      const result = await inspect(path.join(root, e.name), Number(e.name))
      if (result) out.push(result)
    }
    return out.sort((a, b) => a.major - b.major)
  }
  function get(id) { const job = jobs.get(id); if (!job) return null; const { controller, ...publicJob } = job; return publicJob }
  function cancel(id) {
    const job = jobs.get(id)
    if (!job || finished.has(job.status) || job.status === 'publishing') return false
    job.status = 'cancelling'; job.detail = '正在中止并清理临时文件…'; job.controller.abort(); return true
  }
  async function start(major) {
    major = Number(major)
    if (!supported.has(major)) throw new Error('支持下载 Java 8、16、17、21、25')
    if (platform !== 'win32' || !['x64', 'arm64'].includes(arch)) throw new Error('内置下载目前支持 Windows 64 位 / ARM64；其他系统请安装 Java 后选择其路径。')
    const active = [...jobs.values()].find(j => j.major === major && !finished.has(j.status))
    if (active) return get(active.id)
    for (const [id, j] of jobs) if (jobs.size >= 30 && finished.has(j.status)) jobs.delete(id)
    const id = crypto.randomUUID()
    const job = { id, major, status: 'queued', progress: 0, detail: '检查已安装的 Java…', path: '', error: null, controller: new AbortController() }
    jobs.set(id, job)
    setImmediate(async () => {
      const signal = job.controller.signal
      const staging = path.join(root, '.staging-' + id), zip = path.join(root, '.download-' + id + '.zip')
      try {
        signal.throwIfAborted()
        const existing = await inspect(path.join(root, String(major)), major)
        signal.throwIfAborted()
        if (existing) { job.path = existing.path; job.status = 'done'; job.progress = 100; job.detail = `Java ${major} 已就绪`; return }
        job.status = 'running'; job.progress = null; job.detail = '正在查询 Eclipse Temurin 官方下载…'
        const api = `https://api.adoptium.net/v3/assets/latest/${major}/hotspot?architecture=${arch === 'arm64' ? 'aarch64' : 'x64'}&image_type=jdk&os=windows&vendor=eclipse`
        const response = await fetcher(api, { signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]) })
        if (!response.ok) throw new Error(`Java 版本查询失败：HTTP ${response.status}`)
        const pkg = (await response.json())?.[0]?.binary?.package
        if (!pkg?.link || !/^https:\/\//.test(pkg.link) || !/\.zip$/i.test(pkg.name || '') || !/^[a-f0-9]{64}$/i.test(pkg.checksum || '') || !(pkg.size > 0)) throw new Error('官方未提供可校验的 Windows Java 下载包')
        await download(pkg.link, zip, { signal, size: pkg.size, hash: pkg.checksum, maxBytes: 512 * 1024 ** 2,
          onProgress: ({ received, total }) => {
            job.progress = total ? received / total * 70 : null
            job.detail = `下载 Java ${major}：${(received / 1024 ** 2).toFixed(1)} / ${(total / 1024 ** 2).toFixed(1)} MB`
          } })
        await fs.mkdir(staging, { recursive: true })
        job.progress = 70; job.detail = '下载校验通过，正在解压…'
        await extract(zip, staging, p => { job.progress = 70 + p * 28; job.detail = `解压 Java ${major}：${Math.floor(p * 100)}%` }, signal)
        signal.throwIfAborted()
        job.progress = 99; job.detail = '正在运行 Java，检查版本及 64 位支持…'
        const result = await inspect(staging, major)
        if (!result) throw new Error(`Java ${major} 运行校验失败；未添加到可用 Java 列表`)
        signal.throwIfAborted()
        job.status = 'publishing'
        const target = path.join(root, String(major))
        if (await fs.stat(target).catch(() => null)) await fs.rename(target, path.join(root, '.invalid-' + id))
        await fs.rename(staging, target)
        job.path = path.join(target, path.relative(staging, result.path))
        job.progress = 100; job.status = 'done'; job.detail = `Java ${result.version}（64 位）已就绪`
      } catch (e) {
        job.status = signal.aborted ? 'cancelled' : 'failed'
        job.error = signal.aborted ? null : e.message; job.detail = job.error || '已取消 Java 下载'
      } finally {
        await fs.rm(staging, { force: true, recursive: true }).catch(() => {})
        await fs.rm(zip, { force: true }).catch(() => {})
        job.controller = null
      }
    })
    return get(id)
  }
  return { list, get, start, cancel }
}
const manager = createJavaRuntimeManager()
export const listBundledJava = manager.list
export const getJavaJob = manager.get
export const startJavaDownload = manager.start
export const cancelJavaJob = manager.cancel
