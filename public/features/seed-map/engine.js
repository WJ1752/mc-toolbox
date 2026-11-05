// Offline Java Edition map adapter. Grid origins and structure positions use block coordinates.
import { JavaWorldGenerator } from '../../vendor/seedmaps/world-generator.js'
import { structureOverlay } from '../../vendor/seedmaps/structures.js'
import { biomeNames } from './biome-names.js'
import { catalog } from './biome-catalog.js'

export const VERSIONS = Object.freeze([
  '1.21.3', '1.21.1', '1.20.6', '1.19.4', '1.19.2', '1.18.2', '1.17.1', '1.16.5', '1.16.1',
  '1.15.2', '1.14.4', '1.13.2', '1.12.2', '1.11.2', '1.10.2', '1.9.4'
])

// Cubiomes 以生成算法分组，对 1.16、1.19、1.21 的中途变更有独立枚举。
const LAST_PATCH = { 9: 4, 10: 2, 11: 2, 12: 2, 13: 2, 14: 4, 15: 2, 16: 5, 17: 1, 18: 2, 19: 4, 20: 6, 21: 3 }
export function resolveVersion(value) {
  if (VERSIONS.includes(value)) return value
  const match = /^1\.(\d+)(?:\.(\d+))?$/.exec(String(value || ''))
  if (!match) return ''
  const minor = Number(match[1]), patch = Number(match[2] || 0)
  if (!Object.hasOwn(LAST_PATCH, minor) || patch > LAST_PATCH[minor]) return ''
  if (minor === 16 && patch <= 1) return '1.16.1'
  if (minor === 19 && patch <= 2) return '1.19.2'
  if (minor === 21) return patch <= 1 ? '1.21.1' : '1.21.3'
  return `1.${minor}.${LAST_PATCH[minor]}`
}

const DIMENSIONS = Object.freeze({ overworld: 0, nether: -1, end: 1 })
const LANDMARKS = {
  overworld: [
    ['village', '村庄', 9], ['desert_pyramid', '沙漠神殿', 9], ['jungle_pyramid', '丛林神庙', 9],
    ['swamp_hut', '沼泽小屋', 9], ['igloo', '雪屋', 9], ['monument', '海底神殿', 9],
    ['mansion', '林地府邸', 11], ['ocean_ruin', '海底废墟', 13], ['shipwreck', '沉船', 13],
    ['pillager_outpost', '掠夺者前哨站', 14], ['ruined_portal', '废弃传送门', 16],
    ['ancient_city', '远古城市', 19], ['trail_ruins', '古迹废墟', 20], ['trial_chambers', '试炼密室', 21]
  ],
  nether: [['fortress', '下界要塞', 9], ['bastion_remnant', '堡垒遗迹', 16], ['ruined_portal_nether', '废弃传送门', 16]],
  end: [['end_city', '末地城', 9]]
}

export function getStructures(version, dimension) {
  version = resolveVersion(version)
  if (!version || !Object.hasOwn(DIMENSIONS, dimension)) return []
  const minor = Number(version.split('.')[1])
  return LANDMARKS[dimension].filter(([, , since]) => minor >= since).map(([id, name]) => ({ id, name }))
}

export function getBiomes(version, dimension) {
  const minor = Number(resolveVersion(version).split('.')[1])
  return catalog.filter(([, , first, last, dim]) => dim === DIMENSIONS[dimension] && minor >= first && minor <= last)
    .map(([id, key]) => ({ id, key, name: biomeNames[key] || key }))
}

// Java Long.parseLong falls back to String.hashCode (signed 32 bits) on non-numeric or overflow.
export function parseSeed(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('长种子请以文本输入，以保留全部数位')
  const text = String(value ?? '').trim()
  if (!text) throw new Error('请输入世界种子')
  if (/^[+-]?\d+$/.test(text)) {
    const n = BigInt(text)
    if (BigInt.asIntN(64, n) === n) return n
  }
  let hash = 0
  for (let i = 0; i < text.length; i++) hash = (Math.imul(hash, 31) + text.charCodeAt(i)) | 0
  return BigInt(hash)
}

let ready
function getEngine() {
  if (!ready) ready = new JavaWorldGenerator().init().catch(error => { ready = null; throw error })
  return ready
}

