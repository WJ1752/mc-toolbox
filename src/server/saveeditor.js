// 存档编辑器 —— 定位 .minecraft、列出世界、读写 level.dat / 玩家数据
//
// 安全策略：
//   1) 每次写盘前自动把原文件备份为 <name>.dat.bak-<时间戳>，每份文件只保留最近 10 份
//   2) 只改白名单字段（LEVEL_FIELDS / PLAYER_FIELDS），其余原始字节结构保持不变
//   3) 字段写入沿用文件里已有的标签类型（byte/short/int/float/double 不串型），缺失字段按 schema 类型新建
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { parse as nbtParse, write as nbtWrite, NbtNum, TAG } from './nbt.js'

// ---------------- .minecraft 定位 ----------------

// 常见候选目录（Java 版）。第三方启动器（PCL/HMCL 等）目录五花八门，交给用户手动选。
export function findMcDirs() {
  const appdata = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming')
  const candidates = [
    path.join(appdata, '.minecraft')
  ]
  const out = []
  const seen = new Set()
  for (const c of candidates) {
    if (seen.has(c.toLowerCase())) continue
    seen.add(c.toLowerCase())
    if (fs.existsSync(path.join(c, 'saves'))) out.push({ name: path.basename(c), path: c })
  }
  return out
}

function resolveSavesDir(mcDir) {
  if (!mcDir) throw new Error('未指定 .minecraft 目录')
  const saves = path.join(mcDir, 'saves')
  if (!fs.existsSync(saves)) throw new Error('目录里没有 saves 子目录：' + mcDir)
  return saves
}

// ---------------- 字段白名单 ----------------

// kind: string | int | long | float | double | bool（bool = TAG_Byte 0/1）
// 数值写入时优先沿用文件里现有值的标签类型，缺失时按 kind 新建
export const LEVEL_FIELDS = {
  LevelName: { path: ['LevelName'], kind: 'string' },
  GameType: { path: ['GameType'], kind: 'int' },
  Difficulty: { path: ['Difficulty'], kind: 'int' },
  DifficultyLocked: { path: ['DifficultyLocked'], kind: 'bool' },
  hardcore: { path: ['hardcore'], kind: 'bool' },
  allowCommands: { path: ['allowCommands'], kind: 'bool' },
  SpawnX: { path: ['SpawnX'], kind: 'int' },
  SpawnY: { path: ['SpawnY'], kind: 'int' },
  SpawnZ: { path: ['SpawnZ'], kind: 'int' },
  Time: { path: ['Time'], kind: 'long' },
  DayTime: { path: ['DayTime'], kind: 'long' },
  raining: { path: ['raining'], kind: 'bool' },
  thundering: { path: ['thundering'], kind: 'bool' },
  rainTime: { path: ['rainTime'], kind: 'int' },
  thunderTime: { path: ['thunderTime'], kind: 'int' },
  BorderCenterX: { path: ['BorderCenterX'], kind: 'double' },
  BorderCenterZ: { path: ['BorderCenterZ'], kind: 'double' },
  BorderSize: { path: ['BorderSize'], kind: 'double' },
  BorderWarningBlocks: { path: ['BorderWarningBlocks'], kind: 'double' }
}

export const PLAYER_FIELDS = {
  Health: { path: ['Health'], kind: 'float' },
  maxHealth: { special: 'maxHealth' },                      // Attributes 里的 generic.max_health Base
  foodLevel: { path: ['foodLevel'], kind: 'int' },
  foodSaturationLevel: { path: ['foodSaturationLevel'], kind: 'float' },
  XpLevel: { path: ['XpLevel'], kind: 'int' },
  XpP: { path: ['XpP'], kind: 'float' },
  XpTotal: { path: ['XpTotal'], kind: 'int' },
  playerGameType: { path: ['playerGameType'], kind: 'int' },
  PosX: { path: ['Pos', 0], kind: 'double' },
  PosY: { path: ['Pos', 1], kind: 'double' },
  PosZ: { path: ['Pos', 2], kind: 'double' },
  RotationYaw: { path: ['Rotation', 0], kind: 'float' },
  RotationPitch: { path: ['Rotation', 1], kind: 'float' },
  mayfly: { path: ['abilities', 'mayfly'], kind: 'bool' },
  instabuild: { path: ['abilities', 'instabuild'], kind: 'bool' },
  invulnerable: { path: ['Invulnerable'], kind: 'bool' },
  flySpeed: { path: ['abilities', 'flySpeed'], kind: 'float' },
  walkSpeed: { path: ['abilities', 'walkSpeed'], kind: 'float' }
}

