// 好友页（中心服务器模式）：正版 MC 账号登录、好友列表、聊天、临时文件中转与模组同步。
import { h, clear, fmtBytes, fmtAgo, fmtDateTime, fmtTime } from '../core/dom.js'
import { btn, input, select, toggle, progress, spinner, badge, dot, field } from '../ui/kit.js'
import { sectionCard, emptyBlock } from './ui.js'

const KIND_LABEL = { pack: '整合包', mod: '模组文件' }
const STATUS_LABEL = {
  exporting: '导出中',
  uploading: '上传中',
  ready: '等待对方接收',
  downloading: '接收中',
  done: '已接收',
  delivered: '已接收',
  failed: '失败',
  expired: '已过期',
  deleted: '已清理'
}

function avatarFor(name) {
  const text = String(name || '?').trim() || '?'
  const initial = Array.from(text)[0].toUpperCase()
  let hash = 0
  for (const char of text) hash = (hash * 31 + char.codePointAt(0)) >>> 0
  const hue = hash % 360
  return h('span', {
    class: 'lp-friend-avatar',
    style: { background: `hsl(${hue} 42% 30%)`, color: `hsl(${hue} 70% 82%)` },
    'aria-hidden': 'true'
  }, initial)
}

function ratioOf(item) {
  const total = Number(item.total) || Number(item.size) || 0
  if (!total) return item.status === 'done' || item.status === 'delivered' ? 100 : null
  const loaded = Number(item.loaded) || 0
  if (loaded) return Math.max(0, Math.min(100, Math.round((loaded / total) * 100)))
  return Math.max(0, Math.min(100, Number(item.progress) || 0))
}

