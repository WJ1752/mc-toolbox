// 代理 F：实例主面板（public/js/launcher/index.js）的启动进度与错误面板纯函数测试。
// 只验证不依赖真实浏览器的映射逻辑；DOM 渲染由 tools/launcher-ui-smoke.mjs 覆盖。
import test from 'node:test'
import assert from 'node:assert/strict'

// index.js 的依赖链（modal/contextmenu）在模块加载时会注册全局监听，这里给出最小桩。
globalThis.window = { addEventListener() {}, removeEventListener() {} }
globalThis.document = { getElementById: () => null, addEventListener() {} }

const {
  launchPhaseText,
  launchProgressInfo,
  normalizeLaunchError,
  launchErrorCopyText
} = await import('../public/js/launcher/index.js')

test('launchPhaseText：准备/启动/运行/失败/取消的中文阶段文案', () => {
  assert.equal(
    launchPhaseText({ status: 'preparing', phase: 'files', phaseLabel: '校验客户端文件', step: 3, total: 7 }),
    '正在准备启动 · 3/7 校验客户端文件'
  )
  assert.equal(
    launchPhaseText({ status: 'preparing', phase: 'natives', step: 5, total: 7, progress: 42 }),
    '正在准备启动 · 5/7 解压 natives'
  )
  assert.equal(
    launchPhaseText({ status: 'spawning', phase: 'spawn', phaseLabel: '启动 Java 进程', step: 6, total: 7 }),
    '正在启动游戏 · 6/7 启动 Java 进程'
  )
  assert.equal(launchPhaseText({ status: 'running' }), '游戏运行中')
  assert.equal(launchPhaseText({ status: 'failed' }), '启动失败')
  assert.equal(launchPhaseText({ status: 'cancelled' }), '已取消启动')
  assert.equal(launchPhaseText({ status: 'exited' }), '游戏已退出')
  assert.equal(launchPhaseText({ status: 'idle' }), '')
  assert.equal(launchPhaseText(null), '')
  // 没有 phaseLabel 时用内置中文兜底，不暴露英文 phase id。
  assert.equal(launchPhaseText({ status: 'preparing', phase: 'java', step: 0, total: 7 }), '正在准备启动 · 检查并选择 Java')
  // step 超过 total 时截断，避免出现 8/7。
  assert.equal(launchPhaseText({ status: 'preparing', phase: 'spawn', step: 9, total: 7 }), '正在准备启动 · 7/7 启动 Java 进程')
})

test('launchProgressInfo：只有真实进度才返回数字', () => {
  assert.deepEqual(launchProgressInfo({ status: 'preparing', progress: null, indeterminate: true }), { value: null, indeterminate: true })
  assert.deepEqual(launchProgressInfo({ status: 'preparing', progress: 37.5 }), { value: 37.5, indeterminate: false })
  assert.deepEqual(launchProgressInfo({ status: 'natives', progress: 130 }), { value: 100, indeterminate: false })
  assert.deepEqual(launchProgressInfo({ status: 'running' }), { value: 100, indeterminate: false })
  assert.deepEqual(launchProgressInfo({ status: 'failed', progress: 80 }), { value: null, indeterminate: true })
  assert.deepEqual(launchProgressInfo(null), { value: null, indeterminate: true })
})

test('normalizeLaunchError：兼容 Error 附加字段与 status.launch.error', () => {
  const err = new Error('缺少 3 个客户端文件')
  err.code = 'MISSING_FILES'
  err.detail = '客户端 JAR 与 2 个 library 缺失'
  err.missing = ['versions/1.21/client.jar', 'libraries/a.jar']
  err.missingCount = 3
  err.paths = { gameDir: 'C:/games/inst', versionJson: 'C:/games/versions/1.21/1.21.json' }
  const info = normalizeLaunchError(err)
  assert.equal(info.code, 'MISSING_FILES')
  assert.equal(info.message, '缺少 3 个客户端文件')
  assert.match(info.detail, /library/)
  assert.equal(info.missing.length, 2)
  assert.equal(info.missingCount, 3)
  assert.equal(info.paths.gameDir, 'C:/games/inst')
  assert.ok(info.actions.includes('repair'))
  // 复制按钮始终可用，避免面板没有可执行项。
  assert.ok(info.actions.includes('copy'))

  const fromLaunch = normalizeLaunchError({
    status: 'failed',
    phaseLabel: '校验客户端文件',
    error: { code: 'NO_JAVA', message: '没有可用的 Java', actions: ['select-java'] }
  })
  assert.equal(fromLaunch.code, 'NO_JAVA')
  assert.equal(fromLaunch.message, '没有可用的 Java')
  assert.deepEqual(fromLaunch.actions, ['select-java', 'copy'])
  assert.equal(fromLaunch.missingCount, 0)

  const fromStatus = normalizeLaunchError({ error: { code: 'VERSION_JSON_MISSING', message: '版本 JSON 缺失', detail: '找不到 1.21.json' } })
  assert.equal(fromStatus.message, '版本 JSON 缺失')
  assert.ok(fromStatus.actions.includes('repair'))
  assert.ok(fromStatus.actions.includes('open-logs'))

  assert.equal(normalizeLaunchError(null), null)
  const plain = normalizeLaunchError('纯文本失败原因')
  assert.equal(plain.message, '纯文本失败原因')
  assert.deepEqual(plain.actions, ['copy'])
})

test('normalizeLaunchError：错误码默认按钮与中文说明', () => {
  const java = normalizeLaunchError({ code: 'JAVA_TOO_OLD', message: 'Java 太旧' })
  assert.deepEqual(java.actions, ['select-java', 'open-logs', 'copy'])
  const crash = normalizeLaunchError({ code: 'GAME_CRASHED', message: '游戏崩溃' })
  assert.deepEqual(crash.actions, ['open-logs', 'copy'])
  const running = normalizeLaunchError({ code: 'ALREADY_RUNNING', message: '正在运行' })
  assert.ok(running.actions.includes('open-logs'))
  // 未知错误码回退到“修复 + 日志 + 复制”，仍然全部可操作。
  const unknown = normalizeLaunchError({ code: 'SOMETHING_NEW', message: '未知错误' })
  assert.deepEqual(unknown.actions, ['repair', 'open-logs', 'copy'])
})

test('launchErrorCopyText：复制内容包含摘要、缺失文件、路径与时间', () => {
  const err = new Error('启动失败：缺少文件')
  err.code = 'MISSING_FILES'
  err.missing = ['a.jar', 'b.jar']
  err.missingCount = 2
  err.paths = { gameDir: 'C:/g', logsDir: 'C:/g/logs' }
  const info = normalizeLaunchError(err)
  const text = launchErrorCopyText(info, { name: '测试实例', mc: '1.21.8', loader: 'fabric', loaderName: 'Fabric' })
  assert.match(text, /【启动失败】测试实例（1\.21\.8 · fabric）/)
  assert.match(text, /错误代码：MISSING_FILES/)
  assert.match(text, /缺失文件（2）/)
  assert.match(text, /a\.jar/)
  assert.match(text, /游戏目录：C:\/g/)
  assert.match(text, /日志目录：C:\/g\/logs/)
  assert.match(text, /时间：\d{4}-\d{2}-\d{2}/)
  assert.equal(launchErrorCopyText(null), '')
})
