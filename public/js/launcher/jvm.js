// 一键 JVM 优化参数（Aikar 风格 G1 预设）。
// 只负责生成/合并参数，不改动 -Xms / -Xmx；重复点击不会叠加参数。
export const OPTIMIZED_JVM_FLAGS = [
  '-XX:+UseG1GC',
  '-XX:+ParallelRefProcEnabled',
  '-XX:MaxGCPauseMillis=200',
  '-XX:+UnlockExperimentalVMOptions',
  '-XX:+DisableExplicitGC',
  '-XX:+AlwaysPreTouch',
  '-XX:G1NewSizePercent=30',
  '-XX:G1MaxNewSizePercent=40',
  '-XX:G1HeapRegionSize=8M',
  '-XX:G1ReservePercent=20',
  '-XX:G1HeapWastePercent=5',
  '-XX:G1MixedGCCountTarget=4',
  '-XX:InitiatingHeapOccupancyPercent=15',
  '-XX:G1MixedGCLiveThresholdPercent=90',
  '-XX:G1RSetUpdatingPauseTimePercent=5',
  '-XX:SurvivorRatio=32',
  '-XX:+PerfDisableSharedMem',
  '-XX:MaxTenuringThreshold=1'
]

const MANAGED_PREFIXES = [
  '-XX:G1NewSizePercent=',
  '-XX:G1MaxNewSizePercent=',
  '-XX:G1HeapRegionSize=',
  '-XX:G1ReservePercent=',
  '-XX:G1HeapWastePercent=',
  '-XX:G1MixedGCCountTarget=',
  '-XX:InitiatingHeapOccupancyPercent=',
  '-XX:G1MixedGCLiveThresholdPercent=',
  '-XX:G1RSetUpdatingPauseTimePercent=',
  '-XX:SurvivorRatio=',
  '-XX:MaxTenuringThreshold=',
  '-XX:MaxGCPauseMillis='
]

const MANAGED_EXACT = new Set(OPTIMIZED_JVM_FLAGS.filter((flag) => !flag.includes('=')))

function tokenize(text) {
  return String(text || '').split(/\s+/).map((item) => item.trim()).filter(Boolean)
}

/** Merge the preset into existing args, keeping user flags and dropping stale preset duplicates. */
export function optimizedJvmArgs(existing = '') {
  const kept = tokenize(existing).filter((arg) => {
    if (MANAGED_EXACT.has(arg)) return false
    return !MANAGED_PREFIXES.some((prefix) => arg.startsWith(prefix))
  })
  const seen = new Set(kept)
  for (const flag of OPTIMIZED_JVM_FLAGS) {
    if (seen.has(flag)) continue
    kept.push(flag)
    seen.add(flag)
  }
  return kept.join(' ')
}

export function hasOptimizedJvm(args = '') {
  const text = String(args || '')
  return OPTIMIZED_JVM_FLAGS.every((flag) => new RegExp(`(^|\\s)${flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s|$)`).test(text))
}
