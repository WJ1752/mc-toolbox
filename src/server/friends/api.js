// 好友功能 REST 接口（中心服务器模式）。
import * as manager from './manager.js'

export function registerFriendsApi(on, { readBody } = {}) {
  const body = async (req) => (typeof readBody === 'function' ? await readBody(req) : {})

  on('GET', '/api/friends', async () => await manager.snapshot())
  on('GET', '/api/friends/diagnostics', async () => await manager.diagnostics())

  on('POST', '/api/friends/server/probe', async (req) => {
    const payload = await body(req)
    return await manager.probeServer(payload.url)
  })
  on('PUT', '/api/friends/server', async (req) => await manager.saveServer(await body(req)))
  on('POST', '/api/friends/login', async (req) => await manager.login(await body(req)))
  on('POST', '/api/friends/logout', async () => await manager.logout())
  on('POST', '/api/friends/session/refresh', async () => await manager.login({}))
  on('PUT', '/api/friends/self', async (req) => await manager.saveSelf(await body(req)))

  on('POST', '/api/friends/add', async (req) => await manager.addFriend((await body(req)).mcName))
  on('POST', '/api/friends/respond', async (req) => {
    const payload = await body(req)
    return await manager.respondFriend(payload.uuid, payload.accept === true)
  })

  on('POST', '/api/friends/packs/share', async (req) => {
    const payload = await body(req)
    return await manager.sharePack({
      friendId: payload.friendId,
      instanceId: payload.instanceId,
      format: payload.format === 'zip' ? 'zip' : 'mrpack',
      includeSaves: payload.includeSaves === true,
      includeScreenshots: payload.includeScreenshots === true
    })
  })

  on('POST', '/api/friends/mods/compare', async (req) => await manager.compareMods(await body(req)))
  on('POST', '/api/friends/mods/fill', async (req) => await manager.startModsFill(await body(req)))
  on('POST', '/api/friends/mods/send', async (req) => await manager.sendModsToFriend(await body(req)))
  on('GET', '/api/friends/mods/jobs/:id', async (_req, params) => {
    const job = manager.getModsJob(params.id)
    if (!job) throw new Error('补齐任务不存在')
    return job
  })
  on('POST', '/api/friends/mods/jobs/:id/cancel', async (_req, params) => ({
    ok: manager.cancelModsJob(params.id)
  }))

  on('POST', '/api/friends/transfers/:id/download', async (_req, params) => await manager.downloadFile(params.id))
  on('DELETE', '/api/friends/transfers/:id', async (_req, params) => await manager.cancelFile(params.id))
  on('DELETE', '/api/friends/received/:id', async (_req, params) => ({
    ok: await manager.removeReceived(params.id)
  }))

  on('GET', '/api/friends/:uuid/messages', async (_req, params, query) => await manager.messages(params.uuid, {
    after: Number(query.after) || 0,
    markRead: query.markRead === '1'
  }))
  on('POST', '/api/friends/:uuid/messages', async (req, params) => {
    const payload = await body(req)
    return await manager.sendMessage(params.uuid, payload.text)
  })
  on('POST', '/api/friends/:uuid/read', async (req, params) => {
    const payload = await body(req)
    return await manager.markRead(params.uuid, payload.upTo)
  })

  on('DELETE', '/api/friends/:uuid', async (_req, params) => await manager.removeFriend(params.uuid))
}
