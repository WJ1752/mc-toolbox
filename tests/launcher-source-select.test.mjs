// 自动选源：测速样本决定 BMCL / 官方的先后；4xx 只代表「这个文件没有」，
// 不能把整条线路降级；确认失败的线路在 TTL 内排到最后。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  knownSpeed, markRateLimited, orderByStats, pickFastestSource, rankCandidates, recordSample, resetSourceStats
} from '../src/server/launcher/source-select.js'

const BMCL = 'https://bmclapi2.bangbang93.com/assets/00/aaaa'
const MOJANG = 'https://resources.download.minecraft.net/00/aaaa'
const OTHER = 'https://example.com/x'

test.beforeEach(() => resetSourceStats())

test('没有测速数据时保持调用方给的顺序（镜像优先的默认行为）', () => {
  assert.deepEqual(orderByStats([BMCL, MOJANG]), [BMCL, MOJANG])
  assert.equal(knownSpeed(BMCL), null)
})

test('实测吞吐高的线路排前面', () => {
  recordSample(BMCL, { bytes: 256 * 1024, ms: 1400 })   // ≈ 187 KB/s
  recordSample(MOJANG, { bytes: 4 * 1024 * 1024, ms: 400 }) // ≈ 10 MB/s
  assert.deepEqual(orderByStats([BMCL, MOJANG]), [MOJANG, BMCL])
})

test('小文件样本（<64 KB）不会污染带宽判断', () => {
  recordSample(MOJANG, { bytes: 4 * 1024 * 1024, ms: 400 })
  recordSample(BMCL, { bytes: 1024, ms: 1 }) // 1 KB / 1ms = 1 MB/s，不应覆盖大文件样本
  assert.equal(knownSpeed(BMCL), null)
  assert.deepEqual(orderByStats([BMCL, MOJANG]), [MOJANG, BMCL])
})

test('4xx 不降级线路，连接失败才降级；成功样本会清掉失败标记', () => {
  recordSample(BMCL, { failed: true, status: 404 })
  assert.equal(knownSpeed(BMCL), null)
  assert.deepEqual(orderByStats([BMCL, MOJANG]), [BMCL, MOJANG])

  recordSample(BMCL, { failed: true, status: 0 })
  assert.equal(knownSpeed(BMCL), 0)
  assert.deepEqual(orderByStats([MOJANG, BMCL]), [MOJANG, BMCL])

  recordSample(BMCL, { bytes: 1024 * 1024, ms: 100 })
  assert.ok(knownSpeed(BMCL) > 0)
  assert.deepEqual(orderByStats([MOJANG, BMCL]), [BMCL, MOJANG])
})

test('429 只短暂降级：30 秒后恢复为「未知」，不会永久拉黑线路', () => {
  const now = 1_800_000_000_000
  markRateLimited(BMCL, { now })
  assert.equal(knownSpeed(BMCL, now + 1000), 0)
  assert.equal(knownSpeed(BMCL, now + 31_000), null)
  // 限流期间排序把它放最后
  assert.deepEqual(orderByStats([BMCL, MOJANG], { now: now + 1000 }), [MOJANG, BMCL])
})

test('rankCandidates 只探测未知线路，并按探测结果排序', async () => {
  const probed = []
  const probe = async (url) => {
    probed.push(url)
    if (url === MOJANG) return { bytes: 256 * 1024, ms: 20 }
    return { bytes: 256 * 1024, ms: 2000 }
  }
  const ordered = await rankCandidates([BMCL, MOJANG, OTHER], { probe })
  assert.equal(ordered[0], MOJANG)
  assert.equal(ordered.length, 3)
  assert.equal(new Set(probed).size, 3)

  // 第二次调用：已有新鲜样本，不再重复探测。
  const before = probed.length
  await rankCandidates([BMCL, MOJANG, OTHER], { probe })
  assert.equal(probed.length, before)
})

test('pickFastestSource：强制测速并返回最快的地址', async () => {
  const probe = async (url) => (url === MOJANG ? { bytes: 512 * 1024, ms: 50 } : { bytes: 512 * 1024, ms: 3000 })
  assert.equal(await pickFastestSource([BMCL, MOJANG], { probe }), MOJANG)
  assert.ok(knownSpeed(MOJANG) > knownSpeed(BMCL))
})

test('pickFastestSource：只有一个候选时直接返回，不发起探测', async () => {
  let called = 0
  const probe = async () => { called++; return { bytes: 1, ms: 1 } }
  assert.equal(await pickFastestSource([BMCL], { probe }), BMCL)
  assert.equal(called, 0)
})

test('探测失败时不会把线路判死，只是暂时没有排名依据', async () => {
  const ordered = await rankCandidates([BMCL, MOJANG], {
    probe: async () => { throw new Error('timeout') }
  })
  assert.deepEqual(ordered, [BMCL, MOJANG])
  assert.equal(knownSpeed(BMCL), null)
})