export function createFriendsView(ctx) {
  let disposed = false
  let timer = null
  let busy = false
  let data = null
  let errorText = ''
  let mode = ''
  let settingsBuilt = false
  const refs = {}
  const chat = {
    friendId: '',
    messages: [],
    lastAt: 0,
    loading: false,
    sending: false,
    panel: null,
    head: null,
    log: null,
    area: null,
    sendBtn: null,
    nearBottom: true,
    lastFetchAt: 0
  }

  function toast(text, kind = 'info') {
    ctx.toast(text, kind)
  }

  function setError(text) {
    errorText = text || ''
    if (!refs.error) return
    refs.error.textContent = errorText
    refs.error.hidden = !errorText
  }

  // ---------------- 布局 ----------------

  function paintAll() {
    if (!data || mode !== 'friends') return
    paintFriends()
    paintRequests()
    paintTransfers()
    paintReceived()
    paintSettings()
    paintEvents()
    updateChatHead()
  }

  function buildLayout() {
    if (!refs.root || !data) return
    clear(refs.root)
    settingsBuilt = false
    mode = data.loggedIn ? 'friends' : 'login'
    refs.error = h('div', { class: 'lp-friends-error', hidden: true })
    refs.root.appendChild(refs.error)
    if (mode === 'login') buildLogin()
    else buildFriends()
    setError(errorText)
    if (mode === 'friends') paintAll()
  }

  function buildLogin() {
    const account = data?.mcAccount
    const premium = account?.type === 'microsoft'
    const configured = data?.configured !== false
    const invite = input({ value: '', placeholder: '服务器邀请码' })
    const error = h('div', { class: 'lp-friends-hint warn-text' }, data?.error || '')
    const login = btn('绑定正版账号并登录', {
      variant: 'primary',
      iconName: 'shield',
      disabled: !premium || !configured,
      onClick: async () => {
        login.disabled = true
        error.textContent = ''
        try {
          await ctx.api.friendsLogin(invite.value.trim())
          toast('已登录好友服务器', 'ok')
          await refreshData(true)
        } catch (e) {
          error.textContent = e.message
          if (e.code === 'INVITE_REQUIRED') invite.focus()
        } finally {
          login.disabled = false
        }
      }
    })
    refs.root.appendChild(sectionCard({
      title: '登录官方好友服务器',
      subtitle: '使用启动器当前的正版微软账户',
      body: h('div', { class: 'lp-friends-setup' },
        h('div', { class: 'lp-friends-kv-list' },
          h('div', { class: 'lp-friends-kv' }, h('span', { class: 'muted' }, '好友服务器'), h('span', {}, '官方服务器（内置）')),
          h('div', { class: 'lp-friends-kv' }, h('span', { class: 'muted' }, '连接'), h('span', {}, configured ? '已内置证书校验' : '配置不可用')),
          h('div', { class: 'lp-friends-kv' }, h('span', { class: 'muted' }, '启动器账户'), h('span', {}, account ? `${account.name}（${premium ? '正版微软' : account.type === 'offline' ? '离线' : '第三方'}）` : '未登录'))
        ),
        configured ? null : h('div', { class: 'lp-friends-hint warn-text' }, '内置好友服务器配置不可用，请更新启动器后再试。'),
        premium ? null : h('div', { class: 'lp-friends-hint warn-text' }, '好友功能只支持正版微软账户。请先在启动器里登录微软账户（离线/第三方账户无法通过 Minecraft 正版校验）。'),
        field('邀请码', invite, { hint: data.server?.requiresInvite ? '该服务器启用了邀请码，请向管理员索取' : '服务器没有启用邀请码，可留空' }),
        h('div', { class: 'lp-friends-hint' }, '好友服务器地址与证书由启动器内置，不能修改。'),
        error,
        h('div', { class: 'lp-friends-actions' }, login,
          premium ? null : btn('去登录微软账户', { variant: 'secondary', iconName: 'user', onClick: () => ctx.openAccounts?.() }))
      )
    }))
  }

  function buildFriends() {
    const profile = data.profile || data.account || {}
    const addInput = input({ value: '', placeholder: '对方的正版游戏 ID' })
    const add = btn('添加好友', {
      variant: 'primary',
      iconName: 'add',
      onClick: async () => {
        const name = addInput.value.trim()
        if (!name) return
        add.disabled = true
        try {
          await ctx.api.friendsAdd(name)
          addInput.value = ''
          toast('好友请求已发送', 'ok')
          await refreshData(true)
        } catch (error) {
          toast(error.message, 'err')
        } finally {
          add.disabled = false
        }
      }
    })
    addInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') add.click() })
    refs.friends = h('div', { class: 'lp-friends-list' })
    refs.chat = h('div', { class: 'lp-chat' })
    refs.requests = h('div', { class: 'lp-friends-list' })
    refs.transfers = h('div', { class: 'lp-friends-list' })
    refs.received = h('div', { class: 'lp-friends-list' })
    refs.settings = h('div', { class: 'lp-friends-settings' })
    refs.events = h('div', { class: 'lp-friends-events' })
    refs.root.append(
      h('div', { class: 'lp-friends-hero' },
        sectionCard({
          title: '我的好友资料',
          subtitle: '好友能看到正版 ID',
          body: h('div', { class: 'lp-friends-profile' },
            avatarFor(profile.nickname || profile.mcName),
            h('div', { class: 'lp-friend-main' },
              h('div', { class: 'lp-friend-top' }, h('b', {}, profile.nickname || profile.mcName || '未登录'), badge('正版', 'ok')),
              h('div', { class: 'lp-friend-meta' },
                h('span', { class: 'mono' }, profile.mcName || ''),
                h('span', { class: 'muted' }, profile.online ? '在线' : '离线')
              )
            ),
            h('div', { class: 'lp-friend-actions' },
              btn('退出登录', { size: 'sm', variant: 'ghost', onClick: async () => {
                try {
                  await ctx.api.friendsLogout()
                  await refreshData(true)
                } catch (error) {
                  toast(error.message, 'err')
                }
              } })
            )
          )
        }),
        sectionCard({
          title: '添加好友',
          subtitle: '按正版游戏 ID 查找',
          body: h('div', { class: 'lp-friends-setup' },
            field('正版 ID', addInput, { hint: '对方必须先登录过好友服务器；好友能看到彼此的真实正版 ID' }),
            h('div', { class: 'lp-friends-actions' }, add)
          )
        })
      ),
      h('div', { class: 'lp-friends-chat-layout' },
        sectionCard({ title: '好友', subtitle: '点击开始聊天', body: refs.friends, className: 'lp-friends-side' }),
        sectionCard({ title: '聊天', subtitle: '消息保存在服务器 · 离线也能收到', body: refs.chat, className: 'lp-friends-chat-main' })
      ),
      h('div', { class: 'lp-friends-grid' },
        sectionCard({ title: '好友请求', subtitle: '接受后才会出现在好友列表', body: refs.requests }),
        sectionCard({ title: '传输', subtitle: '文件临时中转，接收后自动清理', body: refs.transfers }),
        sectionCard({ title: '收到的整合包', subtitle: '可直接安装到新实例', body: refs.received }),
        sectionCard({ title: '设置', subtitle: '昵称与在线状态', body: refs.settings }),
        sectionCard({ title: '连接诊断', subtitle: '服务器、证书与最近事件', body: refs.events })
      )
    )
    settingsBuilt = false
  }

  // ---------------- 聊天 ----------------

  function currentFriend() {
    return (data?.friends || []).find((friend) => friend.uuid === chat.friendId) || null
  }

  function updateChatHead() {
    if (!chat.head) return
    const friend = currentFriend()
    if (!friend) {
      closeChat()
      return
    }
    chat.head.replaceChildren(
      avatarFor(friend.nickname || friend.mcName),
      h('div', { class: 'lp-chat-title' },
        h('b', {}, friend.nickname || friend.mcName),
        h('span', { class: 'lp-chat-status' },
          dot(friend.online ? 'ok' : ''),
          friend.online ? '在线' : friend.lastSeenAt ? `上次在线 ${fmtAgo(friend.lastSeenAt)}` : '离线',
          h('span', { class: 'mono', style: { marginLeft: '6px' } }, friend.mcName || ''),
          friend.activity?.instanceName ? ` · 正在玩 ${friend.activity.instanceName}` : ''
        )
      ),
      h('div', { class: 'lp-chat-actions' },
        btn('分享整合包', { size: 'sm', variant: 'ghost', iconName: 'upload', onClick: () => openShareModal(friend) }),
        btn('模组同步', { size: 'sm', variant: 'ghost', iconName: 'swap', onClick: () => openModsModal(friend) }),
        btn('删除好友', { size: 'sm', variant: 'ghost', onClick: () => removeFriend(friend) })
      )
    )
    if (chat.area) chat.area.placeholder = '输入消息，Enter 发送，Shift+Enter 换行'
  }

  function appendMessageNode(message) {
    if (!chat.log) return null
    const empty = chat.log.querySelector('.lp-chat-empty')
    if (empty) empty.remove()
    const mine = message.from === data?.profile?.uuid
    const node = h('div', {
      class: 'lp-chat-msg ' + (mine ? 'out' : 'in'),
      dataset: { id: message.id }
    },
      h('div', { class: 'lp-chat-bubble' }, message.text),
      h('div', { class: 'lp-chat-meta' }, `${fmtTime(message.at)}${mine ? ' · 已发送' : ''}`)
    )
    chat.log.appendChild(node)
    return node
  }

  async function loadChat({ initial = false } = {}) {
    if (!chat.friendId || chat.loading) return
    chat.loading = true
    const friendId = chat.friendId
    try {
      const after = initial ? 0 : Math.max(0, chat.lastAt - 5000)
      const result = await ctx.api.friendsMessages(friendId, after, true)
      chat.lastFetchAt = Date.now()
      if (chat.friendId !== friendId) return
      if (initial) chat.log.replaceChildren()
      const known = new Set(chat.messages.map((message) => message.id))
      for (const message of result.items || []) {
        if (known.has(message.id)) continue
        chat.messages.push(message)
        chat.lastAt = Math.max(chat.lastAt, message.at)
        appendMessageNode(message)
      }
      if (!chat.messages.length) chat.log.replaceChildren(h('div', { class: 'lp-chat-empty' }, '还没有消息，打个招呼吧'))
      if (initial || chat.nearBottom) chat.log.scrollTop = chat.log.scrollHeight
    } catch (error) {
      if (initial && chat.log) chat.log.replaceChildren(h('div', { class: 'lp-chat-empty warn-text' }, '读取消息失败：' + error.message))
    } finally {
      chat.loading = false
    }
  }

  function buildChatPanel(friend) {
    chat.messages = []
    chat.lastAt = 0
    chat.nearBottom = true
    chat.head = h('div', { class: 'lp-chat-head' })
    chat.log = h('div', { class: 'lp-chat-log', role: 'log', 'aria-live': 'polite' })
    chat.log.addEventListener('scroll', () => {
      const el = chat.log
      chat.nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48
    })
    chat.area = h('textarea', { class: 'lp-chat-input', rows: 2, placeholder: '输入消息，Enter 发送，Shift+Enter 换行', 'aria-label': '聊天消息' })
    chat.area.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        sendChatMessage()
      }
    })
    chat.sendBtn = btn('发送', { variant: 'primary', iconName: 'arrow-right', onClick: () => sendChatMessage() })
    chat.panel = h('div', { class: 'lp-chat-panel' }, chat.head, chat.log, h('div', { class: 'lp-chat-composer' }, chat.area, chat.sendBtn))
    refs.chat.replaceChildren(chat.panel)
    updateChatHead()
    void loadChat({ initial: true })
  }

  function selectFriend(uuid) {
    const friend = (data?.friends || []).find((item) => item.uuid === uuid)
    if (!friend) return
    chat.friendId = uuid
    buildChatPanel(friend)
    paintFriends()
  }

  function closeChat() {
    chat.friendId = ''
    chat.messages = []
    chat.lastAt = 0
    chat.panel = null
    chat.head = null
    chat.log = null
    chat.area = null
    chat.sendBtn = null
    if (refs.chat) refs.chat.replaceChildren(h('div', { class: 'lp-chat-empty' }, '选择左侧好友开始聊天'))
    paintFriends()
  }

  async function sendChatMessage() {
    const text = String(chat.area?.value || '').trim()
    if (!text || !chat.friendId || chat.sending) return
    chat.sending = true
    if (chat.sendBtn) chat.sendBtn.disabled = true
    try {
      const result = await ctx.api.friendsSendChat(chat.friendId, text)
      chat.area.value = ''
      if (!chat.messages.some((message) => message.id === result.message.id)) {
        chat.messages.push(result.message)
        chat.lastAt = Math.max(chat.lastAt, result.message.at)
        appendMessageNode(result.message)
      }
      chat.nearBottom = true
      chat.log.scrollTop = chat.log.scrollHeight
      await refreshData(true)
    } catch (error) {
      toast(error.message, 'err')
    } finally {
      chat.sending = false
      updateChatHead()
    }
  }

  // ---------------- 列表 ----------------

  function friendRow(friend) {
    const unread = Number(friend.unread) || 0
    const last = friend.lastMessage
    const preview = last ? `${last.from === data?.profile?.uuid ? '我：' : ''}${String(last.text).replace(/\s+/g, ' ').slice(0, 42)}` : '还没有消息'
    const row = h('button', {
      class: 'lp-friend-row selectable' + (chat.friendId === friend.uuid ? ' active' : ''),
      type: 'button',
      'aria-pressed': String(chat.friendId === friend.uuid)
    },
      avatarFor(friend.nickname || friend.mcName),
      h('div', { class: 'lp-friend-main' },
        h('div', { class: 'lp-friend-top' },
          h('b', {}, friend.nickname || friend.mcName),
          h('span', { class: 'lp-friend-status' }, dot(friend.online ? 'ok' : ''), friend.online ? '在线' : '离线')
        ),
        h('div', { class: 'lp-friend-preview' }, preview),
        h('div', { class: 'lp-friend-meta' }, h('span', { class: 'mono' }, friend.mcName || ''))
      ),
      unread ? badge(String(unread > 99 ? '99+' : unread), 'warn') : null
    )
    row.onclick = () => selectFriend(friend.uuid)
    return row
  }

  function paintFriends() {
    if (!refs.friends || !data) return
    const friends = data.friends || []
    if (!friends.length) {
      if (chat.friendId) {
        chat.friendId = ''
        if (refs.chat) refs.chat.replaceChildren(h('div', { class: 'lp-chat-empty' }, '选择左侧好友开始聊天'))
      }
      refs.friends.replaceChildren(emptyBlock('还没有好友', '输入对方的正版游戏 ID 发送请求；对方接受后会出现在这里。', null, 'user'))
      return
    }
    refs.friends.replaceChildren(...friends.map(friendRow))
    if (!chat.friendId || !friends.some((friend) => friend.uuid === chat.friendId)) {
      selectFriend(friends[0].uuid)
    }
  }

  function paintRequests() {
    if (!refs.requests || !data) return
    const incoming = data.incoming || []
    const outgoing = data.outgoing || []
    const children = []
    for (const request of incoming) {
      children.push(h('div', { class: 'lp-friend-row compact' },
        avatarFor(request.nickname || request.mcName),
        h('div', { class: 'lp-friend-main' },
          h('div', { class: 'lp-friend-top' }, h('b', {}, request.nickname || request.mcName), badge('请求添加你', 'info')),
          h('div', { class: 'lp-friend-meta' }, h('span', { class: 'mono' }, request.mcName || ''), h('span', { class: 'muted' }, fmtAgo(request.lastSeenAt || Date.now())))
        ),
        h('div', { class: 'lp-friend-actions' },
          btn('接受', { size: 'sm', variant: 'primary', iconName: 'check', onClick: () => respond(request.uuid, true) }),
          btn('拒绝', { size: 'sm', variant: 'ghost', onClick: () => respond(request.uuid, false) })
        )
      ))
    }
    for (const request of outgoing) {
      children.push(h('div', { class: 'lp-friend-row compact' },
        avatarFor(request.nickname || request.mcName),
        h('div', { class: 'lp-friend-main' },
          h('div', { class: 'lp-friend-top' }, h('b', {}, request.nickname || request.mcName), badge('等待对方接受', 'warn')),
          h('div', { class: 'lp-friend-meta' }, h('span', { class: 'mono' }, request.mcName || ''))
        )
      ))
    }
    if (!children.length) children.push(h('div', { class: 'lp-friends-hint' }, '没有待处理的好友请求。'))
    refs.requests.replaceChildren(...children)
  }

  async function respond(uuid, accept) {
    try {
      await ctx.api.friendsRespond(uuid, accept)
      toast(accept ? '已接受好友请求' : '已拒绝', accept ? 'ok' : 'info')
      await refreshData(true)
    } catch (error) {
      toast(error.message, 'err')
    }
  }

  async function removeFriend(friend) {
    if (!(await ctx.confirm(`删除好友「${friend.nickname || friend.mcName}」？聊天记录会保留在服务器上。`, { title: '删除好友', okText: '删除', danger: true }))) return
    try {
      await ctx.api.friendsRemove(friend.uuid)
      if (chat.friendId === friend.uuid) closeChat()
      await refreshData(true)
      toast('已删除好友', 'ok')
    } catch (error) {
      toast(error.message, 'err')
    }
  }

  function paintTransfers() {
    if (!refs.transfers || !data) return
    const items = []
    for (const item of data.transfers?.uploads || []) items.push({ ...item, direction: 'out', local: true })
    for (const item of data.transfers?.downloads || []) items.push({ ...item, direction: 'in', local: true })
    for (const item of data.files?.incoming || []) items.push({ ...item, direction: 'in' })
    for (const item of data.files?.outgoing || []) items.push({ ...item, direction: 'out' })
    const seen = new Set()
    const unique = items.filter((item) => {
      if (!item?.id || seen.has(item.id)) return false
      seen.add(item.id)
      return true
    }).sort((a, b) => (b.createdAt || b.startedAt || 0) - (a.createdAt || a.startedAt || 0)).slice(0, 20)
    if (!unique.length) {
      refs.transfers.replaceChildren(h('div', { class: 'lp-friends-hint' }, '没有进行中的传输。'))
      return
    }
    refs.transfers.replaceChildren(...unique.map((item) => {
      let label = STATUS_LABEL[item.status] || item.status
      if (item.status === 'ready') label = item.direction === 'in' ? '等待下载' : '等待对方接收'
      const ratio = ratioOf(item)
      const actions = []
      if (item.direction === 'in' && item.status === 'ready') {
        actions.push(btn('下载', { size: 'sm', variant: 'primary', iconName: 'download', onClick: () => download(item.id) }))
      }
      if (item.direction === 'out' && ['exporting', 'uploading'].includes(item.status) && !String(item.id).startsWith('local_')) {
        actions.push(btn('取消', { size: 'sm', variant: 'ghost', onClick: () => cancelTransfer(item.id) }))
      }
      return h('div', { class: 'lp-transfer-row' },
        h('div', { class: 'lp-transfer-head' },
          h('b', {}, item.name || '文件'),
          badge(`${item.direction === 'in' ? '接收' : '发送'} · ${KIND_LABEL[item.kind] || '文件'}`, ''),
          h('span', { class: 'lp-transfer-status' }, label)
        ),
        ratio === null ? null : progress(ratio).el,
        h('div', { class: 'lp-transfer-foot' },
          h('span', { class: 'muted' }, item.size ? `${fmtBytes(item.loaded || 0)} / ${fmtBytes(item.size)}` : item.error || ''),
          h('div', { class: 'lp-friend-actions' }, actions)
        )
      )
    }))
  }

  async function download(id) {
    try {
      await ctx.api.friendsDownload(id)
      toast('已开始下载，完成后可在「收到的整合包」里安装', 'ok')
      await refreshData(true)
    } catch (error) {
      toast(error.message, 'err')
    }
  }

  async function cancelTransfer(id) {
    try {
      await ctx.api.friendsCancelTransfer(id)
      await refreshData(true)
    } catch (error) {
      toast(error.message, 'err')
    }
  }

  function paintReceived() {
    if (!refs.received || !data) return
    const items = data.received || []
    if (!items.length) {
      refs.received.replaceChildren(h('div', { class: 'lp-friends-hint' }, '还没有收到过整合包。'))
      return
    }
    refs.received.replaceChildren(...items.map((item) => {
      const file = (item.files || [])[0]
      return h('div', { class: 'lp-received-row' },
        h('div', { class: 'lp-received-main' },
          h('b', {}, item.name),
          h('div', { class: 'lp-friend-meta' },
            h('span', {}, item.peerName || '好友'),
            h('span', { class: 'muted' }, fmtDateTime(item.at)),
            file ? h('span', { class: 'muted' }, fmtBytes(file.size)) : null
          )
        ),
        h('div', { class: 'lp-friend-actions' },
          file ? btn('安装整合包', { size: 'sm', variant: 'primary', iconName: 'package-down', onClick: () => ctx.installPackFromDownload({ path: file.path }, file.path) }) : null,
          file ? btn('打开文件夹', { size: 'sm', variant: 'ghost', iconName: 'folder-open', onClick: () => ctx.openPath(file.path) }) : null,
          btn('删除', { size: 'sm', variant: 'ghost', onClick: async () => {
            if (!(await ctx.confirm('删除这条接收记录和已下载的文件？', { title: '删除', danger: true, okText: '删除' }))) return
            try {
              await ctx.api.friendsRemoveReceived(item.id)
              await refreshData(true)
            } catch (error) {
              toast(error.message, 'err')
            }
          } })
        )
      )
    }))
  }

  function buildSettings() {
    const prefs = data.prefs || {}
    const nickname = input({ value: prefs.nickname || data.profile?.nickname || '', placeholder: '好友看到的昵称' })
    const showActivity = toggle(prefs.showActivity !== false, () => {})
    const save = btn('保存设置', {
      variant: 'primary',
      iconName: 'check',
      onClick: async () => {
        save.disabled = true
        try {
          await ctx.api.friendsSaveSelf({
            nickname: nickname.value.trim(),
            showActivity: showActivity.querySelector('input')?.checked !== false
          })
          toast('设置已保存', 'ok')
          await refreshData(true)
        } catch (error) {
          toast(error.message, 'err')
        } finally {
          save.disabled = false
        }
      }
    })
    refs.settings.replaceChildren(
      h('div', { class: 'lp-friends-settings-grid' },
        field('昵称', nickname, { hint: '好友同时能看到你的正版游戏 ID，用于辨认身份' })
      ),
      h('div', { class: 'lp-friends-toggles' },
        h('label', { class: 'row' }, showActivity, h('span', {}, '向好友显示我正在玩的实例'))
      ),
      h('div', { class: 'lp-friends-actions' }, save),
      h('div', { class: 'lp-friends-hint' }, '聊天记录与好友关系保存在服务器上；整合包和模组文件在接收后 10 分钟自动清理。')
    )
    settingsBuilt = true
  }

  function paintSettings() {
    if (!refs.settings || !data) return
    if (!settingsBuilt) buildSettings()
  }

  function paintEvents() {
    if (!refs.events || !data) return
    const rows = [
      ['好友服务器', '官方服务器（内置）'],
      ['登录', data.loggedIn ? '已登录' : '未登录'],
      ['正版 ID', data.profile?.mcName || data.account?.mcName || '—'],
      ['服务器时间', data.serverTime ? fmtDateTime(data.serverTime) : '—']
    ].map(([label, value]) => h('div', { class: 'lp-friends-kv' },
      h('span', { class: 'muted' }, label),
      h('span', { class: 'mono' }, String(value))
    ))
    const events = (data.events || []).slice(0, 8).map((event) => h('div', { class: 'lp-friends-event' },
      h('span', { class: 'muted mono' }, new Date(event.at).toLocaleTimeString('zh-CN', { hour12: false })),
      h('span', { class: event.kind === 'err' || event.kind === 'warn' ? 'warn-text' : '' }, event.text)
    ))
    const children = [h('div', { class: 'lp-friends-kv-list' }, rows)]
    if (events.length) children.push(h('div', { class: 'lp-friends-event-list' }, h('div', { class: 'lp-friends-hint' }, '最近事件'), ...events))
    refs.events.replaceChildren(...children)
  }

  // ---------------- 弹窗 ----------------

  function instanceOptions() {
    return (ctx.getState().instances || []).map((inst) => [inst.id, `${inst.name} · ${inst.mc}${inst.loader && inst.loader !== 'vanilla' ? ' · ' + inst.loader : ''}`])
  }

  function openShareModal(friend) {
    const options = instanceOptions()
    if (!options.length) {
      toast('还没有实例，先创建一个实例再分享', 'warn')
      return
    }
    const instanceSel = select(options, ctx.getState().selectedId || options[0][0])
    const formatSel = select([['mrpack', 'Modrinth · .mrpack（推荐）'], ['zip', '通用 · .zip']], 'mrpack')
    const saves = toggle(false, () => {})
    const screenshots = toggle(false, () => {})
    const status = h('div', { class: 'lp-friends-modal-status' })
    const start = btn('导出并上传', {
      variant: 'primary',
      iconName: 'upload',
      onClick: async () => {
        start.disabled = true
        status.textContent = '开始导出，进度会显示在「传输」里…'
        try {
          await ctx.api.friendsSharePack({
            friendId: friend.uuid,
            instanceId: instanceSel.value,
            format: formatSel.value,
            includeSaves: saves.querySelector('input')?.checked === true,
            includeScreenshots: screenshots.querySelector('input')?.checked === true
          })
          toast('已开始导出并上传；对方会在传输列表看到', 'ok')
          modal.close()
          await refreshData(true)
        } catch (error) {
          status.textContent = '失败：' + error.message
          start.disabled = false
        }
      }
    })
    const modal = ctx.openModal({
      title: `分享整合包 · ${friend.nickname || friend.mcName}`,
      size: 'md',
      body: h('div', { class: 'lp-friends-modal' },
        h('div', { class: 'lp-friends-modal-note' }, '导出后上传到好友服务器，对方下载完成后服务器自动清理文件。'),
        field('实例', instanceSel),
        field('格式', formatSel),
        h('div', { class: 'lp-friends-toggles' },
          h('label', { class: 'row' }, saves, h('span', {}, '包含存档')),
          h('label', { class: 'row' }, screenshots, h('span', {}, '包含截图'))
        ),
        status
      ),
      buttons: [{ label: '关闭', onClick: (api) => api.close() }, start]
    })
  }

  function openModsModal(friend) {
    const options = instanceOptions()
    if (!options.length) {
      toast('还没有实例', 'warn')
      return
    }
    const instanceSel = select(options, ctx.getState().selectedId || options[0][0])
    const summary = h('div', { class: 'lp-friends-mods-summary' })
    const result = h('div', { class: 'lp-friends-mods-result' })
    const status = h('div', { class: 'lp-friends-modal-status' })
    const bar = progress(0)
    const fillBtn = btn('以对方为准补齐', { variant: 'primary', iconName: 'download', disabled: true })
    const sendBtn = btn('把我独有的发给对方', { variant: 'secondary', iconName: 'upload', disabled: true })
    const compareBtn = btn('开始对比', { variant: 'primary', iconName: 'swap' })
    let current = null

    compareBtn.addEventListener('click', async () => {
      compareBtn.disabled = true
      summary.textContent = '正在上传我的清单并读取对方清单…'
      result.replaceChildren(h('div', { class: 'lp-tab-loading' }, spinner(12), '正在对比…'))
      try {
        current = await ctx.api.friendsCompareMods({ friendId: friend.uuid, instanceId: instanceSel.value })
        paintCompare()
      } catch (error) {
        summary.textContent = '对比失败：' + error.message
        result.replaceChildren()
      } finally {
        compareBtn.disabled = false
      }
    })

    function itemLine(item) {
      return h('div', { class: 'lp-friends-mod-line' },
        h('span', { class: 'mono' }, item.file),
        h('span', { class: 'muted' }, [item.modid, item.version].filter(Boolean).join(' · ') || '—'),
        item.enabled === false ? badge('已停用', 'warn') : null
      )
    }

    function paintCompare() {
      const diff = current.diff
      const counts = diff.counts
      summary.replaceChildren(
        h('b', {}, current.mine.instance.name),
        h('span', { class: 'muted' }, ` ${current.mine.items.length} 个`),
        h('span', { class: 'lp-friends-vs' }, '↔'),
        h('b', {}, current.peer.instance?.name || '对方实例'),
        h('span', { class: 'muted' }, ` ${current.peer.items?.length || 0} 个`)
      )
      const blocks = [h('div', { class: 'lp-friends-mods-counts' },
        badge(`一致 ${counts.same}`, 'ok'),
        badge(`仅我有 ${counts.onlyMine}`, ''),
        badge(`仅对方有 ${counts.onlyPeer}`, 'warn'),
        badge(`版本不同 ${counts.different}`, 'warn'),
        counts.symmetric ? badge('完全对称', 'ok') : null
      )]
      if (diff.onlyPeer.length) blocks.push(h('div', { class: 'lp-friends-mod-group' }, h('b', {}, '对方有、我没有'), ...diff.onlyPeer.map(itemLine)))
      if (diff.onlyMine.length) blocks.push(h('div', { class: 'lp-friends-mod-group' }, h('b', {}, '我有、对方没有'), ...diff.onlyMine.map(itemLine)))
      if (diff.different.length) {
        blocks.push(h('div', { class: 'lp-friends-mod-group' }, h('b', {}, '版本或启用状态不同'),
          ...diff.different.map((pair) => h('div', { class: 'lp-friends-mod-pair' }, itemLine(pair.mine), h('span', { class: 'muted' }, '→'), itemLine(pair.peer)))
        ))
      }
      result.replaceChildren(...blocks)
      fillBtn.disabled = diff.onlyPeer.length + diff.different.filter((pair) => pair.reason === 'version').length === 0
      sendBtn.disabled = diff.onlyMine.length + diff.different.filter((pair) => pair.reason === 'version').length === 0
    }

    fillBtn.addEventListener('click', async () => {
      fillBtn.disabled = true
      sendBtn.disabled = true
      bar.set(0)
      status.textContent = '开始补齐…'
      try {
        const job = await ctx.api.friendsFillMods({ friendId: friend.uuid, instanceId: instanceSel.value })
        let stopped = false
        modal.onClose = () => { stopped = true }
        const poll = async () => {
          if (stopped) return
          try {
            const state = await ctx.api.friendsModsJob(job.id)
            bar.set(Number(state.progress) || 0)
            status.textContent = `${state.phase || ''}${state.detail ? ' · ' + state.detail : ''}`
            if (state.status === 'done') {
              status.textContent = state.detail || '补齐完成'
              toast('补齐完成', 'ok')
              current = await ctx.api.friendsCompareMods({ friendId: friend.uuid, instanceId: instanceSel.value })
              paintCompare()
              fillBtn.disabled = false
              sendBtn.disabled = false
              void refreshData(true)
              return
            }
            if (state.status === 'failed' || state.status === 'cancelled') {
              status.textContent = state.status === 'cancelled' ? '已取消' : '补齐失败：' + (state.error || '未知错误')
              fillBtn.disabled = false
              sendBtn.disabled = false
              return
            }
            setTimeout(poll, 800)
          } catch (error) {
            status.textContent = '读取进度失败：' + error.message
            fillBtn.disabled = false
            sendBtn.disabled = false
          }
        }
        poll()
      } catch (error) {
        status.textContent = '补齐失败：' + error.message
        fillBtn.disabled = false
        sendBtn.disabled = false
      }
    })

    sendBtn.addEventListener('click', async () => {
      sendBtn.disabled = true
      try {
        const sent = await ctx.api.friendsSendMods({ friendId: friend.uuid, instanceId: instanceSel.value })
        status.textContent = `已上传 ${sent.count} 个模组文件，对方可在传输列表下载`
        toast('已上传，等待对方下载', 'ok')
        await refreshData(true)
      } catch (error) {
        status.textContent = '发送失败：' + error.message
      } finally {
        sendBtn.disabled = false
      }
    })

    const modal = ctx.openModal({
      title: `模组同步 · ${friend.nickname || friend.mcName}`,
      size: 'lg',
      body: h('div', { class: 'lp-friends-modal' },
        h('div', { class: 'lp-friends-modal-note' },
          '双方清单上传到好友服务器后对比。补齐时优先使用已收到的文件与 Modrinth；',
          '私有模组需要对方点「把我独有的发给对方」，文件经服务器临时中转。'
        ),
        h('div', { class: 'lp-friends-compare-bar' }, field('我的实例', instanceSel), compareBtn),
        summary, bar.el, status, result,
        h('div', { class: 'lp-friends-actions' }, fillBtn, sendBtn)
      )
    })
    compareBtn.click()
  }

  // ---------------- 数据轮询 ----------------

  let lastAccountKey = ''

  async function refreshData(force = false) {
    if (disposed) return
    try {
      data = await ctx.api.friends()
      setError(data.error || '')
      const nextMode = data.loggedIn ? 'friends' : 'login'
      const accountKey = data.mcAccount ? `${data.mcAccount.uuid}:${data.mcAccount.type}` : 'none'
      if (nextMode !== mode || (nextMode === 'login' && accountKey !== lastAccountKey)) {
        lastAccountKey = accountKey
        buildLayout()
      } else if (mode === 'friends') {
        paintAll()
        if (chat.friendId && Date.now() - chat.lastFetchAt > 1200) void loadChat()
      }
    } catch (error) {
      setError('读取好友状态失败：' + error.message)
    }
  }

  async function refresh(showLoading = false) {
    if (busy || disposed) return
    busy = true
    try {
      if (showLoading && refs.root && !data) {
        refs.root.replaceChildren(h('div', { class: 'lp-tab-loading' }, spinner(12), '正在读取好友状态…'))
      }
      await refreshData(true)
    } finally {
      busy = false
    }
  }

  return {
    render(parent) {
      refs.root = parent
      refs.root.classList.add('lp-friends')
      refresh(true)
      timer = setInterval(() => refresh(false), 2000)
    },
    dispose() {
      if (disposed) return
      disposed = true
      if (timer) clearInterval(timer)
      timer = null
    }
  }
}
