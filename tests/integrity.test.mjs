import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { collectShellHashes, sha256, verifyShellIntegrity } from '../src/server/integrity.js'

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-integrity-test-'))
try {
  await fs.mkdir(path.join(root, 'css'))
  await fs.mkdir(path.join(root, 'js'))
  await fs.writeFile(path.join(root, 'index.html'), '<div>Rinkore28</div>')
  await fs.writeFile(path.join(root, 'css/style.css'), '.watermark { opacity: .34 }')
  const manifest = { authorHash: sha256('Rinkore28'), files: await collectShellHashes(root) }
  await verifyShellIntegrity(root, manifest, 'Rinkore28')
  await assert.rejects(verifyShellIntegrity(root, manifest, 'SomeoneElse'), /作者标识/)
  await assert.rejects(verifyShellIntegrity(root, null, 'Rinkore28'), /作者标识/)
  await fs.writeFile(path.join(root, 'index.html'), '<div></div>')
  await assert.rejects(verifyShellIntegrity(root, manifest, 'Rinkore28'), /index.html/)
  await fs.writeFile(path.join(root, 'index.html'), '<div>Rinkore28</div>')
  await fs.writeFile(path.join(root, 'css/style.css'), '.watermark { display: none }')
  await assert.rejects(verifyShellIntegrity(root, manifest, 'Rinkore28'), /style.css/)
  await fs.unlink(path.join(root, 'css/style.css'))
  await assert.rejects(verifyShellIntegrity(root, manifest, 'Rinkore28'), /style.css/)
  await fs.writeFile(path.join(root, 'css/style.css'), '.watermark { opacity: .34 }')
  await fs.mkdir(path.join(root, 'features'))
  await fs.writeFile(path.join(root, 'features/custom.js'), '// user plugin')
  await verifyShellIntegrity(root, manifest, 'Rinkore28')
  console.log('✓ 原始资源通过；作者更改、水印删除、样式篡改、文件丢失均拒绝；自定义插件不受影响')
} finally {
  await fs.rm(root, { recursive: true, force: true })
}
