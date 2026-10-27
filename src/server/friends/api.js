// 好友功能 REST 接口（中心服务器模式）。
import fsp from 'node:fs/promises'
import * as manager from './manager.js'

export function registerFriendsApi(on, { readBody } = {}) {
  const body = async (req) => (typeof readBody === 'function' ? await readBody(req) : {})

  on('GET', '/api/friends', async () => await manager.snapshot())
  on('GET', '/api/friends/notifications', async () => await manager.notifications())
  on('GET', '/api/friends/diagnostics', async () => await manager.diagnostics())
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
      groupId: payload.groupId,
      targets: Array.isArray(payload.targets) ? payload.targets : null,
      instanceId: payload.instanceId,
      format: payload.format === 'zip' ? 'zip' : 'mrpack',
      includeSaves: payload.includeSaves === true,
      includeScreenshots: payload.includeScreenshots === true
    })
  })

  // ---------------- 群聊 ----------------
  on('GET', '/api/friends/groups', async () => await manager.listGroups())
  on('POST', '/api/friends/groups', async (req) => await manager.createGroup(await body(req)))
  on('POST', '/api/friends/groups/:id/members', async (req, params) => {
    const payload = await body(req)
    return await manager.addGroupMember(params.id, payload.uuid)
  })
  on('DELETE', '/api/friends/groups/:id/members/:uuid', async (_req, params) => await manager.removeGroupMember(params.id, params.uuid))
  on('DELETE', '/api/friends/groups/:id', async (_req, params) => await manager.leaveGroup(params.id))
  on('GET', '/api/friends/groups/:id/messages', async (_req, params, query) => await manager.groupMessages(params.id, {
    after: Number(query.after) || 0,
    markRead: query.markRead === '1'
  }))
  on('POST', '/api/friends/groups/:id/messages', async (req, params) => {
    const payload = await body(req)
    return await manager.sendGroupMessage(params.id, payload.text)
  })
  on('POST', '/api/friends/groups/:id/read', async (req, params) => {
    const payload = await body(req)
    return await manager.markGroupRead(params.id, payload.upTo)
  })

  // ---------------- 聊天图片 ----------------
  on('POST', '/api/friends/files/send', async (req) => await manager.sendFile(await body(req)))
  on('POST', '/api/friends/images', async (req) => await manager.sendImage(await body(req)))
  on('GET', '/api/friends/images/:id', async (_req, params, _query, res) => {
    const meta = await manager.imageFor(params.id)
    const data = await fsp.readFile(meta.file)
    res.writeHead(200, {
      'Content-Type': meta.mime || 'image/png',
      'Content-Length': data.length,
      'Cache-Control': 'private, max-age=86400'
    })
    res.end(data)
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

  on('POST', '/api/friends/transfers/:id/download', async (req, params) => {
    const payload = await body(req)
    return await manager.downloadFile(params.id, { dir: payload.dir, instanceId: payload.instanceId })
  })
  on('POST', '/api/friends/transfers/clear-finished', async () => manager.clearFinishedTransfers())
  on('DELETE', '/api/friends/transfers/:id', async (_req, params) => await manager.cancelFile(params.id))
  on('POST', '/api/friends/received/clear', async () => await manager.clearReceived())
  on('POST', '/api/friends/received/:id/save-as', async (req, params) => {
    const payload = await body(req)
    return await manager.saveReceivedAs(params.id, { dir: payload.dir, name: payload.name })
  })
  on('POST', '/api/friends/received/:id/apply', async (req, params) => {
    const payload = await body(req)
    return await manager.applyReceivedToInstance(params.id, payload.instanceId)
  })
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
