import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveDownload } from '../src/server/servercore.js'

// maven.neoforged.net / maven.minecraftforge.net 在国内经常整段不可达，
// 所以服务端安装器必须同时给出 BMCLAPI 同路径镜像，由下载器按顺序回退。
test('NeoForge 服务端安装器：1.20.1 走 net.neoforged:forge 并带镜像', async () => {
  const info = await resolveDownload({ loader: 'neoforge', mc: '1.20.1', loaderVersion: '47.1.106' })
  assert.match(
    info.url,
    /^https:\/\/maven\.neoforged\.net\/releases\/net\/neoforged\/forge\/1\.20\.1-47\.1\.106\/forge-1\.20\.1-47\.1\.106-installer\.jar$/
  )
  assert.equal(info.filename, 'forge-1.20.1-47.1.106-installer.jar')
  assert.ok(
    info.mirrors?.some((url) => url.startsWith('https://bmclapi2.bangbang93.com/maven/net/neoforged/forge/')),
    '缺少 BMCLAPI 镜像'
  )
})

test('NeoForge 服务端安装器：1.21.1 走 net.neoforged:neoforge 并带镜像', async () => {
  const info = await resolveDownload({ loader: 'neoforge', mc: '1.21.1', loaderVersion: '21.1.264' })
  assert.match(info.url, /\/net\/neoforged\/neoforge\/21\.1\.264\/neoforge-21\.1\.264-installer\.jar$/)
  assert.equal(info.filename, 'neoforge-21.1.264-installer.jar')
  assert.equal(info.mirrors?.length, 1)
})

test('Forge 服务端安装器同样提供 BMCLAPI 镜像', async () => {
  const info = await resolveDownload({ loader: 'forge', mc: '1.20.1', loaderVersion: '47.2.0' })
  assert.equal(info.filename, 'forge-1.20.1-47.2.0-installer.jar')
  assert.match(info.mirrors?.[0] || '', /\/maven\/net\/minecraftforge\/forge\/1\.20\.1-47\.2\.0\/forge-1\.20\.1-47\.2\.0-installer\.jar$/)
})
