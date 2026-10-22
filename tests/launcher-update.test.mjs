import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseVersion,
  compareVersions,
  pickRelease,
  pickAsset,
  buildUpdaterScript,
  UPDATE_DEFAULTS
} from '../src/server/launcher/app-update.js'

test('parseVersion accepts v-prefixed and prerelease tags', () => {
  assert.deepEqual(parseVersion('v1.9.2'), { major: 1, minor: 9, patch: 2, pre: '' })
  assert.deepEqual(parseVersion('1.9'), { major: 1, minor: 9, patch: 0, pre: '' })
  assert.deepEqual(parseVersion(' v2.0.0-beta.3 '), { major: 2, minor: 0, patch: 0, pre: 'beta.3' })
  assert.equal(parseVersion('release-latest'), null)
  assert.equal(parseVersion(''), null)
})

test('compareVersions orders numerically, not lexically', () => {
  assert.equal(compareVersions('1.9.2', '1.9.10'), -1)
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1)
  assert.equal(compareVersions('v1.9.2', '1.9.2'), 0)
  assert.equal(compareVersions('1.9.2', '1.9.2'), 0)
  // 正式版高于同号预发布版
  assert.equal(compareVersions('1.9.2', '1.9.2-beta.1'), 1)
  assert.equal(compareVersions('1.9.2-alpha', '1.9.2-beta'), -1)
  assert.equal(compareVersions('1.9.2-beta.2', '1.9.2-beta.10'), -1)
})

test('pickRelease ignores drafts and (by default) prereleases, picks highest', () => {
  const releases = [
    { tag_name: 'v1.8.0', draft: false, prerelease: false, assets: [] },
    { tag_name: 'v2.0.0', draft: true, prerelease: false, assets: [] },
    { tag_name: 'v1.9.5-rc.1', draft: false, prerelease: true, assets: [] },
    { tag_name: 'v1.9.4', draft: false, prerelease: false, assets: [] },
    { tag_name: 'nightly', draft: false, prerelease: false, assets: [] }
  ]
  assert.equal(pickRelease(releases).release.tag_name, 'v1.9.4')
  assert.equal(pickRelease(releases, { includePrerelease: true }).release.tag_name, 'v1.9.5-rc.1')
  assert.equal(pickRelease([]), null)
  assert.equal(pickRelease([{ tag_name: 'v1.0.0', draft: true }]), null)
})

test('pickAsset prefers mc-toolbox.exe and ignores non-exe assets', () => {
  const release = {
    assets: [
      { name: 'notes.txt', size: 10 },
      { name: 'mc-toolbox-other.exe', size: 20 },
      { name: 'mc-toolbox.exe', size: 30 }
    ]
  }
  assert.equal(pickAsset(release).name, 'mc-toolbox.exe')
  assert.equal(pickAsset({ assets: [{ name: 'a.exe' }, { name: 'b.exe' }] }).name, 'a.exe')
  assert.equal(pickAsset({ assets: [{ name: 'a.zip' }] }), null)
  assert.equal(pickAsset({}), null)
})

test('buildUpdaterScript embeds paths, waits for the launcher pid and rolls back', () => {
  const script = buildUpdaterScript({
    source: "C:\\Temp\\it's here\\mc-toolbox.exe",
    target: 'C:\\Program Files\\MC Toolbox\\mc-toolbox.exe',
    pid: 4321,
    log: 'C:\\Temp\\it\'s here\\apply.log',
    args: ['--no-open', '--port=8901']
  })
  assert.match(script, /waitPid = 4321/)
  // 单引号路径要翻转义，PowerShell 里用两个单引号
  assert.match(script, /it''s here/)
  // 重启时保留原启动参数
  assert.match(script, /\$argList = @\('--no-open', '--port=8901'\)/)
  assert.match(script, /Move-Item -LiteralPath \$dst -Destination \$bak/)
  assert.match(script, /Copy-Item -LiteralPath \$src -Destination \$dst/)
  assert.match(script, /rollback|rolled back/)
  // 空参数时不能传 -ArgumentList（PowerShell 会报参数为空）
  assert.match(script, /if \(\$argList\.Count -gt 0\)/)
  assert.match(script, /Start-Process -FilePath \$dst -ArgumentList \$argList/)
  assert.ok(script.split('\r\n').length > 15)
})

test('update defaults are conservative', () => {
  assert.equal(UPDATE_DEFAULTS.autoCheck, true)
  assert.equal(UPDATE_DEFAULTS.includePrerelease, false)
  assert.equal(UPDATE_DEFAULTS.token, '')
  assert.equal(UPDATE_DEFAULTS.skippedVersion, '')
})
