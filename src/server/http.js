// 共享 HTTP 请求入口：无代理时用全局 fetch，配置代理后切换到代理客户端。
import { parseProxy, makeProxyFetch } from './proxy.js'

let activeFetch = globalThis.fetch
let currentProxy = null

/** 设置（或清除）代理。传入原始代理字符串，空串/无值 = 直连。 */
export function setProxy(raw) {
  const p = parseProxy(raw)
  currentProxy = p
  activeFetch = p ? makeProxyFetch(p) : globalThis.fetch
  return !!p
}

export function getProxy() {
  return currentProxy
}

/** 统一的 fetch 入口，用法与 fetch 一致 */
export function httpFetch(url, init) {
  return activeFetch(url, init)
}
