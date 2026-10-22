// 代理 B：启动阶段、结构化错误与实例路径布局的纯函数 / 可控路径测试。
// 不联网、不 spawn java；涉及实例清单的测试会在 finally 恢复 store。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  LAUNCH_PHASES,
  LAUNCH_ERROR_CODES,
  createLaunchError,
  publicLaunchState,
  phaseLabel
} from '../src/server/launcher/launch-phases.js'
import {
  launcherRoot,
  instancePaths,
  ensureInstanceDirs,
  publicInstance
} from '../src/server/launcher/state.js'
import { classifyJava, classifyMissingFiles, prepareLaunch } from '../src/server/launcher/launch.js'

const ACTIONS = ['repair', 'select-java', 'open-game-dir', 'open-logs', 'copy']
const CHINESE = /[\u4e00-\u9fa5]/

test('启动阶段顺序与中文标签固定', () => {
  assert.deepEqual(LAUNCH_PHASES.map((item) => item.id), [
    'account', 'version', 'java', 'files', 'natives', 'spawn', 'window'
  ])
  assert.deepEqual(LAUNCH_PHASES.map((item) => item.label), [
    '校验账户', '解析版本与继承链', '检查并选择 Java', '校验客户端文件',
    '解压 natives', '启动 Java 进程', '等待游戏窗口出现'
  ])
  for (const phase of LAUNCH_PHASES) assert.match(phase.label, CHINESE)
  assert.equal(phaseLabel('files'), '校验客户端文件')
  assert.equal(phaseLabel('natives'), '解压 natives')
  assert.equal(phaseLabel('not-a-phase'), '')
})

test('createLaunchError 覆盖全部错误码，含中文摘要、actions 与 paths', () => {
  const paths = {
    gameDir: 'C:/game',
    logsDir: 'C:/logs',
    versionJson: 'C:/versions/1.21.8/1.21.8.json',
    clientJar: 'C:/versions/1.21.8/1.21.8.jar',
    baseDir: 'C:/base',
    secretFile: 'C:/do-not-leak'
  }
  for (const code of Object.values(LAUNCH_ERROR_CODES)) {
    const error = createLaunchError(code, {
      paths,
      missing: ['客户端 JAR：a.jar', '库文件：b.jar'],
      missingCount: 5
    })
    assert.equal(error.code, code, code)
    assert.match(error.message, CHINESE, code)
    assert.match(error.detail, CHINESE, code)
    assert.ok(Array.isArray(error.actions) && error.actions.length > 0, code)
    assert.ok(error.actions.every((action) => ACTIONS.includes(action)), code)
    assert.deepEqual(error.missing, ['客户端 JAR：a.jar', '库文件：b.jar'])
    assert.equal(error.missingCount, 5)
    assert.equal(error.paths.gameDir, 'C:/game')
    assert.equal(error.paths.logsDir, 'C:/logs')
    assert.equal(error.paths.versionJson, paths.versionJson)
    assert.equal(error.paths.clientJar, paths.clientJar)
    assert.equal(error.paths.baseDir, 'C:/base')
    // 只暴露约定的路径键，不把任意字段塞给前端。
    assert.equal(error.paths.secretFile, undefined)
  }

  const missing = createLaunchError('MISSING_FILES', { missing: ['x'], missingCount: 3 })
  assert.match(missing.message, /缺少 3 个文件/)
  const crashed = createLaunchError('GAME_CRASHED', { missing: ['a'], missingCount: 99 })
  assert.equal(crashed.missing.length, 1)
  assert.equal(crashed.missingCount, 99)
})

test('publicLaunchState 不泄漏内部字段，progress 为 null 时 indeterminate 为 true', () => {
  const state = {
    instanceId: 'inst-1',
    status: 'preparing',
    phase: 'files',
    step: 4,
    total: 7,
    detail: '正在检查客户端文件…',
    progress: null,
    indeterminate: false,
    startedAt: 1000,
    updatedAt: 2000,
    cancellable: true,
    error: createLaunchError('NO_JAVA', { paths: { gameDir: 'C:/game', logsDir: 'C:/logs' } }),
    logFile: 'C:/logs/launch.log',
    pid: 0,
    proc: { pid: 4321 },
    controller: new AbortController(),
    session: { secret: 'session-internal' },
    secret: 'internal'
  }
  const pub = publicLaunchState(state)
  assert.equal(pub.instanceId, 'inst-1')
  assert.equal(pub.status, 'preparing')
  assert.equal(pub.phase, 'files')
  assert.equal(pub.phaseLabel, '校验客户端文件')
  assert.equal(pub.step, 4)
  assert.equal(pub.total, 7)
  assert.equal(pub.progress, null)
  assert.equal(pub.indeterminate, true)
  assert.equal(pub.error.code, 'NO_JAVA')
  assert.equal(pub.error.paths.gameDir, 'C:/game')
  for (const key of ['proc', 'controller', 'session', 'secret']) {
    assert.equal(key in pub, false, key)
  }
  assert.equal(JSON.stringify(pub).includes('session-internal'), false)
  assert.equal(JSON.stringify(pub).includes('4321'), false)
  assert.equal(JSON.stringify(pub).includes('stack'), false)

  const withProgress = publicLaunchState({ ...state, progress: 42, indeterminate: true })
  assert.equal(withProgress.progress, 42)
  assert.equal(withProgress.indeterminate, false)
  assert.equal(publicLaunchState(null), null)
})

