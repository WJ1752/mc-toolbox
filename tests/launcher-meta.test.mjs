import test from 'node:test'
import assert from 'node:assert/strict'
import { mirrorUrl, candidateUrls, assetObjectUrls, customVersionId, forgeInstaller } from '../src/server/launcher/meta.js'
import { normalizeAuthServer, validateOfflineName, publicAccount } from '../src/server/launcher/accounts.js'

test('BMCLAPI mirror mapping covers manifest, version JSON, assets and libraries', () => {
  assert.equal(
    mirrorUrl('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'),
    'https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json'
  )
  assert.equal(
    mirrorUrl('https://piston-meta.mojang.com/v1/packages/abc/1.20.1.json'),
    'https://bmclapi2.bangbang93.com/v1/packages/abc/1.20.1.json'
  )
  const hash = '0123456789abcdef0123456789abcdef01234567'
  // piston-data 对象按 /v1/objects/<hash>/<文件名> 镜像；没有文件名的对象无法镜像。
  assert.equal(mirrorUrl(`https://piston-data.mojang.com/v1/objects/${hash}`), '')
  assert.equal(
    mirrorUrl(`https://piston-data.mojang.com/v1/objects/${hash}/client.jar`),
    `https://bmclapi2.bangbang93.com/v1/objects/${hash}/client.jar`
  )
  assert.equal(
    mirrorUrl(`https://piston-data.mojang.com/v1/objects/${hash}/client.txt`),
    `https://bmclapi2.bangbang93.com/v1/objects/${hash}/client.txt`
  )
  assert.equal(mirrorUrl(`https://resources.download.minecraft.net/01/${hash}`), `https://bmclapi2.bangbang93.com/assets/01/${hash}`)
  assert.equal(
    mirrorUrl('https://libraries.minecraft.net/com/mojang/brigadier/1.3.10/brigadier-1.3.10.jar'),
    'https://bmclapi2.bangbang93.com/maven/com/mojang/brigadier/1.3.10/brigadier-1.3.10.jar'
  )
  assert.equal(
    mirrorUrl('https://maven.neoforged.net/releases/net/neoforged/fancymodloader/loader/47.2.2/loader-47.2.2.jar'),
    'https://bmclapi2.bangbang93.com/maven/net/neoforged/fancymodloader/loader/47.2.2/loader-47.2.2.jar'
  )
  assert.equal(
    mirrorUrl('https://maven.minecraftforge.net/net/minecraftforge/forge/1.20.1-47.4.0/forge-1.20.1-47.4.0-installer.jar'),
    'https://bmclapi2.bangbang93.com/maven/net/minecraftforge/forge/1.20.1-47.4.0/forge-1.20.1-47.4.0-installer.jar'
  )
  assert.equal(mirrorUrl('https://maven.fabricmc.net/foo/bar.jar'), '')
})

test('source selection produces fallback chains', () => {
  const url = 'https://libraries.minecraft.net/foo/bar.jar'
  assert.deepEqual(candidateUrls(url, { source: 'official' }), [url])
  // 即使选定 BMCL 镜像也保留官方地址兜底：单个文件镜像 404 时安装不能整体失败。
  assert.deepEqual(candidateUrls(url, { source: 'bmclapi' }), [
    'https://bmclapi2.bangbang93.com/maven/foo/bar.jar',
    url
  ])
  assert.deepEqual(candidateUrls(url, { source: 'auto' }), [
    'https://bmclapi2.bangbang93.com/maven/foo/bar.jar',
    url
  ])
  assert.deepEqual(assetObjectUrls('zz', { source: 'auto' }), [])
  assert.equal(assetObjectUrls('ab'.repeat(20), { source: 'official' }).length, 1)
})

test('loader ids and installer URLs follow Forge/NeoForge conventions', () => {
  assert.equal(customVersionId('fabric', '1.20.1', '0.16.10'), '1.20.1-fabric-0.16.10')
  assert.equal(customVersionId('quilt', '1.20.1', '0.23.1'), '1.20.1-quilt-0.23.1')
  const forge = forgeInstaller('forge', '1.20.1', '47.4.0')
  assert.match(forge.url, /forge-1\.20\.1-47\.4\.0-installer\.jar$/)
  assert.equal(forge.expectedId, '1.20.1-forge-47.4.0')
  assert.match(forge.mirrorUrl, /bmclapi2\.bangbang93\.com\/maven\/net\/minecraftforge\/forge\//)
  const neo = forgeInstaller('neoforge', '1.20.1', '47.1.106')
  assert.match(neo.url, /net\/neoforged\/forge\/1\.20\.1-47\.1\.106\/forge-1\.20\.1-47\.1\.106-installer\.jar$/)
  assert.equal(neo.expectedId, '1.20.1-forge-47.1.106')
  assert.match(neo.mirrorUrl, /bmclapi2\.bangbang93\.com\/maven\/net\/neoforged\/forge\//)
  const modernNeo = forgeInstaller('neoforge', '1.21.1', '21.1.80')
  assert.match(modernNeo.url, /net\/neoforged\/neoforge\/21\.1\.80\/neoforge-21\.1\.80-installer\.jar$/)
  assert.equal(modernNeo.expectedId, 'neoforge-21.1.80')
})

test('third-party auth server normalization strips known endpoint suffixes', () => {
  assert.equal(normalizeAuthServer('https://littleskin.cn/api/yggdrasil/'), 'https://littleskin.cn/api/yggdrasil')
  assert.equal(normalizeAuthServer('https://example.com/authserver'), 'https://example.com')
  assert.equal(normalizeAuthServer('https://example.com/sessionserver/'), 'https://example.com')
  assert.throws(() => normalizeAuthServer('not a url'), /合法的 URL/)
})

test('offline player names validate without allowing path/space characters', () => {
  assert.equal(validateOfflineName('Steve_2024'), 'Steve_2024')
  assert.equal(validateOfflineName('史蒂夫玩家'), '史蒂夫玩家')
  assert.throws(() => validateOfflineName('ab'), /3–16/)
  assert.throws(() => validateOfflineName('name with space'), /3–16/)
  assert.throws(() => validateOfflineName('../evil'), /3–16/)
})

test('public account payload never exposes access or refresh tokens', () => {
  const account = {
    id: 'ms_x', type: 'microsoft', name: 'Player', uuid: 'uuid',
    accessToken: 'secret-access-token', refreshToken: 'secret-refresh-token',
    clientToken: 'secret-client-token', clientId: 'client-id', msFlow: 'live',
    skin: 'https://example.invalid/skin.png', cape: '', expiresAt: Date.now() + 3600_000
  }
  const pub = publicAccount(account, 'ms_x')
  const text = JSON.stringify(pub)
  assert.equal(pub.name, 'Player')
  assert.equal(pub.selected, true)
  assert.equal(pub.skin, account.skin)
  assert.equal(pub.needsRefresh, false)
  for (const secret of [account.accessToken, account.refreshToken, account.clientToken]) {
    assert.equal(text.includes(secret), false)
  }
  assert.equal('accessToken' in pub, false)
  assert.equal('refreshToken' in pub, false)
})
