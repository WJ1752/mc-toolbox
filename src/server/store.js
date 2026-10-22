import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

// 极简 JSON 文件存储：首次读取时写入默认值，写入做防抖 + 原子替换
//
// 文件目录策略（用户要求：所有配置项都存在「文档」里，方便分享与手改）：
//   - 'clientmods'            → CLIENT_MODS_DIR = 文档\MC Toolbox\client-mods
//   - 运行数据（RUNTIME_DATA）→ DATA_DIR       = LOCALAPPDATA\MC Toolbox\data
//   - 其余全部（settings / monitors / ...）→ CONFIG_DIR = 文档\MC Toolbox\config
//
// 注：API 保持同步（外层只需要 set/get），文件 I/O 也都用 sync 版本。
// 路径解析在 paths.js 启动期已经全部落地（首次 init 已缓存），这里直接读常量。

import { DATA_DIR, CLIENT_MODS_DIR, CONFIG_DIR } from './paths.js'

// 高频写入的运行数据留在 AppData，避免持续触发文档目录（可能被 OneDrive 同步）的变更
const RUNTIME_DATA = new Set(['history'])

const cache = new Map()
const timers = new Map()

function dirOf(name) {
  if (name === 'clientmods') return CLIENT_MODS_DIR
  if (RUNTIME_DATA.has(name)) return DATA_DIR
  return CONFIG_DIR || DATA_DIR
}

function fileOf(name) {
  const dir = dirOf(name)
  return path.join(dir, name.endsWith('.json') ? name : name + '.json')
}

function ensureDirSync(name) {
  const dir = dirOf(name)
  if (dir && !fs.existsSync(dir)) {
    try { fs.mkdirSync(dir, { recursive: true }) } catch {}
  }
  return dir
}

export const store = {
  has(name) {
    return fs.existsSync(fileOf(name))
  },

  get(name, fallback) {
    if (cache.has(name)) return cache.get(name)
    ensureDirSync(name)
    const file = fileOf(name)
    let raw = null
    let readError = null
    try {
      raw = fs.readFileSync(file, 'utf8')
    } catch (e) {
      readError = e
    }
    let value
    if (raw === null && readError && readError.code !== 'ENOENT') {
      // 文件存在但读不出来（被占用 / 无权限）：绝不能覆盖，先用默认值顶上。
      console.warn('[store] 读取失败，本次使用默认值', name, readError.message)
      value = fallback
    } else if (raw === null) {
      value = fallback
      try {
        fs.writeFileSync(file, JSON.stringify(fallback, null, 2), 'utf8')
      } catch (e) {
        console.warn('[store] 初始化失败', name, e.message)
      }
    } else {
      try {
        value = JSON.parse(raw)
      } catch (e) {
        // 文件损坏：先把原文件备份成 .bad-时间戳，再写默认值。
        // 直接覆盖会让用户以为实例/设置被删光了。
        value = fallback
        try {
          const backup = `${file}.bad-${Date.now()}`
          fs.renameSync(file, backup)
          console.warn(`[store] ${name} 解析失败，原文件已备份到 ${backup}：${e.message}`)
        } catch (renameError) {
          console.warn('[store] 备份损坏文件失败', name, renameError.message)
        }
        try {
          fs.writeFileSync(file, JSON.stringify(fallback, null, 2), 'utf8')
        } catch (writeError) {
          console.warn('[store] 初始化失败', name, writeError.message)
        }
      }
    }
    cache.set(name, value)
    return value
  },

  set(name, value) {
    cache.set(name, value)
    return store.flush(name)
  },

  flush(name) {
    const value = cache.get(name)
    if (value === undefined) return
    try {
      ensureDirSync(name)
      const file = fileOf(name)
      const tmp = file + '.tmp'
      fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
      fs.renameSync(tmp, file)
    } catch (e) {
      console.warn('[store] 写入失败', name, e.message)
    }
  },

  // 防抖写入：高频更新场景（如历史数据）
  schedule(name, delayMs = 20000) {
    if (timers.has(name)) return
    const t = setTimeout(() => {
      timers.delete(name)
      store.flush(name)
    }, delayMs)
    t.unref?.()
    timers.set(name, t)
  },

  async flushAll() {
    for (const name of cache.keys()) store.flush(name)
  }
}