const GAME_TYPES = ['生存', '创造', '冒险', '旁观']
const DIFFICULTIES = ['和平', '简单', '普通', '困难']

// ---------------- JSON 安全转换 ----------------

// NBT 树 → 可 JSON 序列化的展示结构（NbtNum→number，BigInt→安全范围内 number 否则字符串）
function plain(v, depth = 0) {
  if (v instanceof NbtNum) return v.value
  if (typeof v === 'bigint') {
    const n = Number(v)
    return Number.isSafeInteger(n) ? n : v.toString()
  }
  if (Array.isArray(v)) return depth > 6 ? `[${v.length} 项]` : v.map((x) => plain(x, depth + 1))
  if (v instanceof Uint8Array || v instanceof Int32Array || v instanceof BigInt64Array) return `[${v.length} 项]`
  if (v && typeof v === 'object') {
    if (depth > 6) return '{…}'
    const out = {}
    for (const [k, x] of Object.entries(v)) out[k] = plain(x, depth + 1)
    return out
  }
  return v
}

const numOf = (v) => (v instanceof NbtNum ? v.value : (typeof v === 'bigint' ? Number(v) : Number(v) || 0))
const strOf = (v) => (v && typeof v === 'object' && !(v instanceof NbtNum) ? '' : String(v ?? ''))

// ---------------- 世界列表 ----------------

function readLevelData(worldPath) {
  const file = path.join(worldPath, 'level.dat')
  if (!fs.existsSync(file)) throw new Error('level.dat 不存在：' + worldPath)
  const root = nbtParse(fs.readFileSync(file))
  const data = root.value.Data
  if (!data || typeof data !== 'object') throw new Error('level.dat 里没有 Data 节点')
  return { file, root, data }
}

function worldSummary(dirName, worldPath, data) {
  const versionNode = data.Version && typeof data.Version === 'object' ? data.Version : {}
  const seedNode = (data.WorldGenSettings && data.WorldGenSettings.seed) || data.RandomSeed
  return {
    name: dirName,
    path: worldPath,
    levelName: strOf(data.LevelName) || dirName,
    gameType: numOf(data.GameType),
    difficulty: numOf(data.Difficulty),
    hardcore: !!(data.hardcore && data.hardcore.value),
    cheats: !!(data.allowCommands && data.allowCommands.value),
    version: strOf(versionNode.Name) || '?',
    lastPlayed: numOf(data.LastPlayed),
    time: String(typeof data.Time === 'bigint' ? data.Time : numOf(data.Time)),
    dayTime: String(typeof data.DayTime === 'bigint' ? data.DayTime : numOf(data.DayTime)),
    seed: seedNode === undefined ? '' : String(seedNode instanceof NbtNum || typeof seedNode === 'bigint' ? plain(seedNode) : seedNode),
    mtime: fs.statSync(path.join(worldPath, 'level.dat')).mtimeMs
  }
}

export async function listWorlds(mcDir) {
  const saves = resolveSavesDir(mcDir)
  const worlds = []
  for (const ent of await fsp.readdir(saves, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue
    const worldPath = path.join(saves, ent.name)
    if (!fs.existsSync(path.join(worldPath, 'level.dat'))) continue
    try {
      const { data } = readLevelData(worldPath)
      worlds.push(worldSummary(ent.name, worldPath, data))
    } catch (e) {
      worlds.push({ name: ent.name, path: worldPath, error: e.message })
    }
  }
  worlds.sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0))
  return { savesDir: saves, worlds }
}

