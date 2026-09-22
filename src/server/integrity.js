import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'

export const sha256 = (data) => createHash('sha256').update(data).digest('hex')

// Only the application shell is sealed. Feature modules remain removable/extendable.
export async function collectShellHashes(root) {
  const files = {}
  async function walk(relative) {
    const full = path.join(root, relative)
    const stat = await fs.lstat(full)
    if (stat.isSymbolicLink()) throw new Error('应用资源不能是符号链接：' + relative)
    if (stat.isDirectory()) {
      for (const name of (await fs.readdir(full)).sort()) await walk(`${relative}/${name}`)
    } else files[relative] = sha256(await fs.readFile(full))
  }
  for (const relative of ['index.html', 'css', 'js']) await walk(relative)
  return files
}

export async function verifyShellIntegrity(root, manifest, author) {
  if (!manifest || manifest.authorHash !== sha256(author) || !Object.keys(manifest.files || {}).length) {
    throw new Error('发布版作者标识或完整性清单无效，请重新下载完整的官方版本。')
  }
  for (const [relative, expected] of Object.entries(manifest.files)) {
    try {
      const file = path.join(root, relative)
      if ((await fs.lstat(file)).isSymbolicLink() || sha256(await fs.readFile(file)) !== expected) throw new Error('mismatch')
    } catch {
      throw new Error(`应用资源被修改、删除或损坏：${relative}。已停止启动；请从官方仓库重新下载，关闭工具箱后清除 runtime/public 缓存再重试。`)
    }
  }
}
