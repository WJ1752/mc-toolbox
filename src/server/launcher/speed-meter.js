// 下载速度采样：服务端只维护「已下载字节」，速度统一在这里算。
//
// 直接拿两次轮询的差值除以间隔会抖得很厉害；这里做一次指数平滑，并且在
// 没有新字节时（校验 / 安装器阶段）快速衰减到 0，避免界面停在最后一次峰值。
export function nextSpeed(previous, deltaBytes, dtSeconds) {
  const prev = Math.max(0, Number(previous) || 0)
  const dt = Number(dtSeconds)
  if (!(dt > 0)) return prev
  const delta = Math.max(0, Number(deltaBytes) || 0)
  const instant = delta / dt
  const smoothed = delta > 0 ? (prev > 0 ? prev * 0.6 + instant * 0.4 : instant) : prev * 0.35
  // 小于 1 KB/s 视为已经停了，界面不再显示「1 B/s」这种噪声。
  return smoothed < 1024 ? 0 : smoothed
}
