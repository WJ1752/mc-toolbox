import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import {
  normalizeOs,
  rulesAllow,
  combineVersions,
  collectLibraries,
  parseMavenName,
  mavenPath,
  flattenArguments,
  splitArgs,
  substitute,
  requiredJavaMajor,
  javaCompatible,
  offlineUuid,
  splitServerAddress,
  buildLaunchPlan,
  previewCommand,
  analyzeCrash
} from '../src/server/launcher/launch-plan.js'

const win = normalizeOs({ platform: 'win32', arch: 'x64', release: '10.0.19045' })

test('Mojang rules: OS, arch, features and disallow precedence', () => {
  assert.equal(rulesAllow(null, { os: win }), true)
  assert.equal(rulesAllow([{ action: 'allow', os: { name: 'windows' } }], { os: win }), true)
  assert.equal(rulesAllow([{ action: 'allow', os: { name: 'linux' } }], { os: win }), false)
  assert.equal(rulesAllow([{ action: 'allow', os: { arch: 'x86_64' } }], { os: win }), true)
  assert.equal(rulesAllow([{ action: 'allow', os: { arch: 'x86' } }], { os: win }), false)
  assert.equal(rulesAllow([{ action: 'allow', features: { has_custom_resolution: true } }], { os: win, features: {} }), false)
  assert.equal(rulesAllow([
    { action: 'allow' },
    { action: 'disallow', os: { name: 'windows' } }
  ], { os: win }), false)
})

test('version inheritance merges libraries, arguments and logging', () => {
  const parent = {
    id: '1.20.1',
    mainClass: 'net.minecraft.client.main.Main',
    type: 'release',
    assetIndex: { id: '5' },
    javaVersion: { majorVersion: 17 },
    logging: { client: { argument: '-Dlog4j.configurationFile=${path}', file: { id: 'client.xml' } } },
    libraries: [{ name: 'a:a:1' }, { name: 'parent:only:1' }],
    arguments: {
      jvm: ['-Dparent=1', '-cp', '${classpath}'],
      game: [{ rules: [{ action: 'allow', features: { has_custom_resolution: true } }], value: ['--width', '${resolution_width}'] }]
    }
  }
  const child = {
    id: '1.20.1-forge-47.4.0',
    inheritsFrom: '1.20.1',
    mainClass: 'cpw.mods.bootstraplauncher.BootstrapLauncher',
    logging: {},
    libraries: [{ name: 'a:a:1' }, { name: 'forge:only:1' }],
    arguments: { jvm: ['-Dforge=1'], game: ['--launchTarget', 'forgeclient'] }
  }
  const merged = combineVersions(child, parent)
  assert.equal(merged.id, child.id)
  assert.equal(merged.mainClass, child.mainClass)
  assert.equal(merged.assetIndex.id, '5')
  assert.equal(merged.logging.client.file.id, 'client.xml')
  assert.deepEqual(merged.libraries.map((lib) => lib.name), ['a:a:1', 'forge:only:1', 'parent:only:1'])
  assert.deepEqual(merged.arguments.jvm, ['-Dparent=1', '-cp', '${classpath}', '-Dforge=1'])
  assert.deepEqual(merged.arguments.game.slice(-2), ['--launchTarget', 'forgeclient'])
  assert.equal(merged.jar, '1.20.1')
})

test('maven coordinates and rules produce the right paths/artifacts', () => {
  assert.deepEqual(parseMavenName('com.example:demo:1.2.3:natives-windows@jar'), {
    group: 'com.example', artifact: 'demo', version: '1.2.3', classifier: 'natives-windows', ext: 'jar', name: 'com.example:demo:1.2.3:natives-windows@jar'
  })
  assert.equal(mavenPath('com.example:demo:1.2.3'), 'com/example/demo/1.2.3/demo-1.2.3.jar')
  const libs = collectLibraries({
    libraries: [
      { name: 'org.lwjgl:lwjgl:3.3.1', downloads: { artifact: { path: 'org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1.jar', url: 'https://libraries.minecraft.net/x.jar', sha1: 'a', size: 1 } } },
      { name: 'org.lwjgl:lwjgl:3.3.1:natives-windows', rules: [{ action: 'allow', os: { name: 'windows' } }] },
      { name: 'org.lwjgl:lwjgl:3.3.1:natives-linux', rules: [{ action: 'allow', os: { name: 'linux' } }] },
      { name: 'legacy:native:1', natives: { windows: 'natives-windows-${arch}' }, downloads: { classifiers: { 'natives-windows-64': { path: 'legacy/native/1/native-1-natives-windows-64.jar', url: 'https://libraries.minecraft.net/n.jar', sha1: 'b', size: 2 } } } }
    ]
  }, { os: win })
  assert.ok(libs.classpath.some((item) => item.path.endsWith('lwjgl-3.3.1.jar')))
  assert.ok(libs.classpath.some((item) => item.name.includes('natives-windows')))
  assert.ok(!libs.classpath.some((item) => item.name.includes('natives-linux')))
  assert.equal(libs.natives.length, 1)
  assert.equal(libs.natives[0].path, 'legacy/native/1/native-1-natives-windows-64.jar')
})