// ---------------- 世界详情（level.dat 字段 + 玩家清单） ----------------

export async function readWorld(worldPath) {
  const { data } = readLevelData(worldPath)
  const players = []
  if (data.Player && typeof data.Player === 'object') {
    players.push({ key: 'level', label: '单人玩家（存于 level.dat）' })
  }
  const pdDir = path.join(worldPath, 'playerdata')
  if (fs.existsSync(pdDir)) {
    for (const f of (await fsp.readdir(pdDir)).filter((x) => x.endsWith('.dat')).sort()) {
      players.push({ key: f, label: f.replace(/\.dat$/, '') })
    }
  }
  return { fields: plain(pickFields(data, LEVEL_FIELDS)), players }
}

// 玩家数据读取（key = 'level' → level.dat 里的 Data.Player；否则 playerdata/<key>）
export async function readPlayer(worldPath, playerKey) {
  const src = await loadPlayer(worldPath, playerKey)
  const p = src.node
  const inv = Array.isArray(p.Inventory)
    ? p.Inventory.map((it) => ({
      slot: numOf(it.Slot),
      id: strOf(it.id),
      count: numOf(it.Count)
    })).sort((a, b) => a.slot - b.slot)
    : []
  const attrMax = findMaxHealthAttr(p)
  const abilities = p.abilities && typeof p.abilities === 'object' ? p.abilities : {}
  return {
    fields: plain(pickFields(p, PLAYER_FIELDS)),
    maxHealth: attrMax ? numOf(attrMax.Base) : null,
    abilitiesMayfly: !!(abilities.mayfly && abilities.mayfly.value),
    gameTypeLabel: GAME_TYPES[numOf(p.playerGameType)] || '?',
    healthLabel: numOf(p.Health).toFixed(1),
    xpLevel: numOf(p.XpLevel),
    pos: Array.isArray(p.Pos) ? p.Pos.map((x) => numOf(x)) : [],
    inventory: inv,
    inventoryCount: inv.reduce((s, x) => s + x.count, 0)
  }
}

// ---------------- 写入 ----------------

function keepBackups(file) {
  const dir = path.dirname(file)
  const base = path.basename(file)
  return fsp.readdir(dir)
    .then((names) => names
      .filter((n) => n.startsWith(base + '.bak-'))
      .sort()
      .reverse()
      .slice(10))
    .then((old) => Promise.all(old.map((n) => fsp.unlink(path.join(dir, n)).catch(() => {}))))
}

async function backup(file) {
  // 毫秒 + 随机后缀：同一秒内多次写盘也不能互相覆盖
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 23) + '-' + Math.random().toString(36).slice(2, 6)
  const target = file + '.bak-' + stamp
  await fsp.copyFile(file, target)
  keepBackups(file).catch(() => {})
  return target
}

function pickFields(node, table) {
  const out = {}
  for (const [name, def] of Object.entries(table)) {
    if (def.special) continue // maxHealth 之类的特殊字段由 readPlayer 单独返回
    const v = getIn(node, def.path)
    out[name] = v === undefined ? null : plain(v)
  }
  return out
}

function getIn(node, pathSegs) {
  let cur = node
  for (const seg of pathSegs) {
    if (cur === undefined || cur === null) return undefined
    if (typeof seg === 'number') {
      if (!Array.isArray(cur) || seg >= cur.length) return undefined
      cur = cur[seg]
    } else {
      if (typeof cur !== 'object' || cur instanceof NbtNum) return undefined
      cur = cur[seg]
    }
  }
  return cur
}

function setIn(node, pathSegs, value) {
  let cur = node
  for (let i = 0; i < pathSegs.length - 1; i++) {
    const seg = pathSegs[i]
    cur = typeof seg === 'number' ? cur[seg] : (cur[seg] ||= {})
  }
  const last = pathSegs[pathSegs.length - 1]
  cur[last] = value
}

