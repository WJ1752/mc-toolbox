// 启动命令预览必须把令牌脱敏：微软/Xbox 令牌、旧版 --session 都不能出现在
// UI、复制内容或 /status 里。
import test from 'node:test'
import assert from 'node:assert/strict'

import { previewCommand } from '../src/server/launcher/launch-plan.js'

const TOKEN = 'SECRET-TOKEN-123456'

function plan(overrides = {}) {
  return {
    jvmArgs: ['-Xmx2G'],
    mainClass: 'net.minecraft.client.main.Main',
    gameArgs: ['--username', 'Steve', '--gameDir', 'game'],
    vars: { auth_access_token: TOKEN, auth_session: TOKEN },
    ...overrides
  }
}

test('现代参数：--accessToken 后面的令牌被替换', () => {
  const text = previewCommand({
    ...plan(),
    gameArgs: ['--username', 'Steve', '--accessToken', TOKEN, '--uuid', 'abc']
  })
  assert.ok(text.includes('<access token>'))
  assert.ok(!text.includes(TOKEN))
})

test('旧版参数：--session ${auth_session} 不再泄漏令牌', () => {
  const text = previewCommand({
    ...plan(),
    gameArgs: ['--username', 'Steve', '--session', TOKEN, '--gameDir', 'game']
  })
  assert.ok(!text.includes(TOKEN))
  assert.ok(text.includes('<access token>'))
})

test('连写形式 --accessToken=xxx 也被脱敏', () => {
  const text = previewCommand({
    ...plan(),
    gameArgs: ['--username', 'Steve', `--accessToken=${TOKEN}`]
  })
  assert.ok(!text.includes(TOKEN))
  assert.ok(text.includes('--accessToken=<access token>'))
})

test('JVM 参数里出现令牌时同样脱敏', () => {
  const text = previewCommand({
    ...plan(),
    jvmArgs: [`-Dsome.token=${TOKEN}`]
  })
  assert.ok(!text.includes(TOKEN))
})
