// 好友服务器内置配置：普通玩家不能修改地址，界面上也不显示。
//
// 只有开发/自动化测试可以通过环境变量临时指向本地服务器；发布版仍然使用
// 下面这组官方地址与证书指纹。换服务器/换证书需要改这里并重新构建启动器。
export const BUILTIN_FRIENDS_SERVER = Object.freeze({
  url: 'https://139.224.132.80',
  fingerprint: '8A:87:B0:0E:75:59:17:D1:9B:74:6A:0E:8F:C1:8B:DC:6C:F3:AA:A5:79:6B:4F:04:04:8A:73:C6:BE:10:6D:B5'
})

export function normalizeFingerprint(value) {
  return String(value || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase()
}

export function resolveFriendsServer(env = process.env) {
  const url = String(env.MC_TOOLBOX_FRIENDS_SERVER ?? BUILTIN_FRIENDS_SERVER.url)
    .trim()
    .replace(/\/+$/, '')
  const fingerprint = String(env.MC_TOOLBOX_FRIENDS_FINGERPRINT ?? BUILTIN_FRIENDS_SERVER.fingerprint).trim()
  return {
    url,
    fingerprint,
    requiresInvite: env.MC_TOOLBOX_FRIENDS_INVITE_REQUIRED !== '0',
    locked: true
  }
}

export function sameFriendsServer(a, b) {
  return !!a && !!b
    && String(a.url || '') === String(b.url || '')
    && normalizeFingerprint(a.fingerprint) === normalizeFingerprint(b.fingerprint)
    && (a.requiresInvite === true) === (b.requiresInvite === true)
}
