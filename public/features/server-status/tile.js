import { h, clear, copyText, fmtAgo, escapeHtml, sanitizeMinecraftHtml } from '/js/core/dom.js'
import { api } from '/js/core/api.js'
import { attachHostPortInput } from '/js/core/address.js'
import { openModal, confirmDialog } from '/js/core/modal.js'
import { toast } from '/js/core/toast.js'
import { icon } from '/js/ui/icons.js'
import { btn, input, select, field, emptyState, errorState, spinner } from '/js/ui/kit.js'

const BUILTIN = [
  { id: 'b-hypixel', alias: 'Hypixel', host: 'mc.hypixel.net', port: 25565, type: 'java', builtin: true },
  { id: 'b-local', alias: '本地 25565', host: '127.0.0.1', port: 25565, type: 'java', builtin: true }
]

const METRIC_LABEL = { java: 'Java 版', bedrock: '基岩版' }

export default {
  async mount(ctx) {
    buildStatus(ctx, ctx.body, { expanded: false })
  },

  renderExpanded(container, { ctx } = {}) {
    buildStatus(ctx, container, { expanded: true })
  }
}

function buildStatus(ctx, container, { expanded }) {
  if (!ctx) return
  const s = ctx.settings()
  const net = s.network || {}
  let quicks = Array.isArray(s.serverstatus?.quicks) ? s.serverstatus.quicks.map((q) => ({ ...q })) : []
  let removedBuiltins = new Set(Array.isArray(s.serverstatus?.removed) ? s.serverstatus.removed : [])
  let lastResult = null
  let busy = false
  let disposed = false

  const hostInput = input({
    value: net.lastHost || '',
    placeholder: 'mc.example.com 或 ip:端口',
    mono: true,
    onKeyDown: (e) => { if (e.key === 'Enter') run() }
  })
  hostInput.setAttribute('aria-label', '服务器地址')
  const portInput = input({ type: 'number', value: net.javaPort ?? 25565, mono: true, class: 'w-12' })
  portInput.style.width = '78px'
  portInput.setAttribute('aria-label', '端口')
  portInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') run() })
  // 地址框支持直接粘贴「主机:端口」，粘贴 / 失焦 / 回车时自动拆到地址和端口两个框
  const addrPair = attachHostPortInput(hostInput, portInput)
  const typeSel = select([['auto', '自动'], ['java', 'Java 版'], ['bedrock', '基岩版']], net.defaultType || 'auto', { ariaLabel: '服务器类型' })
  typeSel.style.width = '96px'
  typeSel.onchange = () => {
    portInput.value = String(typeSel.value === 'bedrock' ? (net.bedrockPort ?? 19132) : (net.javaPort ?? 25565))
  }

  const btnTest = btn('测试', { variant: 'primary', iconName: 'signal', onClick: () => run() })
  btnTest.style.height = '30px'

  const result = h('div', { class: 'col', style: { gap: '8px' } })
  const quickWrap = h('div', { class: 'ss-quickbar' })
  const btnAddQuick = btn('快捷', { size: 'xs', iconName: 'add', onClick: openAddQuick })
  btnAddQuick.classList.add('ss-chip')
  btnAddQuick.style.padding = '0 8px'

  const form = h('div', { class: 'ss-form' },
    field('服务器地址', hostInput),
    field('端口', portInput),
    field('类型', typeSel),
    h('div', { class: 'field' }, h('label', {}, '探测'), btnTest)
  )

  const btnRaw = btn('原始数据', { size: 'xs', onClick: showRaw })
  const btnJoin = btn('加入监测', { size: 'xs', onClick: addToMonitor })
  const actions = h('div', { class: 'fx-actions' }, btnRaw, btnJoin)

  renderQuick()
  showInitial()

  container.append(
    h('div', { class: 'col', style: { gap: '8px' } },
      form,
      h('div', { class: 'row wrap', style: { gap: '6px', justifyContent: 'space-between' } },
        actions,
        quickWrap
      ),
      h('div', { class: 'hr', style: { margin: '2px 0' } }),
      result
    )
  )

  function persistQuicks() {
    api.put('/api/settings', { serverstatus: { quicks } }).then(() => {
      try { ctx.settings().serverstatus.quicks = quicks } catch {}
    }).catch((e) => toast('快捷测试保存失败：' + e.message, 'err'))
  }

  function persistRemoved() {
    api.put('/api/settings', { serverstatus: { removed: [...removedBuiltins] } }).then(() => {
      try { ctx.settings().serverstatus.removed = [...removedBuiltins] } catch {}
    }).catch((e) => toast('快捷测试保存失败：' + e.message, 'err'))
  }

  function renderQuick() {
    clear(quickWrap)
    quickWrap.appendChild(h('span', { class: 'q-label' }, '快捷'))
    const all = [...BUILTIN.filter((b) => !removedBuiltins.has(b.id)), ...quicks]
    if (!all.length) {
      quickWrap.appendChild(h('span', { class: 'muted', style: { fontSize: '11px' } }, '暂无快捷，点击「＋ 快捷」添加'))
    }
    for (const q of all) {
      const chip = h('span', {
        class: 'ss-chip',
        title: `${q.host}:${q.port} · ${METRIC_LABEL[q.type] || '自动'}`,
        onclick: () => useQuick(q)
      },
        h('span', {}, q.alias || q.host),
        h('button', {
          class: 'x',
          type: 'button',
          title: '删除此快捷',
          'aria-label': '删除此快捷',
          onclick: (e) => { e.stopPropagation(); removeQuick(q) }
        }, icon('close', { size: 11 }))
      )
      quickWrap.appendChild(chip)
    }
    quickWrap.appendChild(btnAddQuick)
  }

  async function removeQuick(q) {
    const ok = await confirmDialog(`删除快捷项「${q.alias || q.host || q.host}」（${q.host}:${q.port}）？`, { danger: true })
    if (!ok) return
    if (q.builtin) {
      removedBuiltins.add(q.id)
      persistRemoved()
      toast('已删除该内置快捷', 'ok')
    } else {
      quicks = quicks.filter((x) => x !== q)
      persistQuicks()
      toast('已删除快捷项', 'ok')
    }
    renderQuick()
  }

  function useQuick(q) {
    hostInput.value = q.host
    portInput.value = String(q.port)
    typeSel.value = q.type || 'auto'
    if (typeSel.value === 'auto') typeSel.onchange()
    run()
  }

  function openAddQuick() {
    const alias = input({ placeholder: '别名（显示在快捷上）' })
    const host = input({ placeholder: '域名 / IP，如 mc.example.com', mono: true })
    const port = input({ type: 'number', value: '25565', mono: true })
    // 快捷项同样支持粘贴「域名:端口」
    const addrQuick = attachHostPortInput(host, port)
    const type = select([['auto', '自动'], ['java', 'Java 版'], ['bedrock', '基岩版']], 'java')
    const body = h('div', { class: 'col', style: { gap: '9px' } },
      field('别名', alias),
      h('div', { class: 'field-grid' }, field('域名 / IP', host), field('端口', port), field('类型', type))
    )
    const modal = openModal({
      title: '添加快捷测试',
      size: 'sm',
      body,
      buttons: [
        { label: '取消', class: 'btn-ghost' },
        {
          label: '保存',
          class: 'btn-primary',
          onClick: async (m) => {
            addrQuick.flush()
            const hv = host.value.trim()
            if (!hv) { toast('请填写域名 / IP', 'err'); host.focus(); return }
            const a = alias.value.trim() || hv
            const pv = Number(port.value) || 25565
            if (!Number.isInteger(pv) || pv < 1 || pv > 65535) { toast('端口需为 1–65535', 'err'); port.focus(); return }
            quicks = quicks.filter((x) => !(x.alias === a && x.host === hv))
            quicks.push({ alias: a, host: hv, port: pv, type: type.value })
            persistQuicks()
            m.close()
            toast('已添加快捷：' + a, 'ok')
            renderQuick()
          }
        }
      ]
    })
    modal.foot.querySelector('.btn-primary')?.focus()
    alias.focus()
    void expanded
  }

  function showInitial() {
    if (busy) return
    clear(result)
    result.appendChild(h('div', { class: 'ss-empty' },
      h('div', { class: 'row', style: { justifyContent: 'center', gap: '7px' } },
        icon('signal', { size: 16 }),
        h('span', {}, '输入服务器地址后点击测试，或选择上方快捷项')
      )
    ))
  }

  async function run() {
    // 回车 / 点「测试」时先补一次拆分，避免用户没触发 blur 就提交「host:port」
    addrPair.flush()
    const host = hostInput.value.trim()
    if (!host) {
      toast('请输入服务器地址', 'err')
      hostInput.focus()
      return
    }
    if (busy) return
    busy = true
    btnTest.disabled = true
    btnTest.classList.add('loading')
    btnTest.textContent = '测试中'
    ctx.setBadge('测试中', 'info')
    clear(result)
    result.appendChild(h('div', { class: 'row', style: { gap: '8px', color: 'var(--mute)', padding: '10px 0' } }, spinner(13), '正在探测…'))
    try {
      const r = await api.post('/api/ping', { host, port: Number(portInput.value) || undefined, type: typeSel.value })
      lastResult = r
      renderResult(r)
    } catch (e) {
      lastResult = null
      clear(result)
      result.appendChild(errorState('探测失败', e.message, btn('重试', { size: 'sm', iconName: 'refresh', onClick: run })))
      ctx.setBadge('失败', 'bad')
    } finally {
      busy = false
      btnTest.disabled = false
      btnTest.classList.remove('loading')
      btnTest.textContent = '测试'
      btnRaw.disabled = false
      btnJoin.disabled = false
      try { await api.put('/api/settings', { network: { lastHost: host } }) } catch {}
    }
  }

  function renderResult(r) {
    clear(result)
    const d = r.data || {}
    const ok = !!r.ok
    ctx.setBadge(ok ? (r.latency != null ? Math.round(r.latency) + ' ms' : '在线') : '离线', ok ? 'ok' : 'bad')

    const iconBox = h('div', { class: 'ss-icon' })
    if (ok && d.favicon) {
      const img = h('img', { src: d.favicon, alt: '服务器图标' })
      img.onerror = () => { clear(iconBox); iconBox.appendChild(icon('signal', { size: 26 })) }
      iconBox.appendChild(img)
    } else {
      iconBox.appendChild(icon(ok ? 'signal' : 'x-circle', { size: 26 }))
    }

    const motd = h('div', { class: 'ss-motel' })
    if (ok) motd.innerHTML = sanitizeMinecraftHtml(d.motd || '(无 MOTD)')
    else motd.textContent = '无法连接'

    const main = h('div', { class: 'ss-main' },
      h('div', { class: 'row wrap', style: { gap: '6px' } },
        h('span', { class: 'dot ' + (ok ? 'ok' : 'bad') }),
        h('strong', { style: { fontSize: '13px' } }, ok ? '服务器在线' : '无法连接'),
        h('span', { class: 'badge ' + (r.edition === 'bedrock' ? 'info' : '') }, r.edition === 'bedrock' ? '基岩版' : 'Java 版'),
        h('span', { class: 'spacer' }),
        ok && d.modded ? h('span', { class: 'badge warn', title: '检测到模组/插件信息' }, '模组服') : null
      ),
      motd
    )

    if (!ok) {
      main.appendChild(h('div', { class: 'result-bad', style: { fontSize: '11.5px', marginTop: '2px' } }, r.error || '未知错误'))
      main.appendChild(h('div', { class: 'ss-facts' },
        h('div', { class: 'ss-fact' }, h('label', {}, '目标'), h('b', { class: 'mono' }, `${r.host}:${r.port}`)),
        h('div', { class: 'ss-fact' }, h('label', {}, '解析'), h('b', { class: 'mono' }, `${r.resolvedHost}:${r.resolvedPort}${r.viaSrv ? ' (SRV)' : ''}`)),
        h('div', { class: 'ss-fact' }, h('label', {}, '最后测试'), h('b', {}, fmtAgo(Date.now())))
      ))
      result.appendChild(h('div', { class: 'ss-profile offline' }, iconBox, main))
      result.appendChild(resultFoot(r, ok))
      return
    }

    main.appendChild(h('div', { class: 'ss-version' }, `${d.version || '未知版本'} · 协议 ${d.protocol ?? '-'}`))
    const p = d.players || {}
    main.appendChild(h('div', { class: 'ss-facts' },
      h('div', { class: 'ss-fact' }, h('label', {}, '延迟'), h('b', { class: 'mono' }, `${r.latency} ms`)),
      h('div', { class: 'ss-fact' }, h('label', {}, '在线玩家'), h('b', { class: 'mono' }, `${p.online ?? '-'} / ${p.max ?? '-'}`)),
      h('div', { class: 'ss-fact' }, h('label', {}, '解析地址'), h('b', { class: 'mono' }, `${r.resolvedHost}:${r.resolvedPort}`))
    ))

    result.appendChild(h('div', { class: 'ss-profile' }, iconBox, main))
    if (Array.isArray(p.sample) && p.sample.length) {
      result.appendChild(h('div', { class: 'col', style: { gap: '4px' } },
        h('div', { class: 'mini-label' }, `玩家列表 · 最多 24 · ${p.sample.length}`),
        h('div', { class: 'ss-players' }, ...p.sample.map((x) => h('span', { class: 'ss-player' }, x.name)))
      ))
    }
    result.appendChild(resultFoot(r, ok))
  }

  function resultFoot(r, ok) {
    const bits = []
    bits.push(h('span', { class: 'mono' }, `${r.host}:${r.port}`))
    if (r.viaSrv) bits.push(h('span', { class: 'mono' }, `→ ${r.resolvedHost}:${r.resolvedPort}`))
    if (r.ip) bits.push(h('span', { class: 'mono' }, `IP ${r.ip}`))
    if (ok && r.data?.modded) bits.push(h('span', { class: 'badge warn' }, '可能为模组服'))
    bits.push(h('span', { class: 'spacer' }))
    bits.push(h('span', {}, '最后测试：' + fmtAgo(Date.now())))
    return h('div', { class: 'ss-foot' }, ...bits)
  }

  function showRaw() {
    if (!lastResult) {
      toast('请先测试一次', 'err')
      return
    }
    const json = JSON.stringify(lastResult, null, 2)
    const pre = h('pre', {
      class: 'mono scroll-y',
      style: { maxHeight: '55vh', margin: 0, whiteSpace: 'pre-wrap', fontSize: '11.5px', lineHeight: '1.55', overflowWrap: 'anywhere' }
    }, json)
    openModal({
      title: '原始响应数据',
      size: 'lg',
      body: pre,
      buttons: [
        { label: '复制', onClick: async () => { const ok = await copyText(json); toast(ok ? '已复制' : '复制失败', ok ? 'ok' : 'err') } },
        { label: '关闭', class: 'btn-primary' }
      ]
    })
  }

  function addToMonitor() {
    if (!lastResult) {
      toast('请先测试一次', 'err')
      return
    }
    ctx.bus.emit('monitor:request-add', {
      host: lastResult.host,
      port: lastResult.port,
      type: lastResult.edition === 'bedrock' ? 'bedrock' : 'java',
      name: lastResult.data?.motd ? String(lastResult.data.motd).slice(0, 18) : lastResult.host
    })
    toast('已请求加入延迟监测', 'ok')
  }
}
