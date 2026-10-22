// 启动阶段、结构化错误与可公开的启动状态。
//
// launch.js 负责真正的准备 / 启动流程，这里只放前后端共享的常量与纯函数：
//   - LAUNCH_PHASES  阶段顺序（账户 → 版本 → Java → 文件 → natives → 进程 → 窗口）
//   - LAUNCH_ERROR_CODES / createLaunchError  统一的中文错误、缺失文件与操作按钮
//   - publicLaunchState  去掉 proc / AbortController 等内部字段后返回给前端

export const LAUNCH_PHASES = [
  { id: 'account', label: '校验账户' },
  { id: 'version', label: '解析版本与继承链' },
  { id: 'java', label: '检查并选择 Java' },
  { id: 'files', label: '校验客户端文件' },
  { id: 'natives', label: '解压 natives' },
  { id: 'spawn', label: '启动 Java 进程' },
  { id: 'window', label: '等待游戏窗口出现' }
]

export const LAUNCH_ERROR_CODES = {
  NO_ACCOUNT: 'NO_ACCOUNT',
  NO_JAVA: 'NO_JAVA',
  JAVA_TOO_OLD: 'JAVA_TOO_OLD',
  VERSION_JSON_MISSING: 'VERSION_JSON_MISSING',
  MISSING_FILES: 'MISSING_FILES',
  EXTERNAL_DIR_UNWRITABLE: 'EXTERNAL_DIR_UNWRITABLE',
  ALREADY_RUNNING: 'ALREADY_RUNNING',
  SPAWN_FAILED: 'SPAWN_FAILED',
  GAME_CRASHED: 'GAME_CRASHED',
  GAME_EXITED: 'GAME_EXITED'
}

// 前端只认识这些操作按钮；顺序按使用频率排列。
const ERROR_DEFINITIONS = {
  NO_ACCOUNT: {
    message: '还没有选择账户，无法启动游戏。',
    detail: '启动器需要账户信息来填写用户名与访问令牌。请先在启动器里添加离线 / 微软 / 第三方账户，并选中要使用的账户。',
    actions: ['copy']
  },
  NO_JAVA: {
    message: '未找到可用的 64 位 Java。',
    detail: '游戏需要 64 位 Java 运行时，但启动器在本机没有找到可用版本。可在启动器设置中下载 Java，或在实例设置里手动选择 java.exe。',
    actions: ['select-java', 'open-logs', 'copy']
  },
  JAVA_TOO_OLD: {
    message: '本机 Java 版本过旧，无法启动该版本。',
    detail: '游戏要求的 Java 版本高于本机已安装的运行时。请安装 64 位新版 Java（推荐 21），或在实例设置中选择兼容的 Java。',
    actions: ['select-java', 'copy']
  },
  VERSION_JSON_MISSING: {
    message: '版本 JSON 缺失，无法启动。',
    detail: '启动器找不到该实例对应的版本 JSON，可能是实例目录被移动、版本被删除或安装尚未完成。请执行“检查并修复文件”，或重新安装该版本。',
    actions: ['repair', 'open-game-dir', 'copy']
  },
  MISSING_FILES: {
    message: '游戏文件不完整，无法启动。',
    detail: '客户端 JAR、库文件或资源文件缺失。请执行“检查并修复文件”补齐后再启动。',
    actions: ['repair', 'open-game-dir', 'open-logs', 'copy']
  },
  EXTERNAL_DIR_UNWRITABLE: {
    message: '外部游戏目录不可写，无法启动。',
    detail: '导入的外部实例目录只读或权限不足，游戏无法保存配置与存档。请检查目录权限，或在实例设置中改用启动器隔离目录。',
    actions: ['open-game-dir', 'copy']
  },
  ALREADY_RUNNING: {
    message: '该实例已经在运行或正在准备启动。',
    detail: '请等待当前启动完成，或先停止游戏后再试。',
    actions: ['open-logs']
  },
  SPAWN_FAILED: {
    message: '启动 Java 进程失败。',
    detail: '系统未能创建游戏进程，常见原因是 Java 路径失效、内存参数过大或被安全软件拦截。',
    actions: ['select-java', 'open-logs', 'copy']
  },
  GAME_CRASHED: {
    message: '游戏异常退出（检测到崩溃报告）。',
    detail: '游戏启动后异常退出，日志目录中检测到了崩溃报告。请打开日志 / 崩溃报告查看原因，或尝试“检查并修复文件”。',
    actions: ['open-logs', 'copy']
  },
  GAME_EXITED: {
    message: '游戏异常退出。',
    detail: '游戏进程以非 0 状态退出，但没有找到崩溃报告。请打开日志查看最后输出。',
    actions: ['open-logs', 'copy']
  }
}