// 按字段定义把编辑值写进 NBT 树：数值沿用旧类型，布尔写 TAG_Byte，列表元素按元素原类型
function applyField(node, def, value) {
  if (def.path.length === 1 && typeof def.path[0] === 'string') {
    const key = def.path[0]
    const old = node[key]
    node[key] = convertValue(old, def.kind, value)
    return
  }
  // 列表元素（Pos / Rotation）或嵌套 compound（abilities）
  let parent = node
  for (let i = 0; i < def.path.length - 1; i++) {
    const seg = def.path[i]
    parent = typeof seg === 'number' ? parent[seg] : (parent[seg] ||= {})
  }
  const last = def.path[def.path.length - 1]
  const old = parent[last]
  parent[last] = convertValue(old, def.kind, value)
}

function convertValue(old, kind, value) {
  switch (kind) {
    case 'string': return String(value)
    case 'bool': return new NbtNum(TAG.BYTE, value ? 1 : 0)
    case 'long': return BigInt(typeof value === 'string' ? (value.trim() || '0') : Math.trunc(Number(value) || 0))
    default: {
      const type = old instanceof NbtNum ? old.tagType : ({ int: TAG.INT, float: TAG.FLOAT, double: TAG.DOUBLE }[kind] ?? TAG.INT)
      return new NbtNum(type, Number(value) || 0)
    }
  }
}

function findMaxHealthAttr(playerNode) {
  if (!Array.isArray(playerNode.Attributes)) return null
  return playerNode.Attributes.find((a) => a && typeof a.Name === 'string' && a.Name.includes('max_health')) || null
}

export async function writeLevel(worldPath, edits) {
  const { file, root, data } = readLevelData(worldPath)
  const applied = []
  for (const [name, value] of Object.entries(edits || {})) {
    const def = LEVEL_FIELDS[name]
    if (!def) continue
    applyField(data, def, value)
    applied.push(name)
  }
  if (!applied.length) return { error: '没有可应用的字段' }
  const backupPath = await backup(file)
  await fsp.writeFile(file, nbtWrite(root, { gzip: true }))
  return { ok: true, backup: backupPath, applied }
}

async function loadPlayer(worldPath, playerKey) {
  if (playerKey === 'level') {
    const { file, root, data } = readLevelData(worldPath)
    if (!data.Player || typeof data.Player !== 'object') throw new Error('level.dat 里没有单人玩家数据')
    return { file, root, node: data.Player }
  }
  if (!/^[\w-]+\.dat$/.test(playerKey)) throw new Error('非法的玩家文件名')
  const file = path.join(worldPath, 'playerdata', playerKey)
  if (!fs.existsSync(file)) throw new Error('玩家数据不存在：' + playerKey)
  const root = nbtParse(fs.readFileSync(file))
  return { file, root, node: root.value }
}

export async function writePlayer(worldPath, playerKey, edits) {
  const src = await loadPlayer(worldPath, playerKey)
  const node = src.node
  const applied = []
  for (const [name, value] of Object.entries(edits || {})) {
    const def = PLAYER_FIELDS[name]
    if (!def) continue
    if (def.special === 'maxHealth') {
      const attr = findMaxHealthAttr(node)
      if (!attr) throw new Error('未找到最大生命值属性（generic.max_health）')
      attr.Base = new NbtNum(TAG.DOUBLE, Number(value) || 20)
    } else {
      applyField(node, def, value)
    }
    applied.push(name)
  }
  if (!applied.length) return { error: '没有可应用的字段' }
  const backupPath = await backup(src.file)
  if (playerKey === 'level') {
    // 单人玩家存于 level.dat 的 Data.Player：node 是同一棵树的引用，直接整树写回
    await fsp.writeFile(src.file, nbtWrite(src.root, { gzip: true }))
  } else {
    await fsp.writeFile(src.file, nbtWrite({ name: src.root.name, value: node }, { gzip: true }))
  }
  return { ok: true, backup: backupPath, applied }
}

export const labels = { gameTypes: GAME_TYPES, difficulties: DIFFICULTIES }