test('外部实例路径指向外部根，ensureInstanceDirs 不写外部 gameDir 子目录', async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'mc-toolbox-launch-state-'))
  const root = launcherRoot()
  const base = path.join(tmp, '.minecraft')
  const id = `b-test-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
  await fsp.mkdir(path.join(base, 'versions', '1.20.1'), { recursive: true })
  await fsp.mkdir(path.join(base, 'libraries'), { recursive: true })
  const inst = {
    id,
    name: '外部实例',
    mc: '1.20.1',
    mcSource: 'jar',
    loader: 'vanilla',
    versionId: '1.20.1',
    jarVersion: '1.20.1',
    baseDir: base,
    gameDir: base,
    external: true,
    memory: { min: 1024, max: 2048 }
  }
  try {
    const paths = instancePaths(inst)
    assert.equal(paths.librariesDir, path.join(base, 'libraries'))
    assert.equal(paths.assetsDir, path.join(base, 'assets'))
    assert.equal(paths.versionsDir, path.join(base, 'versions'))
    assert.equal(paths.versionDir, path.join(base, 'versions', '1.20.1'))
    assert.equal(paths.versionJson, path.join(base, 'versions', '1.20.1', '1.20.1.json'))
    assert.equal(paths.jarVersion, '1.20.1')
    assert.ok(paths.clientJarCandidates.includes(path.join(base, 'versions', '1.20.1', '1.20.1.jar')))
    assert.ok(paths.nativesDir.startsWith(path.join(root, 'instances', id)))
    assert.ok(paths.logsDir.startsWith(path.join(root, 'instances', id)))

    const pub = publicInstance(inst)
    assert.equal(pub.mcSource, 'jar')
    assert.ok(Array.isArray(pub.paths.clientJarCandidates))
    assert.equal(pub.paths.versionDir, paths.versionDir)

    ensureInstanceDirs(inst)
    for (const dir of ['mods', 'resourcepacks', 'shaderpacks', 'saves', 'screenshots']) {
      assert.equal(fs.existsSync(path.join(base, dir)), false, `不应创建外部 ${dir}`)
    }
    assert.equal(fs.existsSync(path.join(root, 'instances', id, 'game')), false)
    assert.equal(fs.existsSync(paths.nativesDir), true)
    assert.equal(fs.existsSync(paths.logsDir), true)
  } finally {
    await fsp.rm(path.join(root, 'instances', id), { recursive: true, force: true })
    await fsp.rm(tmp, { recursive: true, force: true })
  }
})

test('启动错误分类：NO_JAVA / JAVA_TOO_OLD / MISSING_FILES / EXTERNAL_DIR_UNWRITABLE', () => {
  const paths = { gameDir: 'C:/game', logsDir: 'C:/logs', versionJson: 'C:/v.json' }
  assert.equal(classifyJava({ required: 21, discovered: [{ major: 21, path: 'C:/j21/bin/java.exe' }], paths }), null)
  assert.equal(classifyJava({ required: 17, discovered: [{ major: 21, path: 'C:/j21/bin/java.exe' }], paths }), null)

  const tooOld = classifyJava({
    required: 21,
    discovered: [
      { major: 8, version: '1.8.0_402', path: 'C:/j8/bin/java.exe' },
      { major: 17, version: '17.0.9', path: 'C:/j17/bin/java.exe' }
    ],
    paths
  })
  assert.equal(tooOld.code, 'JAVA_TOO_OLD')
  assert.match(tooOld.message, CHINESE)
  assert.match(tooOld.detail, /Java 8/)
  assert.match(tooOld.detail, /Java 17/)
  assert.ok(tooOld.actions.includes('select-java'))

  const noJava = classifyJava({ required: 21, discovered: [], paths })
  assert.equal(noJava.code, 'NO_JAVA')
  assert.match(noJava.message, /Java 21/)

  const missing = classifyMissingFiles({
    missing: ['客户端 JAR：C:/v/1.21.8.jar', '库文件：a/b/c.jar'],
    missingCount: 9,
    external: false,
    paths
  })
  assert.equal(missing.code, 'MISSING_FILES')
  assert.equal(missing.missingCount, 9)
  assert.equal(missing.missing.length, 2)
  assert.ok(missing.actions.includes('repair'))
  assert.match(missing.message, /缺少 9 个文件/)

  const unwritable = classifyMissingFiles({
    external: true,
    gameDirWritable: false,
    paths
  })
  assert.equal(unwritable.code, 'EXTERNAL_DIR_UNWRITABLE')
  assert.match(unwritable.message, /不可写/)
  assert.ok(unwritable.actions.includes('open-game-dir'))
})

test('prepareLaunch 在版本 JSON 缺失时返回 VERSION_JSON_MISSING（注入假账户 / Java，不 spawn）', async () => {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'mc-toolbox-launch-version-'))
  const id = `b-version-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
  const base = path.join(tmp, '.minecraft')
  await fsp.mkdir(base, { recursive: true })
  const inst = {
    id,
    name: '版本缺失测试',
    mc: '1.21.8',
    loader: 'vanilla',
    versionId: '1.21.8',
    jarVersion: '1.21.8',
    baseDir: base,
    gameDir: base,
    external: true,
    memory: { min: 1024, max: 2048 },
    created: Date.now(),
    updated: Date.now()
  }
  try {
    await assert.rejects(
      () => prepareLaunch(id, {
        instance: inst,
        account: { id: 'fake', type: 'offline', name: 'Tester', uuid: '0'.repeat(32), accessToken: '0'.repeat(32) },
        java: { path: path.join(tmp, 'fake-java.exe'), major: 21, version: '21.0.1' }
      }),
      (error) => {
        assert.equal(error.code, 'VERSION_JSON_MISSING')
        assert.match(error.message, CHINESE)
        assert.ok(error.detail.includes('1.21.8.json'))
        assert.ok(error.paths.versionJson.endsWith(path.join('versions', '1.21.8', '1.21.8.json')))
        assert.ok(error.actions.includes('repair'))
        return true
      }
    )
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true })
  }
})
