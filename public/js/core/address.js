// 地址 / 端口工具：让「地址」输入框可以直接粘贴 host:port（如 mc.hypixel.net:25565）。
// 纯字符串解析，零依赖；attachHostPortInput 只负责把解析结果写回两个 <input>。

const SCHEME_RE = /^(?:[a-zA-Z][a-zA-Z0-9+.-]*:)?\/\//
const TRAIL_RE = /[/?#].*$/
const BRACKET_RE = /^\[([^\]]+)\](?::(.*))?$/

// 端口规范化：只接受 1–65535 的纯数字，其余（含空串 / 小数 / 越界）返回 null
function toPort(raw) {
  const text = String(raw == null ? '' : raw).trim()
  if (!/^\d{1,5}$/.test(text)) return null
  const n = Number(text)
  return n >= 1 && n <= 65535 ? n : null
}

/**
 * 把用户输入拆成 { host, port }，port 为 1–65535 的整数，没有则 null。规则按顺序：
 *  1. 去掉首尾空白；空输入返回 { host: '', port: null }；
 *  2. 去掉协议前缀（http:// https:// minecraft:// tcp:// … 以及 //）和尾部路径 / 查询串；
 *  3. [2001:db8::1]:25565 → { host: '2001:db8::1', port: 25565 }；
 *     只写 [2001:db8::1] → 返回内层地址、port 为 null；
 *  4. 不带方括号的 IPv6（两个及以上冒号）整体当主机，port 为 null；
 *  5. 恰好一个冒号、且后半段是合法端口时才拆分；
 *  6. 其余情况（host:abc、host:99999、普通域名）整体当主机，port 为 null，绝不吞掉内容。
 */
export function splitHostPort(raw) {
  let text = String(raw == null ? '' : raw).trim()
  if (!text) return { host: '', port: null }

  // 协议前缀 + 尾部路径（如 http://example.com:8080/ 或 play.example.com:25565/ ）
  text = text.replace(SCHEME_RE, '').replace(TRAIL_RE, '').trim()
  if (!text) return { host: '', port: null }

  // [IPv6]:端口 / 裸 [IPv6]
  const bracket = text.match(BRACKET_RE)
  if (bracket) {
    if (bracket[2] == null) return { host: bracket[1], port: null }
    const port = toPort(bracket[2])
    // 方括号里带了非法端口时原样保留，交给用户自己改
    return port == null ? { host: text, port: null } : { host: bracket[1], port }
  }

  // 裸 IPv6：整体当主机（端口交给旁边的端口框）
  if ((text.match(/:/g) || []).length >= 2) return { host: text, port: null }

  // host:port —— 只有一个冒号且后半段是合法端口才拆
  const idx = text.lastIndexOf(':')
  if (idx > 0) {
    const port = toPort(text.slice(idx + 1))
    if (port != null) return { host: text.slice(0, idx).trim(), port }
  }

  return { host: text, port: null }
}

/**
 * splitHostPort 的反向操作：输出 host 或 host:port。
 * 带端口时 IPv6 主机自动补方括号；没有端口时原样返回主机。
 */
export function formatHostPort(host, port) {
  // 先归一化：允许传入本身已含端口的字符串（如 'mc.example.com:25565'）
  const parsed = splitHostPort(host)
  const p = toPort(port) ?? parsed.port
  if (!parsed.host) return ''
  if (p == null) return parsed.host
  const shown = parsed.host.includes(':') ? '[' + parsed.host + ']' : parsed.host
  return shown + ':' + p
}

// 同一对输入框只绑一次：重复调用复用已有监听器（幂等）
const wired = new WeakMap()

/**
 * 让 hostInput / portInput 这对输入框支持「粘贴 host:port，自动拆到两个框」。
 *
 * - paste：立刻读取剪贴板文本并拆分，粘贴后马上能看到两个框都填好；
 * - change / blur：拆分 hostInput.value，解析出端口时把主机写回、端口写进 portInput；
 * - 地址里没有端口时绝不动 portInput（用户单独填的端口不能被覆盖）；
 * - 只有内容真的变化才调用 onChange，且解析后主机已不含端口，因此不会自我循环。
 *
 * 返回 { flush, dispose }：flush() 可手动再解析一次（回车 / 点保存前），dispose() 解绑。
 */
export function attachHostPortInput(hostInput, portInput, { onChange } = {}) {
  if (!hostInput || !portInput) return { flush: () => false, dispose: () => {} }

  // 幂等：已经绑过就只更新回调，不重复挂监听器
  const existing = wired.get(hostInput)
  if (existing) {
    existing.state.onChange = typeof onChange === 'function' ? onChange : null
    return existing.handle
  }

  const state = { onChange: typeof onChange === 'function' ? onChange : null, applying: false }

  // 写回两个框；返回是否真的改动了内容
  function write(host, port) {
    let changed = false
    if (hostInput.value !== host) {
      hostInput.value = host
      changed = true
    }
    if (port != null) {
      const pv = String(port)
      if (portInput.value !== pv) {
        portInput.value = pv
        changed = true
      }
    }
    return changed
  }

  // 应用一次解析结果；applying 防止 onChange 里再次触发造成递归
  function apply(host, port) {
    if (state.applying) return false
    state.applying = true
    try {
      const changed = write(host, port)
      if (changed && state.onChange) state.onChange()
      return changed
    } finally {
      state.applying = false
    }
  }

  // 解析 hostInput 当前内容（或传入的文本）；没有端口就完全不动
  function flush(rawValue) {
    if (state.applying) return false
    // 也允许直接作为事件监听器使用：Event 不是字符串时就退回读输入框
    const text = typeof rawValue === 'string' ? rawValue : hostInput.value
    const { host, port } = splitHostPort(text)
    if (!host || port == null) return false
    return apply(host, port)
  }

  function onPaste(e) {
    const clip = e.clipboardData || window.clipboardData
    const text = clip && typeof clip.getData === 'function' ? clip.getData('text') : ''
    if (!text) return
    const { host, port } = splitHostPort(text)
    // 没带端口：走浏览器默认粘贴，不打断用户
    if (!host || port == null) return
    // 阻止默认粘贴，避免「host:port」先整个塞进输入框再被改写造成闪烁
    e.preventDefault()
    apply(host, port)
  }

  hostInput.addEventListener('paste', onPaste)
  hostInput.addEventListener('change', flush)
  hostInput.addEventListener('blur', flush)

  function dispose() {
    hostInput.removeEventListener('paste', onPaste)
    hostInput.removeEventListener('change', flush)
    hostInput.removeEventListener('blur', flush)
    wired.delete(hostInput)
  }

  const handle = { flush, dispose }
  wired.set(hostInput, { state, handle })
  return handle
}
