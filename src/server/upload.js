import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

// 每次只持有当前分块。写入失败或请求中断时，清理由本次请求独占的目录。
export async function receiveUpload(req, filename, { parent, maxBytes, limitMessage }) {
  if (Number(req.headers?.['content-length']) > maxBytes) throw new Error(limitMessage)
  const prefix = parent ? '.mtb-upload-' : 'mc-toolbox-upload-'
  const dir = await fsp.mkdtemp(path.join(parent || os.tmpdir(), prefix))
  const file = path.join(dir, filename)
  let size = 0
  try {
    const handle = await fsp.open(file, 'wx')
    try {
      for await (const chunk of req) {
        size += chunk.length
        if (size > maxBytes) throw new Error(limitMessage)
        await handle.writeFile(chunk)
      }
      if (!size || req.aborted) throw new Error('上传中止或文件为空')
    } finally {
      await handle.close()
    }
    return { dir, file, size }
  } catch (error) {
    await removeTempPack(dir)
    throw error
  }
}

export async function removeTempPack(dir) {
  await fsp.rm(dir, { recursive: true, force: true }).catch(() => {})
}
