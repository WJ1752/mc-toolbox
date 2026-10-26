// 好友页（中心服务器模式）：正版 MC 账号登录、好友列表、聊天、临时文件中转与模组同步。
import { h, clear, fmtBytes, fmtAgo, fmtDateTime, fmtTime } from '../core/dom.js'
import { btn, input, select, toggle, progress, spinner, badge, dot, field, iconBtn, icon } from '../ui/kit.js'
import { sectionCard, emptyBlock, tabBar } from './ui.js'

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
// 传输列表里「还在动」与「已经结束」的状态分组——折叠时只保留进行中的。
const TRANSFER_ACTIVE = new Set(['exporting', 'uploading', 'downloading', 'ready', 'offering', 'waiting', 'sending', 'receiving', 'verifying', 'offered'])
const TRANSFER_FINISHED = new Set(['done', 'delivered', 'failed', 'expired', 'deleted', 'cancelled'])

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

function shortPath(p, max = 52) {
  const text = String(p || '')
  return text.length > max ? '…' + text.slice(-(max - 1)) : text
}

/** 资料卡里的小统计格：好友数 / 请求数 / 待接收文件数。 */
function statCell(label, value, tone = '') {
  return h('div', { class: 'lp-friends-stat' + (tone ? ' ' + tone : '') },
    h('b', {}, String(value)),
    h('span', {}, label)
  )
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
  const ui = {
    tab: 'friends',
    transfersCollapsed: false,
    showFinished: false,
    receivedCollapsed: false,
    diagnosticsOpen: false
  }
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

  function refreshBadge() {
    if (!data) return
    if (!data.loggedIn) {
      ctx.setFriendsBadge?.({ requests: 0, unread: 0, incoming: 0, activeTransfers: 0 })
      return
    }
    // 传输记录里只有真正在动的（导出/上传/接收）算提示，等待对方接收不算。
    const local = [...(data.transfers?.uploads || []), ...(data.transfers?.downloads || [])]
    const running = local.filter((record) => ['exporting', 'uploading', 'downloading'].includes(record.status)).length
    ctx.setFriendsBadge?.({
      requests: (data.incoming || []).length,
      unread: (data.friends || []).reduce((sum, friend) => sum + (Number(friend.unread) || 0), 0),
      incoming: (data.files?.incoming || []).filter((file) => file.status === 'ready').length,
      activeTransfers: running
    })
  }

  // ---------------- 布局 ----------------

  function paintAll() {
    if (!data || mode !== 'friends') return
    paintProfile()
    paintReceiveCard()
    paintSide()
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
          refreshBadge()
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
    // 还没有好友但有请求时，直接把左侧切到「请求」，避免用户只看到一个空列表。
    if (!(data.friends || []).length && (data.incoming || []).length) ui.tab = 'requests'
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
          refreshBadge()
          await refreshData(true)
        } catch (error) {
          toast(error.message, 'err')
        } finally {
          add.disabled = false
        }
      }
    })
    addInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') add.click() })

    refs.profile = h('div')
    refs.receiveBody = h('div', { class: 'lp-friends-setup lp-friends-receive' })
    refs.sideTabs = h('div', { class: 'lp-friends-side-tabs' })
    refs.sideBody = h('div')
    refs.transfersTitle = h('span', {})
    refs.transfersBody = h('div')
    refs.transfersActions = h('div', { class: 'lp-friend-actions' })
    refs.receivedTitle = h('span', {})
    refs.receivedClear = btn('清除记录', {
      size: 'xs',
      variant: 'ghost',
      iconName: 'trash',
      title: '删除全部接收记录（默认接收目录里的暂存文件一并删除）',
      onClick: () => void clearReceivedRecords()
    })
    refs.receivedClear.disabled = true
    refs.receivedBody = h('div')
    refs.chat = h('div', { class: 'lp-chat' })
    refs.settings = h('div', { class: 'lp-friends-settings' })
    refs.eventsBody = h('div')
    refs.diagToggle = iconBtn('chevron-right', {
      label: '展开连接诊断',
      size: 14,
      onClick: () => {
        ui.diagnosticsOpen = !ui.diagnosticsOpen
        paintEvents()
      }
    })

    refs.root.append(
      h('div', { class: 'lp-friends-hero' },
        sectionCard({
          title: '我的好友资料',
          subtitle: '好友能看到正版 ID',
          className: 'lp-friends-profile-card',
          body: refs.profile
        }),
        sectionCard({
          title: '添加好友',
          subtitle: '按正版游戏 ID 查找',
          className: 'lp-friends-add-card',
          body: h('div', { class: 'lp-friends-setup' },
            field('正版 ID', addInput, { hint: '对方必须先登录过好友服务器；好友能看到彼此的真实正版 ID' }),
            h('div', { class: 'lp-friends-actions' }, add)
          )
        }),
        sectionCard({
          title: '接收与下载',
          subtitle: '文件保存到哪里',
          className: 'lp-friends-receive-card',
          body: refs.receiveBody
        })
      ),
      h('div', { class: 'lp-friends-chat-layout' },
        sectionCard({
          title: '好友',
          subtitle: '点击开始聊天',
          className: 'lp-friends-side',
          actions: refs.sideTabs,
          body: refs.sideBody
        }),
        sectionCard({ title: '聊天', subtitle: '消息保存在服务器 · 离线也能收到', className: 'lp-friends-chat-main', body: refs.chat })
      ),
      h('div', { class: 'lp-friends-lower' },
        h('section', { class: 'lp-card lp-friends-transfers' },
          h('div', { class: 'lp-card-head' },
            h('div', { class: 'lp-card-title' }, h('b', {}, '传输'), refs.transfersTitle),
            refs.transfersActions
          ),
          h('div', { class: 'lp-card-body' }, refs.transfersBody)
        ),
        h('section', { class: 'lp-card lp-friends-received' },
          h('div', { class: 'lp-card-head' },
            h('div', { class: 'lp-card-title' }, h('b', {}, '已接收文件'), refs.receivedTitle),
            h('div', { class: 'lp-card-actions' }, refs.receivedClear, iconBtn('collapse', {
              label: '折叠已接收文件',
              size: 14,
              onClick: () => {
                ui.receivedCollapsed = !ui.receivedCollapsed
                paintReceived()
              }
            }))
          ),
          h('div', { class: 'lp-card-body' }, refs.receivedBody)
        )
      ),
      h('div', { class: 'lp-friends-lower lp-friends-footer' },
        sectionCard({ title: '设置', subtitle: '昵称、下载目录与在线状态', body: refs.settings }),
        h('section', { class: 'lp-card' },
          h('div', { class: 'lp-card-head' },
            h('div', { class: 'lp-card-title' }, h('b', {}, '连接诊断'), h('span', {}, '服务器、证书与最近事件')),
            h('div', { class: 'lp-card-actions' }, refs.diagToggle)
          ),
          h('div', { class: 'lp-card-body' }, refs.eventsBody)
        )
      )
    )
    settingsBuilt = false
  }

  // ---------------- 资料 / 接收设置 ----------------

  function paintProfile() {
    if (!refs.profile || !data) return
    const profile = data.profile || data.account || {}
    const friendCount = (data.friends || []).length
    const requestCount = (data.incoming || []).length
    const waitingCount = (data.files?.incoming || []).filter((file) => file.status === 'ready').length
    refs.profile.replaceChildren(
      h('div', { class: 'lp-friends-profile' },
        avatarFor(profile.nickname || profile.mcName),
        h('div', { class: 'lp-friend-main' },
          h('div', { class: 'lp-friend-top' }, h('b', {}, profile.nickname || profile.mcName || '未登录'), badge('正版', 'ok')),
          h('div', { class: 'lp-friend-meta' },
            h('span', { class: 'mono' }, profile.mcName || ''),
            h('span', { class: 'lp-friend-status' }, dot(profile.online ? 'ok' : ''), profile.online ? '在线' : '离线')
          )
        ),
        btn('退出登录', {
          size: 'sm',
          variant: 'ghost',
          onClick: async () => {
            try {
              await ctx.api.friendsLogout()
              refreshBadge()
              await refreshData(true)
            } catch (error) {
              toast(error.message, 'err')
            }
          }
        })
      ),
      h('div', { class: 'lp-friends-stats' },
        statCell('好友', friendCount),
        statCell('好友请求', requestCount, requestCount ? 'warn' : ''),
        statCell('待接收文件', waitingCount, waitingCount ? 'accent' : '')
      )
    )
  }

  function paintReceiveCard() {
    if (!refs.receiveBody || !data) return
    const prefs = data.prefs || {}
    const saved = String(prefs.downloadDir || '').trim()
    const fallback = String(data.defaultDownloadDir || '').trim()
    const effective = saved || fallback
    const dirText = h('div', { class: 'mono lp-friends-dir', title: effective }, shortPath(effective || '（尚未设置接收目录）', 40))
    const chooseDir = btn('选择目录…', {
      size: 'sm',
      iconName: 'folder',
      onClick: async () => {
        const dir = await ctx.pickDir(effective, { title: '选择好友文件下载目录' })
        if (!dir) return
        try {
          await ctx.api.friendsSaveSelf({ downloadDir: dir })
          toast('下载目录已更新', 'ok')
          await refreshData(true)
        } catch (error) {
          toast(error.message, 'err')
        }
      }
    })
    const resetDir = btn('恢复默认', {
      size: 'sm',
      variant: 'ghost',
      disabled: !saved,
      onClick: async () => {
        try {
          await ctx.api.friendsSaveSelf({ downloadDir: '' })
          toast('已恢复默认接收目录', 'ok')
          await refreshData(true)
        } catch (error) {
          toast(error.message, 'err')
        }
      }
    })
    refs.receiveBody.replaceChildren(
      h('div', { class: 'lp-friends-kv' }, h('span', { class: 'muted' }, '下载目录'), h('span', {}, saved ? '自定义' : '默认接收目录')),
      dirText,
      h('div', { class: 'lp-friends-actions' }, chooseDir, resetDir, btn('打开目录', {
        size: 'sm',
        variant: 'ghost',
        iconName: 'folder-open',
        disabled: !effective,
        onClick: () => ctx.openPath(effective)
      })),
      h('div', { class: 'lp-friends-hint' }, '接收文件默认放到这里；每次接收也可以临时另存为其他目录。')
    )
  }

  // ---------------- 聊天 ----------------

  function currentFriend() {
    return (data?.friends || []).find((friend) => friend.uuid === chat.friendId) || null
  }

  /** 把好友 uuid 换成可读名字；对方已删除好友时回退为空串。 */
  function peerLabel(uuid) {
    if (!uuid) return ''
    const friend = (data?.friends || []).find((item) => item.uuid === uuid)
    return friend?.nickname || friend?.mcName || ''
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
      if (initial) refreshBadge()
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
    paintSide()
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
    paintSide()
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

  // ---------------- 好友 / 请求列表 ----------------

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

  function requestRow(request, { incoming = false } = {}) {
    return h('div', { class: 'lp-friend-row compact' },
      avatarFor(request.nickname || request.mcName),
      h('div', { class: 'lp-friend-main' },
        h('div', { class: 'lp-friend-top' }, h('b', {}, request.nickname || request.mcName),
          badge(incoming ? '请求添加你' : '等待对方接受', incoming ? 'info' : 'warn')),
        h('div', { class: 'lp-friend-meta' },
          h('span', { class: 'mono' }, request.mcName || ''),
          h('span', { class: 'muted' }, fmtAgo(request.lastSeenAt || Date.now())))
      ),
      incoming
        ? h('div', { class: 'lp-friend-actions' },
          btn('接受', { size: 'sm', variant: 'primary', iconName: 'check', onClick: () => respond(request.uuid, true) }),
          btn('拒绝', { size: 'sm', variant: 'ghost', onClick: () => respond(request.uuid, false) })
        )
        : null
    )
  }

  function paintSide() {
    // 每 2 秒重绘整个列表会重置滚动位置；记住/恢复一下，长好友列表不会跳回顶部。
    const scroller = refs.sideBody?.closest?.('.lp-card-body')
    const scrollTop = scroller ? scroller.scrollTop : 0
    try {
      paintSideInner()
    } finally {
      if (scroller) scroller.scrollTop = scrollTop
    }
  }

  function paintSideInner() {
    if (!refs.sideBody || !data) return
    const friends = data.friends || []
    const incoming = data.incoming || []
    const outgoing = data.outgoing || []
    if (refs.sideTabs) {
      refs.sideTabs.replaceChildren(tabBar([
        ['friends', '好友', friends.length],
        ['requests', '请求', incoming.length]
      ], ui.tab, (id) => {
        ui.tab = id
        paintSide()
      }))
    }
    if (ui.tab === 'requests') {
      const rows = []
      if (incoming.length) rows.push(h('div', { class: 'lp-friends-subhead' }, `收到的好友请求 · ${incoming.length}`))
      for (const request of incoming) rows.push(requestRow(request, { incoming: true }))
      if (outgoing.length) rows.push(h('div', { class: 'lp-friends-subhead' }, `已发出的请求 · ${outgoing.length}`))
      for (const request of outgoing) rows.push(requestRow(request))
      if (!rows.length) rows.push(emptyBlock('没有待处理的好友请求', '收到请求后，这里会显示提示，侧边栏「好友」也会有角标。', null, 'user'))
      refs.sideBody.replaceChildren(...rows)
      return
    }
    if (!friends.length) {
      if (chat.friendId) {
        chat.friendId = ''
        if (refs.chat) refs.chat.replaceChildren(h('div', { class: 'lp-chat-empty' }, '选择左侧好友开始聊天'))
      }
      refs.sideBody.replaceChildren(emptyBlock('还没有好友', '输入对方的正版游戏 ID 发送请求；对方接受后会出现在这里。', null, 'user'))
      return
    }
    refs.sideBody.replaceChildren(h('div', { class: 'lp-friends-list' }, ...friends.map(friendRow)))
    if (!chat.friendId || !friends.some((friend) => friend.uuid === chat.friendId)) {
      selectFriend(friends[0].uuid)
    }
  }

  async function respond(uuid, accept) {
    try {
      await ctx.api.friendsRespond(uuid, accept)
      toast(accept ? '已接受好友请求' : '已拒绝', accept ? 'ok' : 'info')
      refreshBadge()
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
      refreshBadge()
      await refreshData(true)
      toast('已删除好友', 'ok')
    } catch (error) {
      toast(error.message, 'err')
    }
  }

  // ---------------- 传输 ----------------

  function transferItems() {
    const items = []
    for (const item of data?.transfers?.uploads || []) items.push({ ...item, direction: 'out', local: true })
    for (const item of data?.transfers?.downloads || []) items.push({ ...item, direction: 'in', local: true })
    for (const item of data?.files?.incoming || []) items.push({ ...item, direction: 'in' })
    for (const item of data?.files?.outgoing || []) items.push({ ...item, direction: 'out' })
    const seen = new Set()
    return items.filter((item) => {
      if (!item?.id || seen.has(item.id)) return false
      seen.add(item.id)
      return true
    }).sort((a, b) => (b.createdAt || b.startedAt || 0) - (a.createdAt || a.startedAt || 0))
  }

  function paintTransfers() {
    if (!refs.transfersBody || !data) return
    const items = transferItems()
    const active = items.filter((item) => TRANSFER_ACTIVE.has(item.status))
    const finished = items.filter((item) => TRANSFER_FINISHED.has(item.status))
    // 「待接收」和「待对方接收」都是 ready 状态，单独计数，避免和「进行中」重复。
    const receiving = items.filter((item) => item.direction === 'in' && item.status === 'ready')
    const sending = items.filter((item) => item.direction === 'out' && item.status === 'ready')
    const running = active.filter((item) => item.status !== 'ready')

    if (refs.transfersTitle) {
      const parts = []
      if (running.length) parts.push(`${running.length} 进行中`)
      if (receiving.length) parts.push(`${receiving.length} 待接收`)
      if (sending.length) parts.push(`${sending.length} 待对方接收`)
      if (finished.length) parts.push(`${finished.length} 已完成`)
      refs.transfersTitle.textContent = parts.length ? parts.join(' · ') : '暂无传输'
      refs.transfersTitle.className = receiving.length ? 'lp-friends-title-warn' : ''
    }
    if (refs.transfersActions) {
      const toggleFinished = btn(ui.showFinished ? '只看进行中' : `显示已完成${finished.length ? ` (${finished.length})` : ''}`, {
        size: 'sm',
        variant: 'ghost',
        disabled: !finished.length,
        onClick: () => {
          ui.showFinished = !ui.showFinished
          paintTransfers()
        }
      })
      const clearBtn = btn('清除已完成', {
        size: 'sm',
        variant: 'ghost',
        iconName: 'trash',
        disabled: !finished.length,
        onClick: () => void clearFinished()
      })
      const collapseBtn = iconBtn(ui.transfersCollapsed ? 'expand' : 'collapse', {
        label: ui.transfersCollapsed ? '展开传输列表' : '折叠传输列表',
        size: 14,
        onClick: () => {
          ui.transfersCollapsed = !ui.transfersCollapsed
          paintTransfers()
        }
      })
      refs.transfersActions.replaceChildren(toggleFinished, clearBtn, collapseBtn)
    }
    if (ui.transfersCollapsed) {
      refs.transfersBody.hidden = true
      refs.transfersBody.replaceChildren()
      return
    }
    refs.transfersBody.hidden = false
    const visible = ui.showFinished ? [...active, ...finished] : active
    if (!visible.length) {
      refs.transfersBody.replaceChildren(h('div', { class: 'lp-friends-hint' },
        finished.length ? '没有进行中的传输；点「显示已完成」查看历史。' : '没有进行中的传输。'))
      return
    }
    const pendingMods = items.filter((item) => item.direction === 'in' && item.status === 'ready' && item.kind === 'mod')
    const blocks = []
    if (pendingMods.length > 1) {
      blocks.push(h('div', { class: 'lp-transfer-bulk' },
        icon('download', { size: 14 }),
        h('span', { class: 'lp-transfer-bulk-text' }, `${pendingMods.length} 个模组文件等待接收，可以直接加入实例`),
        btn(`全部接收并加入实例 (${pendingMods.length})`, {
          size: 'sm',
          variant: 'primary',
          iconName: 'download',
          onClick: () => openBulkReceiveModal(pendingMods)
        })
      ))
    }
    blocks.push(...visible.map(transferRow))
    refs.transfersBody.replaceChildren(...blocks)
  }

  function transferRow(item) {
    let label = STATUS_LABEL[item.status] || item.status
    if (item.status === 'ready') label = item.direction === 'in' ? '等待下载' : '等待对方接收'
    const ratio = ratioOf(item)
    const actions = []
    if (item.direction === 'in' && item.status === 'ready') {
      actions.push(btn(item.kind === 'mod' ? '接收并加入实例' : '接收', {
        size: 'sm',
        variant: 'primary',
        iconName: 'download',
        onClick: () => openReceiveModal(item)
      }))
    }
    if (item.direction === 'in' && item.status === 'done' && item.path) {
      actions.push(btn('打开文件夹', {
        size: 'sm',
        variant: 'ghost',
        iconName: 'folder-open',
        onClick: () => ctx.openPath(item.path)
      }))
    }
    const outbound = item.direction === 'out' && !String(item.id).startsWith('local_')
    if (outbound && ['exporting', 'uploading'].includes(item.status)) {
      actions.push(btn('取消', { size: 'sm', variant: 'ghost', onClick: () => cancelTransfer(item.id) }))
    }
    if (outbound && item.status === 'ready') {
      actions.push(btn('撤回', { size: 'sm', variant: 'ghost', title: '从好友服务器删除这个待接收文件', onClick: () => cancelTransfer(item.id) }))
    }
    const extra = []
    if (item.direction === 'in' && item.status === 'done' && item.appliedTo) extra.push(badge('已加入实例', 'ok'))
    if (item.direction === 'in' && item.targetDir) extra.push(h('span', { class: 'lp-transfer-dir muted', title: item.targetDir }, shortPath(item.targetDir, 44)))
    return h('div', { class: 'lp-transfer-row' + (TRANSFER_FINISHED.has(item.status) ? ' is-finished' : '') },
      h('div', { class: 'lp-transfer-head' },
        h('b', { title: item.name || '文件' }, item.name || '文件'),
        badge(`${item.direction === 'in' ? '接收' : '发送'} · ${KIND_LABEL[item.kind] || '文件'}`, ''),
        peerLabel(item.peer || item.peerId) ? h('span', { class: 'lp-transfer-peer' }, peerLabel(item.peer || item.peerId)) : null,
        h('span', { class: 'lp-transfer-status' }, label)
      ),
      ratio === null ? null : progress(ratio).el,
      h('div', { class: 'lp-transfer-foot' },
        h('span', { class: 'muted' }, item.size ? `${fmtBytes(item.loaded || 0)} / ${fmtBytes(item.size)}` : item.error || ''),
        h('div', { class: 'lp-friend-actions' }, ...extra, ...actions)
      )
    )
  }

  async function clearFinished() {
    if (!(await ctx.confirm('清除已结束的传输记录？不会删除已经下载到磁盘的文件。', { title: '清除传输记录', okText: '清除' }))) return
    try {
      await ctx.api.friendsClearFinishedTransfers()
      toast('已清除完成记录', 'ok')
      await refreshData(true)
    } catch (error) {
      toast(error.message, 'err')
    }
  }

  /**
   * 接收弹窗：可以选保存目录、也可以直接指定要加入的实例。
   * 模组可以当场选一个实例，接收后直接写进该实例的 mods 目录，省掉手动搬运。
   */
  function openReceiveModal(item) {
    const prefs = data?.prefs || {}
    const isMod = item.kind === 'mod'
    const instances = ctx.getState().instances || []
    const preferred = isMod && prefs.autoApplyMods !== false ? String(ctx.getState().selectedId || '') : ''
    const dirInput = input({
      value: String(prefs.downloadDir || ''),
      placeholder: String(data?.defaultDownloadDir || '默认接收目录'),
      mono: true,
      title: '留空表示使用默认接收目录'
    })
    const browse = btn('选择目录…', {
      size: 'sm',
      iconName: 'folder',
      onClick: async () => {
        const dir = await ctx.pickDir(dirInput.value || data?.defaultDownloadDir || '', { title: '选择保存目录' })
        if (dir) dirInput.value = dir
      }
    })
    const defaultDirBtn = btn('使用默认', {
      size: 'sm',
      variant: 'ghost',
      onClick: () => { dirInput.value = '' }
    })
    const remember = toggle(false, () => {})
    const instanceSel = isMod && instances.length
      ? select([['', '仅保存文件，不加入实例'], ...instances.map((inst) => [inst.id, `${inst.name} · ${inst.mc}${inst.loader && inst.loader !== 'vanilla' ? ' · ' + inst.loader : ''}`])],
        instances.some((inst) => inst.id === preferred) ? preferred : '')
      : null
    const status = h('div', { class: 'lp-friends-modal-status' })
    const start = btn(isMod && instanceSel ? '接收' : '开始接收', {
      variant: 'primary',
      iconName: 'download',
      onClick: async () => {
        start.disabled = true
        status.textContent = ''
        try {
          await ctx.api.friendsDownload(item.id, {
            dir: dirInput.value.trim(),
            instanceId: instanceSel?.value || ''
          })
          if (remember.querySelector('input')?.checked && dirInput.value.trim()) {
            await ctx.api.friendsSaveSelf({ downloadDir: dirInput.value.trim() })
          }
          modal.close()
          toast(instanceSel?.value ? '已开始接收，完成后会直接加入实例 mods 目录' : '已开始接收，完成后可在「已接收文件」里操作', 'ok')
          refreshBadge()
          await refreshData(true)
        } catch (error) {
          status.textContent = '失败：' + error.message
          start.disabled = false
        }
      }
    })
    const modal = ctx.openModal({
      title: `接收文件 · ${item.name || '文件'}`,
      size: 'md',
      body: h('div', { class: 'lp-friends-modal' },
        h('div', { class: 'lp-friends-modal-note' },
          `${KIND_LABEL[item.kind] || '文件'} · ${fmtBytes(item.size || 0)} · 来自 ${peerLabel(item.peer || item.peerId) || item.peerName || '好友'}`),
        field('保存目录', h('div', { class: 'row', style: { gap: '6px' } }, dirInput, browse, defaultDirBtn), {
          hint: '留空 = 使用默认接收目录；也可以勾选下方「记住」把这里设为默认。'
        }),
        isMod && instanceSel
          ? field('接收后加入实例', instanceSel, { hint: '直接写入该实例的 mods 目录，不需要再手动搬运文件。' })
          : null,
        h('label', { class: 'row' }, remember, h('span', {}, '记住这个目录为默认下载目录')),
        h('div', { class: 'lp-friends-modal-note' }, '文件保存在好友服务器的中转区，接收完成后服务器会自动清理。'),
        status
      ),
      buttons: [{ label: '取消', onClick: (api) => api.close() }, start]
    })
  }

  async function cancelTransfer(id) {
    try {
      await ctx.api.friendsCancelTransfer(id)
      await refreshData(true)
    } catch (error) {
      toast(error.message, 'err')
    }
  }

  /** 一次性把等待接收的模组全部写进某个实例（不再逐个下载再手动搬运）。 */
  function openBulkReceiveModal(mods) {
    const instances = ctx.getState().instances || []
    if (!instances.length) {
      toast('还没有实例，先创建一个实例再接收模组', 'warn')
      return
    }
    const preferred = instances.find((inst) => inst.id === ctx.getState().selectedId) || instances[0]
    const sel = select(instances.map((inst) => [inst.id, `${inst.name} · ${inst.mc}${inst.loader && inst.loader !== 'vanilla' ? ' · ' + inst.loader : ''}`]), preferred.id)
    const status = h('div', { class: 'lp-friends-modal-status' })
    const bar = progress(0)
    let cancelled = false
    const go = btn('开始接收', {
      variant: 'primary',
      iconName: 'download',
      onClick: async () => {
        go.disabled = true
        let done = 0
        for (let index = 0; index < mods.length; index += 1) {
          if (cancelled) return
          const item = mods[index]
          status.textContent = `正在接收 ${item.name || '模组'}（${index + 1}/${mods.length}）…`
          bar.set(Math.round((index / mods.length) * 100))
          try {
            await ctx.api.friendsDownload(item.id, { instanceId: sel.value })
            done += 1
          } catch (error) {
            status.textContent = `${item.name || '模组'} 接收失败：${error.message}`
          }
        }
        bar.set(100)
        status.textContent = `已开始接收 ${done}/${mods.length} 个模组，完成后会直接出现在实例 mods 目录。`
        toast(`已接收 ${done} 个模组到实例`, done ? 'ok' : 'warn')
        refreshBadge()
        await refreshData(true)
        ctx.reload?.()
        setTimeout(() => { try { modal.close() } catch {} }, 900)
      }
    })
    const modal = ctx.openModal({
      title: `接收模组 · ${mods.length} 个文件`,
      size: 'md',
      body: h('div', { class: 'lp-friends-modal' },
        h('div', { class: 'lp-friends-modal-note' },
          '这些模组会下载并校验 SHA-1 后直接写入所选实例的 mods 目录，',
          '不需要再从中转目录里手动移动文件。'),
        field('加入实例', sel),
        bar.el,
        status
      ),
      buttons: [{ label: '取消', onClick: (api) => api.close() }, go]
    })
    modal.onClose = () => { cancelled = true }
  }

  // ---------------- 已接收文件 ----------------

  function paintReceived() {
    if (!refs.receivedBody || !data) return
    const items = data.received || []
    refs.receivedTitle.textContent = items.length ? `${items.length} 个` : ''
    if (refs.receivedClear) refs.receivedClear.disabled = !items.length
    if (ui.receivedCollapsed) {
      refs.receivedBody.hidden = true
      refs.receivedBody.replaceChildren()
      return
    }
    refs.receivedBody.hidden = false
    if (!items.length) {
      refs.receivedBody.replaceChildren(h('div', { class: 'lp-friends-hint' }, '还没有收到过文件。接收后的整合包与模组会出现在这里。'))
      return
    }
    refs.receivedBody.replaceChildren(...items.map(receivedRow))
  }

  /** 一键清除全部接收记录；默认接收目录里的暂存文件一并删除。 */
  async function clearReceivedRecords() {
    const items = data?.received || []
    if (!items.length) return
    const ok = await ctx.confirm(
      `清除全部 ${items.length} 条接收记录？\n\n默认接收目录里的暂存文件会一并删除；另存到其他目录的文件不受影响。`,
      { title: '清除接收记录', danger: true, okText: '清除' }
    )
    if (!ok) return
    try {
      const result = await ctx.api.friendsClearReceived()
      toast(result?.removed ? `已清除 ${result.removed} 条接收记录` : '没有可清除的记录', 'ok')
      await refreshData(true)
    } catch (error) {
      toast(error.message, 'err')
    }
  }

  function receivedRow(item) {
    const file = (item.files || [])[0]
    const isMod = item.kind === 'mod'
    const actions = []
    if (file) {
      if (isMod) {
        actions.push(btn('加入实例', {
          size: 'sm',
          variant: 'primary',
          iconName: 'add',
          onClick: () => openApplyModal(item)
        }))
      } else {
        actions.push(btn('安装整合包', {
          size: 'sm',
          variant: 'primary',
          iconName: 'download',
          onClick: () => ctx.installPackFromDownload({ path: file.path }, file.path)
        }))
      }
      actions.push(btn('打开文件夹', {
        size: 'sm',
        variant: 'ghost',
        iconName: 'folder-open',
        onClick: () => ctx.openPath(file.path)
      }))
      actions.push(btn('另存为…', {
        size: 'sm',
        variant: 'ghost',
        iconName: 'save',
        onClick: () => openSaveAsModal(item)
      }))
    }
    actions.push(btn('删除', {
      size: 'sm',
      variant: 'ghost',
      onClick: async () => {
        if (!(await ctx.confirm('删除这条接收记录？默认接收目录里的文件会一并删除，另存到其他目录的文件不受影响。', { title: '删除', danger: true, okText: '删除' }))) return
        try {
          await ctx.api.friendsRemoveReceived(item.id)
          await refreshData(true)
        } catch (error) {
          toast(error.message, 'err')
        }
      }
    }))
    return h('div', { class: 'lp-received-row' },
      h('div', { class: 'lp-received-main' },
        h('div', { class: 'lp-received-title' },
          h('b', { title: item.name }, item.name),
          badge(isMod ? '模组' : '整合包', isMod ? '' : 'info'),
          item.instanceName ? badge('→ ' + item.instanceName, 'ok') : null
        ),
        h('div', { class: 'lp-friend-meta' },
          h('span', {}, item.peerName || '好友'),
          h('span', { class: 'muted' }, fmtDateTime(item.at)),
          file ? h('span', { class: 'muted' }, fmtBytes(file.size)) : null,
          file ? h('span', { class: 'mono lp-received-path muted', title: file.path }, shortPath(file.path, 56)) : null
        )
      ),
      h('div', { class: 'lp-friend-actions' }, ...actions)
    )
  }

  function openSaveAsModal(item) {
    const file = (item.files || [])[0]
    if (!file) return
    const nameInput = input({ value: file.name, mono: true })
    const dirInput = input({
      value: String(data?.prefs?.downloadDir || data?.defaultDownloadDir || ''),
      mono: true,
      placeholder: '选择保存目录'
    })
    const browse = btn('选择…', {
      size: 'sm',
      iconName: 'folder',
      onClick: async () => {
        const dir = await ctx.pickDir(dirInput.value, { title: '选择另存为目录' })
        if (dir) dirInput.value = dir
      }
    })
    const status = h('div', { class: 'lp-friends-modal-status' })
    const save = btn('保存', {
      variant: 'primary',
      iconName: 'save',
      onClick: async () => {
        save.disabled = true
        status.textContent = ''
        try {
          const result = await ctx.api.friendsSaveReceivedAs(item.id, {
            dir: dirInput.value.trim(),
            name: nameInput.value.trim()
          })
          status.textContent = '已保存到：' + result.path
          toast('已另存为 ' + result.name, 'ok')
          save.disabled = false
          ctx.openPath?.(result.path)
        } catch (error) {
          status.textContent = '保存失败：' + error.message
          save.disabled = false
        }
      }
    })
    ctx.openModal({
      title: '另存为',
      size: 'md',
      body: h('div', { class: 'lp-friends-modal' },
        field('文件名', nameInput),
        field('保存到', h('div', { class: 'row', style: { gap: '6px' } }, dirInput, browse)),
        h('div', { class: 'lp-friends-modal-note' }, '原文件仍保留在接收目录，可随时再次另存。'),
        status
      ),
      buttons: [{ label: '关闭', onClick: (api) => api.close() }, save]
    })
  }

  function openApplyModal(item) {
    const instances = ctx.getState().instances || []
    if (!instances.length) {
      toast('还没有实例，先创建一个实例再添加模组', 'warn')
      return
    }
    const file = (item.files || [])[0]
    const preferred = instances.find((inst) => inst.id === item.instanceId)
      || instances.find((inst) => inst.id === ctx.getState().selectedId)
      || instances[0]
    const sel = select(instances.map((inst) => [inst.id, `${inst.name} · ${inst.mc}${inst.loader && inst.loader !== 'vanilla' ? ' · ' + inst.loader : ''}`]), preferred.id)
    const status = h('div', { class: 'lp-friends-modal-status' })
    const go = btn('加入实例', {
      variant: 'primary',
      iconName: 'add',
      onClick: async () => {
        go.disabled = true
        status.textContent = ''
        try {
          const result = await ctx.api.friendsApplyReceived(item.id, sel.value)
          toast('已加入实例「' + (result.instance?.name || '') + '」的 mods 目录', 'ok')
          modal.close()
          await refreshData(true)
          ctx.reload?.()
        } catch (error) {
          status.textContent = '失败：' + error.message
          go.disabled = false
        }
      }
    })
    const modal = ctx.openModal({
      title: '把模组加入实例',
      size: 'md',
      body: h('div', { class: 'lp-friends-modal' },
        h('div', { class: 'lp-friends-modal-note' },
          `${item.name} · ${fmtBytes(file?.size || 0)}，会复制到所选实例的 mods 目录并校验 SHA-1。`),
        field('实例', sel),
        status
      ),
      buttons: [{ label: '取消', onClick: (api) => api.close() }, go]
    })
  }

  // ---------------- 设置 ----------------

  function buildSettings() {
    const prefs = data.prefs || {}
    const nickname = input({ value: prefs.nickname || data.profile?.nickname || '', placeholder: '好友看到的昵称' })
    const showActivity = toggle(prefs.showActivity !== false, () => {})
    const autoApply = toggle(prefs.autoApplyMods !== false, () => {})
    const save = btn('保存设置', {
      variant: 'primary',
      iconName: 'check',
      onClick: async () => {
        save.disabled = true
        try {
          await ctx.api.friendsSaveSelf({
            nickname: nickname.value.trim(),
            showActivity: showActivity.querySelector('input')?.checked !== false,
            autoApplyMods: autoApply.querySelector('input')?.checked !== false
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
        h('label', { class: 'row' }, showActivity, h('span', {}, '向好友显示我正在玩的实例')),
        h('label', { class: 'row' }, autoApply, h('span', {}, '接收模组时默认加入当前选中的实例'))
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
    if (!refs.eventsBody || !data) return
    if (refs.diagToggle) {
      refs.diagToggle.replaceChildren(icon(ui.diagnosticsOpen ? 'chevron-down' : 'chevron-right', { size: 14 }))
      refs.diagToggle.title = ui.diagnosticsOpen ? '收起连接诊断' : '展开连接诊断'
      refs.diagToggle.setAttribute('aria-label', refs.diagToggle.title)
    }
    if (!ui.diagnosticsOpen) {
      refs.eventsBody.hidden = true
      refs.eventsBody.replaceChildren()
      return
    }
    refs.eventsBody.hidden = false
    const rows = [
      ['好友服务器', '官方服务器（内置）'],
      ['登录', data.loggedIn ? '已登录' : '未登录'],
      ['正版 ID', data.profile?.mcName || data.account?.mcName || '—'],
      ['默认接收目录', data.defaultDownloadDir || '—'],
      ['下载目录', data.prefs?.downloadDir || '（使用默认）'],
      ['服务器时间', data.serverTime ? fmtDateTime(data.serverTime) : '—']
    ].map(([label, value]) => h('div', { class: 'lp-friends-kv' },
      h('span', { class: 'muted' }, label),
      h('span', { class: 'mono', title: String(value) }, String(value))
    ))
    const events = (data.events || []).slice(0, 8).map((event) => h('div', { class: 'lp-friends-event' },
      h('span', { class: 'muted mono' }, new Date(event.at).toLocaleTimeString('zh-CN', { hour12: false })),
      h('span', { class: event.kind === 'err' || event.kind === 'warn' ? 'warn-text' : '' }, event.text)
    ))
    const children = [h('div', { class: 'lp-friends-kv-list' }, rows)]
    if (events.length) children.push(h('div', { class: 'lp-friends-event-list' }, h('div', { class: 'lp-friends-hint' }, '最近事件'), ...events))
    refs.eventsBody.replaceChildren(...children)
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
              toast('补齐完成，缺失的模组已直接写入实例 mods 目录', 'ok')
              current = await ctx.api.friendsCompareMods({ friendId: friend.uuid, instanceId: instanceSel.value })
              paintCompare()
              fillBtn.disabled = false
              sendBtn.disabled = false
              await refreshData(true)
              ctx.reload?.()
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
        status.textContent = `已上传 ${sent.count} 个模组文件，对方可在传输列表接收并直接加入实例`
        toast('已上传，等待对方接收', 'ok')
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
          '双方清单上传到好友服务器后对比。补齐时优先使用已收到的文件与 Modrinth，',
          '下载完成后直接写入当前实例的 mods 目录，不需要再手动搬运。'
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
      // 好友页自己就能算出角标数字，直接同步，避免每 2 秒多打一次通知接口。
      refreshBadge()
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