test('argument flattening, quoting and substitution', () => {
  const entries = [
    '-Dkeep=1',
    { rules: [{ action: 'allow', features: { is_demo_user: true } }], value: '--demo' },
    { rules: [{ action: 'allow' }], value: ['--width', '${resolution_width}'] }
  ]
  assert.deepEqual(flattenArguments(entries, { os: win, features: {} }), ['-Dkeep=1', '--width', '${resolution_width}'])
  assert.deepEqual(splitArgs('-Dmessage="hello world" -Dpath="C:/Java Path" plain'), ['-Dmessage=hello world', '-Dpath=C:/Java Path', 'plain'])
  assert.throws(() => splitArgs('"unclosed'), /引号/)
  assert.equal(substitute('${a}-${b}-${missing}', { a: 1, b: 2 }), '1-2-')
})

test('Java major detection and compatibility', () => {
  assert.equal(requiredJavaMajor({ javaVersion: { majorVersion: 25 } }, '26.2'), 25)
  assert.equal(requiredJavaMajor({}, '1.20.1'), 17)
  assert.equal(requiredJavaMajor({}, '1.17.1'), 16)
  assert.equal(requiredJavaMajor({}, '1.12.2'), 8)
  assert.equal(requiredJavaMajor({}, '1.21.4'), 21)
  assert.equal(javaCompatible(8, 8), true)
  assert.equal(javaCompatible(8, 17), false)
  assert.equal(javaCompatible(16, 17), true)
  assert.equal(javaCompatible(17, 21), true)
  assert.equal(javaCompatible(21, 25), true)
  assert.equal(javaCompatible(21, 17), false)
})

test('offline UUID matches Java UUID.nameUUIDFromBytes', () => {
  assert.equal(offlineUuid('Notch'), 'b50ad385-829d-3141-a216-7e7d7539ba7f')
})

test('server address parsing supports host:port and IPv6', () => {
  assert.deepEqual(splitServerAddress('mc.example.com'), { host: 'mc.example.com', port: '' })
  assert.deepEqual(splitServerAddress('mc.example.com:25565'), { host: 'mc.example.com', port: '25565' })
  assert.deepEqual(splitServerAddress('[2001:db8::1]:25566'), { host: '2001:db8::1', port: '25566' })
  assert.deepEqual(splitServerAddress('[2001:db8::1]'), { host: '2001:db8::1', port: '' })
})