// Search a bounded grid in a dedicated worker. A coarse positive must also pass
// a block-resolution query at the requested Y before we offer that coordinate.
export async function findBiome({ seed, version, dimension = 'overworld', x, z, y = 64, biomeId, radius = 2048, step = 16 }) {
  const id = Number(biomeId)
  if (!getBiomes(version, dimension).some(b => b.id === id)) throw new Error('该版本和维度没有这个群系')
  const side = Math.ceil(2 * radius / step) + 1
  if (![x, z, y, radius].every(Number.isSafeInteger) || ![4, 16].includes(step) || radius < 1 ||
      radius > 4096 || side * side > 300000 || Math.abs(x) > 30000000 || Math.abs(z) > 30000000 ||
      y < -64 || y > 319) throw new Error('查找范围过大或坐标无效')
  const engine = await getEngine()
  engine.initialize({ version: engine.versionFromString(resolveVersion(version)), seed: parseSeed(seed), dimension: DIMENSIONS[dimension] })
  if (engine.getBiome(x, y, z, 1) === id) return { x, z }
  const gx = Math.floor((x - radius) / step), gz = Math.floor((z - radius) / step)
  const grid = engine.generateBiomes({ x: gx, z: gz, width: side, height: side, scale: step, y: Math.floor(y / 4) })
  let closest = null
  let distance = radius * radius + 1
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] !== id) continue
    const bx = (gx + i % side) * step + Math.floor(step / 2)
    const bz = (gz + Math.floor(i / side)) * step + Math.floor(step / 2)
    const d = (bx - x) ** 2 + (bz - z) ** 2
    if (d < distance && Math.abs(bx) <= 30000000 && Math.abs(bz) <= 30000000 && engine.getBiome(bx, y, bz, 1) === id) {
      closest = { x: bx, z: bz }
      distance = d
    }
  }
  return closest
}

export async function generateMap({ seed, version, dimension = 'overworld', x, z, y = 64, step = 4, width = 96, height = 96, structure = '' }) {
  version = resolveVersion(version)
  if (!version || !Object.hasOwn(DIMENSIONS, dimension)) throw new Error('不支持的 Java 版本或维度')
  if (![x, z, y, width, height].every(Number.isSafeInteger) || ![4, 16, 64].includes(step) ||
      width < 1 || height < 1 || width > 128 || height > 128 || Math.abs(x) > 30000000 || Math.abs(z) > 30000000 ||
      y < -64 || y > 319) throw new Error('地图坐标、采样间距或尺寸超出范围')
  const worldSeed = parseSeed(seed)
  const engine = await getEngine()
  const mc = engine.versionFromString(version)
  engine.initialize({ version: mc, seed: worldSeed, dimension: DIMENSIONS[dimension] })
  const grid = engine.generateBiomes({ x: Math.floor(x / step), z: Math.floor(z / step), width, height, scale: step, y: Math.floor(y / 4) })
  const colors = engine.biomeColors()
  const palette = {}
  for (const id of new Set(grid)) {
    if (id < 0 || id > 255) throw new Error('引擎返回未知群系编号')
    const key = engine.biomeName(id)
    palette[id] = { key, name: biomeNames[key] || key, color: colors[id] || '#666666' }
  }
  const box = { x0: x, z0: z, x1: x + width * step, z1: z + height * step }
  const types = getStructures(version, dimension).filter(s => structure === 'all' || s.id === structure)
  const names = new Map(types.map(s => [s.id, s.name]))
  const structures = structureOverlay({ engine, seed: worldSeed, mc, box, types: types.map(s => ({ name: s.id })) })
    .filter(p => p.viable).map(p => ({ x: p.x, z: p.z, id: p.type, name: names.get(p.type) }))
  const slimeChunks = []
  if (dimension === 'overworld' && step === 4) {
    for (let cz = Math.floor(z / 16); cz <= Math.floor((box.z1 - 1) / 16); cz++) {
      for (let cx = Math.floor(x / 16); cx <= Math.floor((box.x1 - 1) / 16); cx++) {
        if (engine.isSlimeChunk(worldSeed, cx, cz)) slimeChunks.push({ x: cx, z: cz })
      }
    }
  }
  return { biomes: Uint8Array.from(grid), palette, structures, slimeChunks }
}
