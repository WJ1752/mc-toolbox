import test from 'node:test'
import assert from 'node:assert/strict'
import { findBiome, generateMap, getBiomes, getStructures, parseSeed, resolveVersion } from '../public/features/seed-map/engine.js'

test('Cubiomes 已知种子 262 的蘑菇岛、史莱姆区块和村庄位置', async () => {
  const params = { version: '1.18', dimension: 'overworld', seed: '262', x: 0, z: 0, step: 4, y: 63, width: 32, height: 4 }
  const local = await generateMap(params)
  assert.equal(local.biomes[0], 14)
  assert.equal(local.palette[14].key, 'mushroom_fields')
  assert.deepEqual(local.slimeChunks, [{ x: 3, z: 0 }, { x: 5, z: 0 }])
  // Upstream scripts/test-structures.mjs pins this biome-viable Java 1.18 village.
  const wide = await generateMap({ ...params, x: -1280, step: 16, width: 80, height: 90, structure: 'village' })
  assert.deepEqual(wide.structures.map(({ x, z }) => [x, z]), [[-1040, 1232]])
})

test('维度、版本和种子精度独立，文字使用 Java 32 位哈希', async () => {
  assert.equal(parseSeed('-9223372036854775808'), -(1n << 63n))
  assert.equal(parseSeed('Minecraft'), -1595926131n)
  for (const [save, profile] of [['1.20.1', '1.20.6'], ['1.16.5', '1.16.5'], ['1.19.1', '1.19.2'], ['1.21.2', '1.21.3'], ['1.21.4', '']]) {
    assert.equal(resolveVersion(save), profile)
  }
  assert.equal(getStructures('1.18', 'overworld').some(s => s.id === 'ancient_city'), false)
  assert.deepEqual(getStructures('1.21.3', 'end').map(s => s.id), ['end_city'])
  for (const [dimension, expected] of [['nether', 171], ['end', 9]]) {
    const result = await generateMap({ seed: '262', version: '1.18', dimension, x: 0, z: 0, step: 4, width: 1, height: 1 })
    assert.equal(result.biomes[0], expected)
    assert.deepEqual(result.slimeChunks, [])
  }
  await assert.rejects(generateMap({ seed: 0, version: '1.99' }), /不支持/)
})

test('按版本与维度寻找视野外群系，限制搜索量', async () => {
  assert.ok(getBiomes('1.20.1', 'overworld').some(b => b.key === 'cherry_grove'))
  assert.equal(getBiomes('1.18.2', 'overworld').some(b => b.key === 'cherry_grove'), false)
  assert.deepEqual(getBiomes('1.15.2', 'nether').map(b => b.key), ['nether_wastes'])
  const query = { seed: '262', version: '1.18.2', dimension: 'overworld', x: 1000, y: 63, z: 0, biomeId: 14 }
  assert.equal(await findBiome({ ...query, radius: 32 }), null)
  const found = await findBiome(query)
  assert.deepEqual(found, { x: 232, z: 360 })
  assert.deepEqual(await findBiome({ ...query, ...found, radius: 1 }), found)
  await assert.rejects(findBiome({ ...query, radius: 4096, step: 4 }), /范围/)
})
