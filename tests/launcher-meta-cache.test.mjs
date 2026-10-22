// 元数据缓存回归：一次网络抖动不能让后续十分钟的安装全部复用同一条失败。
// meta.js 的 cached() 以前会把 rejected Promise 留在缓存里，第二次安装会立刻
// 报同样的「获取元数据失败：fetch failed」；这里用可控 fetch 验证失败后能恢复。
import test from 'node:test'
import assert from 'node:assert/strict'

const realFetch = globalThis.fetch
let failing = true
globalThis.fetch = async () => {
  if (failing) throw new TypeError('fetch failed')
  return {
    ok: true,
    status: 200,
    json: async () => ({
      latest: { release: '26.3', snapshot: '26.4-snapshot-5' },
      versions: [{ id: '26.3', type: 'release', releaseTime: '', url: 'https://example.invalid/26.3.json' }]
    })
  }
}

test('元数据请求失败后不会污染缓存，下一次可以重新请求成功', async () => {
  const { getManifest, clearMetaCache } = await import('../src/server/launcher/meta.js')
  clearMetaCache()
  try {
    await assert.rejects(() => getManifest({ force: true }), /获取元数据失败/)
    failing = false
    const manifest = await getManifest()
    assert.equal(manifest.versions[0].id, '26.3')
    assert.equal(manifest.latest.release, '26.3')
  } finally {
    globalThis.fetch = realFetch
  }
})
