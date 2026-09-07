// 极简事件总线：功能之间可选通信（不依赖彼此是否存在）
const map = new Map()

export const bus = {
  on(event, fn) {
    if (!map.has(event)) map.set(event, new Set())
    map.get(event).add(fn)
    return () => bus.off(event, fn)
  },
  off(event, fn) {
    map.get(event)?.delete(fn)
  },
  emit(event, payload) {
    for (const fn of map.get(event) || []) {
      try {
        fn(payload)
      } catch (e) {
        console.warn('[bus]', event, e)
      }
    }
  }
}
