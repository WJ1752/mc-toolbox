// 本机群聊示例：任意端口的回环好友服务、临时会话，复用真正的桌面 UI。
import fs from 'node:fs/promises'
import { rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createFriendsServer } from './friends-server.mjs'
import { ClientStore } from '../src/server/friends/client-store.js'
import { FriendsServerClient } from '../src/server/friends/server-client.js'

const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'mc-toolbox-group-demo-'))
const relay = createFriendsServer({
  dataDir: scratch,
  http: true,
  verifyMinecraft: async () => { throw new Error('示例群仅使用预置的本地会话') }
})
await relay.ready()
await new Promise((resolve, reject) => relay.once('error', reject).listen(0, '127.0.0.1', resolve))
const url = 'http://127.0.0.1:' + relay.address().port
const owner = relay.store.createAccount({ uuid: randomUUID(), mcName: 'DemoHost', nickname: '示例服主' })
const member = relay.store.createAccount({ uuid: randomUUID(), mcName: 'DemoMember', nickname: '示例成员' })
owner.friends.push(member.uuid)
member.friends.push(owner.uuid)
const hostSession = relay.store.issueSession(owner.uuid)
const group = relay.store.createGroup(owner.uuid, { name: '周末生存示例群', members: [member.uuid] })
const profile = JSON.parse(await fs.readFile(new URL('../examples/group-profile.json', import.meta.url), 'utf8'))
const hostClient = new FriendsServerClient({ url, token: hostSession.token })
await hostClient.request('PUT', `/api/groups/${group.id}/join-profile`, { body: profile })

const asOwner = process.argv.includes('--owner')
const role = asOwner ? owner : member
const client = new ClientStore(path.join(scratch, 'client.json'))
client.setServer({ url, fingerprint: '', requiresInvite: false })
client.setSession({ ...(asOwner ? hostSession : relay.store.issueSession(member.uuid)), profile: role })
client.saveNow()
process.env.MC_TOOLBOX_FRIENDS_SERVER = url
process.env.MC_TOOLBOX_FRIENDS_FINGERPRINT = ''
process.env.MC_TOOLBOX_FRIENDS_CONFIG = client.file
process.env.MC_TOOLBOX_FRIENDS_INVITE_REQUIRED = '0'
process.env.MC_TOOLBOX_FRIENDS_RECEIVED = path.join(scratch, 'received')
if (!process.argv.some(arg => arg.startsWith('--port='))) process.argv.push('--port=8765')
console.log(`已准备本机示例群，当前身份为${role.nickname}。进入「好友 → 群聊 → 周末生存示例群 → 入服 · 周末服 1.0」。`)
console.log('游戏地址为本机 25565 端口，实际进服需要先启动对应的 Minecraft 服务器。')
// 只回收本次 mkdtemp 创建的会话目录。
process.once('exit', () => { try { rmSync(scratch, { recursive: true, force: true }) } catch {} })
await import('../server.js')