const DEFAULT_ERROR = {
  message: '启动失败。',
  detail: '启动过程中发生未知错误，请打开日志查看详细信息。',
  actions: ['open-logs', 'copy']
}

const PATH_KEYS = ['gameDir', 'logsDir', 'versionJson', 'clientJar', 'baseDir']

function pickPaths(paths = {}) {
  const out = {}
  if (!paths || typeof paths !== 'object') return out
  for (const key of PATH_KEYS) {
    const value = paths[key]
    if (typeof value === 'string' && value) out[key] = value
  }
  return out
}

function normalizeMissing(missing) {
  if (!Array.isArray(missing)) return []
  return missing.map((item) => String(item ?? '')).filter(Boolean)
}

/**
 * 创建带中文摘要、详细原因与可操作按钮的错误。
 * 调用方可以覆盖 message/detail，并补充 missing、missingCount、paths、cause。
 */
export function createLaunchError(code, options = {}) {
  const key = String(code || '')
  const definition = ERROR_DEFINITIONS[key] || DEFAULT_ERROR
  const missing = normalizeMissing(options.missing)
  const missingCount = Number(options.missingCount)
  const totalMissing = Number.isFinite(missingCount) && missingCount > 0 ? missingCount : missing.length
  let message = String(options.message || definition.message || DEFAULT_ERROR.message)
  if (!options.message && key === LAUNCH_ERROR_CODES.MISSING_FILES && totalMissing > 0) {
    message = `游戏文件不完整，缺少 ${totalMissing} 个文件，请执行“检查并修复文件”。`
  }
  if (!options.message && key === LAUNCH_ERROR_CODES.GAME_EXITED && options.exitCode !== undefined && options.exitCode !== null) {
    message = `游戏异常退出（退出码 ${options.exitCode}）。`
  }
  const detail = String(options.detail || definition.detail || DEFAULT_ERROR.detail)
  const actions = Array.isArray(options.actions)
    ? options.actions.filter((item) => typeof item === 'string')
    : (definition.actions || DEFAULT_ERROR.actions).slice()

  const error = new Error(message)
  error.name = 'LaunchError'
  error.code = key || 'LAUNCH_FAILED'
  error.detail = detail
  error.missing = missing.slice(0, 20)
  error.missingCount = totalMissing
  error.paths = pickPaths(options.paths)
  error.actions = actions
  error.crash = options.crash || null
  if (options.cause) error.cause = options.cause
  return error
}

function publicLaunchError(error) {
  if (!error) return null
  const missing = normalizeMissing(error.missing)
  return {
    code: String(error.code || ''),
    message: String(error.message || '启动失败。'),
    detail: String(error.detail || ''),
    missing: missing.slice(0, 20),
    missingCount: Number(error.missingCount) > 0 ? Number(error.missingCount) : missing.length,
    paths: pickPaths(error.paths),
    actions: Array.isArray(error.actions) ? error.actions.filter((item) => typeof item === 'string') : [],
    crash: error.crash || null
  }
}

/** 去掉 proc / controller / session 等内部字段，供 API 直接返回。 */
export function publicLaunchState(state) {
  if (!state) return null
  const progress = Number.isFinite(state.progress)
    ? Math.max(0, Math.min(100, Math.round(Number(state.progress))))
    : null
  const phase = String(state.phase || '')
  const phaseIndex = LAUNCH_PHASES.findIndex((item) => item.id === phase)
  return {
    instanceId: String(state.instanceId || ''),
    status: String(state.status || 'idle'),
    phase,
    phaseLabel: phase ? phaseLabel(phase) : '',
    step: Number(state.step) > 0 ? Number(state.step) : (phaseIndex >= 0 ? phaseIndex + 1 : 0),
    total: Number(state.total) > 0 ? Number(state.total) : LAUNCH_PHASES.length,
    detail: String(state.detail || ''),
    progress,
    // 有真实进度时就是确定进度；null 时一律按不确定进度处理。
    indeterminate: progress === null,
    startedAt: Number(state.startedAt) || 0,
    updatedAt: Number(state.updatedAt) || 0,
    cancellable: state.cancellable === true,
    error: publicLaunchError(state.error),
    logFile: String(state.logFile || ''),
    pid: Number(state.pid) || 0
  }
}

export function phaseLabel(id) {
  const phase = LAUNCH_PHASES.find((item) => item.id === id)
  return phase ? phase.label : ''
}