test('buildLaunchPlan assembles classpath, natives, game args and Forge ignore list', () => {
  const version = {
    id: '1.20.1-forge-47.4.0',
    mainClass: 'cpw.mods.bootstraplauncher.BootstrapLauncher',
    type: 'release',
    assetIndex: { id: '5' },
    logging: { client: { argument: '-Dlog4j.configurationFile=${path}' } },
    libraries: [
      { name: 'lib:one:1', downloads: { artifact: { path: 'lib/one/1/one-1.jar', url: 'https://libraries.minecraft.net/one.jar', sha1: 'a', size: 1 } } },
      { name: 'legacy:native:1', natives: { windows: 'natives-windows-${arch}' }, downloads: { classifiers: { 'natives-windows-64': { path: 'legacy/native/natives-64.jar', url: 'https://libraries.minecraft.net/n.jar', sha1: 'b', size: 2 } } } }
    ],
    arguments: {
      jvm: ['-DignoreList=forge-,${version_name}.jar', '-DlibraryDirectory=${library_directory}', '-cp', '${classpath}'],
      game: ['--username', '${auth_player_name}', '--uuid', '${auth_uuid}', '--accessToken', '${auth_access_token}', '--version', '${version_name}']
    }
  }
  const paths = {
    libraries: 'C:\\root\\libraries',
    assets: 'C:\\root\\assets',
    assetIndexId: '5',
    gameDir: 'C:\\root\\game',
    nativesDir: 'C:\\root\\natives',
    clientJar: 'C:\\root\\versions\\1.20.1\\1.20.1.jar',
    versionName: '1.20.1-forge-47.4.0',
    logConfigFile: 'C:\\root\\assets\\log_configs\\client.xml'
  }
  const plan = buildLaunchPlan({
    version,
    paths,
    options: { minMemory: 1024, maxMemory: 4096, width: 1280, height: 720, server: 'mc.example.com:25565', jvmArgs: '-Dcustom=1', gameArgs: '--foo bar' },
    account: { type: 'offline', name: 'TestPlayer', uuid: 'bb77495aa7403169a23869654c8bd2c1', accessToken: 'secret', userType: 'legacy' },
    os: win,
    features: { has_custom_resolution: true }
  })
  assert.equal(plan.mainClass, version.mainClass)
  assert.ok(plan.classpath[0].endsWith(path.join('lib', 'one', '1', 'one-1.jar')))
  assert.equal(plan.classpath.at(-1), paths.clientJar)
  assert.ok(plan.jvmArgs.includes('-Xms1024M') && plan.jvmArgs.includes('-Xmx4096M'))
  assert.ok(plan.jvmArgs.includes('-Dcustom=1'))
  assert.ok(plan.jvmArgs.includes('-Dlog4j.configurationFile=C:\\root\\assets\\log_configs\\client.xml'))
  const ignore = plan.jvmArgs.find((arg) => arg.startsWith('-DignoreList='))
  assert.ok(ignore.includes('1.20.1.jar'))
  const game = plan.gameArgs.join(' ')
  assert.ok(game.includes('--username TestPlayer'))
  assert.ok(game.includes('--server mc.example.com'))
  assert.ok(game.includes('--port 25565'))
  assert.ok(game.includes('--width 1280'))
  assert.ok(game.includes('--foo bar'))
  assert.equal(plan.nativeJars.length, 1)
  const preview = previewCommand(plan, 'java')
  assert.ok(!preview.includes('secret'))
  assert.ok(preview.includes('<access token>'))
})

test('legacy minecraftArguments are split and substituted', () => {
  const version = {
    id: '1.7.10',
    mainClass: 'net.minecraft.client.main.Main',
    minecraftArguments: '--username ${auth_player_name} --gameDir ${game_directory} --assetsDir ${assets_root}',
    libraries: []
  }
  const plan = buildLaunchPlan({
    version,
    paths: {
      libraries: 'libs', assets: 'assets', assetIndexId: '1.7.10', gameDir: 'game',
      nativesDir: 'natives', clientJar: 'client.jar', versionName: '1.7.10'
    },
    options: {},
    account: { type: 'offline', name: 'Steve', uuid: 'x', accessToken: 'y' },
    os: win
  })
  assert.ok(plan.gameArgs.includes('Steve'))
  assert.ok(plan.gameArgs.includes('game'))
  assert.ok(plan.jvmArgs.includes('-cp'))
})

test('crash analysis recognizes common failures', () => {
  const hints = analyzeCrash('java.lang.OutOfMemoryError: Java heap space\njava.lang.UnsupportedClassVersionError')
  assert.ok(hints.some((hint) => hint.kind === 'memory'))
  assert.ok(hints.some((hint) => hint.kind === 'java'))
  const mods = analyzeCrash('java.lang.NoSuchMethodError: foo.Bar.baz()\nModResolutionException: missing')
  assert.ok(mods.some((hint) => hint.kind === 'mods'))
  assert.ok(mods.some((hint) => hint.kind === 'deps'))
  const graphics = analyzeCrash('GLFW error 65542: WGL: The driver does not appear to support OpenGL')
  assert.ok(graphics.some((hint) => hint.kind === 'graphics'))
})
