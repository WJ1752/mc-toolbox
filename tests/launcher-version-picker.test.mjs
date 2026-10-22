// 启动器版本选择器纯函数测试：版本格式、兼容判断、分组、筛选文案与徽章。
// 不创建 DOM，只覆盖可测试的纯逻辑。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  isMinecraftVersion,
  compatibleVersion,
  partitionVersions,
  filterSummary,
  versionTagBadges,
  compareVersionsDesc
} from '../public/js/launcher/version-picker.js'

test('isMinecraftVersion: 正式版 / 快照 / 预发布 / 非法实例名', () => {
  for (const value of ['1.20.1', '1.21', '26.3', '1.20.1-pre1', '1.20.1-rc2', '24w14a']) {
    assert.equal(isMinecraftVersion(value), true, value)
  }
  for (const value of ['M1182rebirth', 'Minecraft 1.21', '', null, undefined, '1.20.1-forge-47.4.0', '26.2.1.1']) {
    assert.equal(isMinecraftVersion(value), false, String(value))
  }
})

test('compatibleVersion: MC 与加载器同时匹配；未知 loaders 不误伤', () => {
  const version = { gameVersions: ['1.21.8', '1.21.7'], loaders: ['fabric'] }
  assert.equal(compatibleVersion(version, { mc: '1.21.8', loader: 'fabric', kind: 'mods' }), true)
  assert.equal(compatibleVersion(version, { mc: '1.21.8', loader: 'forge', kind: 'mods' }), false)
  assert.equal(compatibleVersion(version, { mc: '1.20.1', loader: 'fabric', kind: 'mods' }), false)
  // 资源包/光影不检查加载器。
  assert.equal(compatibleVersion(version, { mc: '1.21.8', loader: 'forge', kind: 'shaderpacks' }), true)
  // CurseForge 旧数据没有 loaders：无法判断时按兼容处理。
  assert.equal(compatibleVersion({ gameVersions: ['1.21.8'], loaders: [] }, { mc: '1.21.8', loader: 'forge' }), true)
  // 没有 MC 目标时绝不标记兼容。
  assert.equal(compatibleVersion(version, { mc: '', loader: 'fabric' }), false)
})

test('partitionVersions: 兼容项按时间倒序、推荐项优先正式版', () => {
  const versions = [
    { id: 'a', gameVersions: ['1.21.8'], loaders: ['fabric'], type: 'beta', date: '2025-02-02' },
    { id: 'b', gameVersions: ['1.21.8'], loaders: ['fabric'], type: 'release', date: '2025-01-01' },
    { id: 'c', gameVersions: ['26.2'], loaders: ['fabric'], type: 'release', date: '2025-03-03' },
    { id: 'd', gameVersions: ['1.21.8'], loaders: ['fabric'], type: 'release', date: '2025-01-20' }
  ]
  const result = partitionVersions(versions, { mc: '1.21.8', loader: 'fabric', kind: 'mods' })
  assert.deepEqual(result.compatible.map((item) => item.id), ['a', 'd', 'b'])
  assert.deepEqual(result.others.map((item) => item.id), ['c'])
  // 最新兼容的正式版是 d（不是更新的 beta a）。
  assert.equal(result.recommendedId, 'd')
})

test('filterSummary: 全部 / 指定版本与加载器', () => {
  assert.equal(filterSummary({ mc: '1.21.8', loader: 'fabric', kind: 'mods' }), '筛选：1.21.8 · Fabric')
  assert.equal(filterSummary({ mc: '', loader: 'fabric', kind: 'mods' }), '筛选：全部 MC 版本 · Fabric')
  assert.equal(filterSummary({ mc: '1.21.8', loader: 'fabric', kind: 'shaderpacks' }), '筛选：1.21.8')
  assert.equal(filterSummary({ mc: 'M1182rebirth', loader: '', kind: 'mods' }), '筛选：全部 MC 版本')
})

test('versionTagBadges: 当前实例可用 / 适配 / 推荐', () => {
  const version = { gameVersions: ['1.21.8'], loaders: ['fabric'] }
  const current = versionTagBadges(version, { mc: '1.21.8', loader: 'fabric', current: true, recommended: true })
  assert.ok(current.some((badge) => badge.text === '当前实例可用'))
  assert.ok(current.some((badge) => badge.text === '推荐'))
  const adapted = versionTagBadges(version, { mc: '1.21.8', loader: 'fabric', current: false })
  assert.ok(adapted.some((badge) => badge.text === '适配 1.21.8'))
  assert.ok(!adapted.some((badge) => badge.text === '当前实例可用'))
  const mismatch = versionTagBadges({ gameVersions: ['26.2'], loaders: ['fabric'] }, { mc: '1.21.8', loader: 'fabric' })
  assert.deepEqual(mismatch, [])
})

test('compareVersionsDesc: 新版本在前', () => {
  assert.ok(compareVersionsDesc('26.3', '1.21.11') < 0)
  assert.ok(compareVersionsDesc('1.21.11', '1.21.8') < 0)
  assert.equal(compareVersionsDesc('1.21.8', '1.21.8'), 0)
})
