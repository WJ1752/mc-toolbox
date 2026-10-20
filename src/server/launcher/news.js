// 启动器首页资讯：Mojang 官方新闻与 Java 版更新日志（只读、带缓存）。
import { httpFetch } from '../http.js'
import { getManifest } from './meta.js'

const NEWS_URL = 'https://launchercontent.mojang.com/v2/news.json'
const PATCH_URL = 'https://launchercontent.mojang.com/v2/javaPatchNotes.json'
const IMAGE_BASE = 'https://launchercontent.mojang.com'
const TTL = 15 * 60 * 1000

let cache = { at: 0, value: null }

async function fetchList(url) {
  const response = await httpFetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'MC-Toolbox/1.8.0' },
    signal: AbortSignal.timeout(20000)
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const data = await response.json()
  return Array.isArray(data?.entries) ? data.entries : []
}

function absoluteImage(url) {
  if (!url) return ''
  return /^https?:/i.test(url) ? url : IMAGE_BASE + (url.startsWith('/') ? url : '/' + url)
}

export async function getNews({ force = false } = {}) {
  if (!force && cache.value && Date.now() - cache.at < TTL) return cache.value
  const [news, patches, manifest] = await Promise.allSettled([fetchList(NEWS_URL), fetchList(PATCH_URL), getManifest()])
  const latest = manifest.status === 'fulfilled' ? manifest.value.latest || {} : {}
  const value = {
    fetchedAt: Date.now(),
    latest: {
      release: latest.release || '',
      snapshot: latest.snapshot || ''
    },
    news: (news.status === 'fulfilled' ? news.value : []).slice(0, 8).map((item) => ({
      title: item.title || '',
      category: item.category || '',
      date: item.date || '',
      text: item.text || '',
      image: absoluteImage(item.image?.url || item.image?.imageURL || ''),
      readMore: item.readMoreLink || item.link || ''
    })),
    patches: (patches.status === 'fulfilled' ? patches.value : []).slice(0, 8).map((item) => ({
      title: item.title || '',
      version: item.version || '',
      type: item.type || '',
      date: item.date || '',
      body: item.body || '',
      image: absoluteImage(item.image?.url || item.image?.imageURL || '')
    }))
  }
  cache = { at: Date.now(), value }
  return value
}
