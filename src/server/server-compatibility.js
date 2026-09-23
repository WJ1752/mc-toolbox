import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { readJarEntries } from './zip.js'

const elementalClass = 'com/fullskele/elementalend/ElementalEnd.class'
const verifiedElementalClasses = new Set([
  '1907ade1cfa5c687644ed921d6e177889874b7b34c01ac5390a23212cd0ec260',
  '87c6a7c8253c50f15e7d1f094789bc81ef1f33eab12b19164b2bfdc67e05e1b0'
])
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex')

export function serverRemovalReason(mod, runtime) {
  if (runtime.loader === 'cleanroom' && /^0\.6\./.test(runtime.loaderVersion || '') && mod.modid === 'dsurround' && mod.version === '3.6.1.0') {
    return 'Dynamic Surroundings 3.6.1.0 在 Cleanroom 0.6 停服时崩溃；服务端可选的环境效果模组，客户端保留'
  }
  return ''
}

export function clientTooltipScript(text) {
  if (/^\s*#sideonly\b/m.test(text)) return false
  const lines = text.replace(/\/\*[\s\S]*?\*\//g, '').split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('//'))
  const value = '(?:"(?:\\\\.|[^"\\\\])*"|game\\.localize\\("(?:\\\\.|[^"\\\\])*"\\))'
  const call = new RegExp('^(?:tieredtooltips\\.colorStage|ItemStages\\.stageTooltip)\\(\\s*' + value + '(?:\\s*,\\s*' + value + ')*\\s*\\);$')
  return lines.some(l => l.startsWith('tieredtooltips.colorStage(')) && lines.every(l => call.test(l) || /^import mods\.(?:tieredtooltips|ItemStages);$/.test(l) || /^#priority\s+-?\d+$/.test(l))
}

// Elemental End 1.0.0 has a SidedProxy pointing at a nonexistent ServerProxy.
// Its existing CommonProxy has empty lifecycle methods and is the dedicated
// server implementation. Only these inspected bytecodes may be amended;
// never remove the gameplay mod or guess a replacement for an unknown build.
export async function applyServerCompatibility(root, mods, removed, signal) {
  const changes = []
  const patchDir = path.join(root, 'bansoukou')
  for (const file of removed) {
    const patch = path.join(patchDir, path.basename(file))
    if ((await fs.stat(patch).catch(() => null))?.isFile()) {
      await fs.unlink(patch)
      changes.push({ file: path.relative(root, patch), action: '移除已剔除客户端模组的 Bansoukou 补丁，防止补丁重新注入客户端代码' })
    }
  }
  for (const mod of mods) {
    if (removed.has(mod.path) || !mod.modids?.includes('elementalend')) continue
    for (const archive of [mod.path, path.join(patchDir, path.basename(mod.path))]) {
      signal?.throwIfAborted()
      if (!(await fs.stat(archive).catch(() => null))?.isFile()) continue
      const bytes = (await readJarEntries(archive, [elementalClass]))[elementalClass]
      if (!bytes) continue
      const oldName = Buffer.from('com.fullskele.elementalend.proxy.ServerProxy')
      const newName = Buffer.from('com.fullskele.elementalend.proxy.CommonProxy')
      const at = bytes.indexOf(oldName)
      if (at < 0) continue
      const before = sha256(bytes)
      if (!verifiedElementalClasses.has(before)) throw new Error(`Elemental End 的 ${path.relative(root, archive)} 仍引用 ServerProxy，但不是已验证的版本。请更新该模组或使用作者的服务端修复；工具箱不会删掉这个玩法模组。`)
      const patched = Buffer.from(bytes)
      newName.copy(patched, at)
      const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-toolbox-modfix-'))
      try {
        const { extractZip, packDirectory } = await import('./pack-converter.js')
        const unpacked = path.join(temp, 'unpacked')
        await extractZip(archive, unpacked, null, signal)
        await fs.writeFile(path.join(unpacked, elementalClass), patched)
        const output = path.join(temp, 'patched.jar')
        await packDirectory(unpacked, output, null, signal)
        signal?.throwIfAborted()
        await fs.copyFile(output, archive)
        changes.push({ file: path.relative(root, archive), action: 'Elemental End 1.0.0：修复缺失的服务端代理引用，保留全部玩法', class: elementalClass, before, after: sha256(patched) })
      } finally { await fs.rm(temp, { recursive: true, force: true }) }
    }
  }
  if (mods.some(m => m.modids?.includes('crafttweaker'))) {
    async function scripts(dir, depth = 0) {
      if (depth > 12) return
      for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        signal?.throwIfAborted()
        const file = path.join(dir, entry.name)
        if (entry.isDirectory()) await scripts(file, depth + 1)
        else if (entry.isFile() && /\.zs$/i.test(entry.name) && (await fs.stat(file)).size < 512 * 1024) {
          const text = await fs.readFile(file, 'utf8')
          if (clientTooltipScript(text)) {
            await fs.writeFile(file, '#sideonly client\n' + text)
            changes.push({ file: path.relative(root, file), action: '仅含界面提示着色的 CraftTweaker 脚本添加 client 侧标记，保留客户端脚本内容' })
          }
        }
      }
    }
    await scripts(path.join(root, 'scripts'))
  }
  return changes
}
