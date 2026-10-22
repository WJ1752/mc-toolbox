import test from 'node:test'
import assert from 'node:assert/strict'
import { looksLikeWindowReady } from '../src/server/launcher/game-window.js'

test('窗口就绪标记：命中窗口创建后才会出现的日志行', () => {
  const positives = [
    '[01:34:32] [Render thread/INFO]: Backend library: LWJGL version 3.3.1 build 7',
    '[01:34:32] [Render thread/INFO]: OpenGL Vendor: Intel',
    '[01:34:32] [main/INFO]: Setting user: Tarta',
    '[2026-10-22 01:34:32] [Render thread/INFO] [Iris]: Iris detected.',
    '[01:34:32] [main/INFO]: LWJGL Version: 3.3.1 build 7'
  ]
  for (const line of positives) assert.equal(looksLikeWindowReady(line), true, line)
})

test('窗口就绪标记：准备阶段的普通日志不算就绪', () => {
  const negatives = [
    '[01:34:30] [main/INFO]: Loading Minecraft 1.18.2 with Fabric Loader 0.14.14',
    '[01:34:30] [main/INFO]: Loading 144 mods:',
    '[01:34:31] [main/WARN]: Mod resolution took 920 ms',
    '进程已启动（PID 1234）',
    '游戏窗口已就绪（等待 12s）',
    '',
    null
  ]
  for (const line of negatives) assert.equal(looksLikeWindowReady(line), false, String(line))
})
