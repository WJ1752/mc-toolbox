import { h, clear, copyText, fmtAgo, escapeHtml } from '/js/core/dom.js'
import { api } from '/js/core/api.js'
import { openModal, confirmDialog } from '/js/core/modal.js'
import { toast } from '/js/core/toast.js'

let ctxRef = null
let lastResult = null

export default {
  async mount(ctx) {
    ctxRef = ctx
    const s = ctx.settings()
    const type = s.network.defaultType || 'auto'

    const hostInput = h('input', { class: 'input mono', placeholder: 'mc.example.com 或 ip:端口', value: s.network.lastHost || '' })
    const portInput = h('input', { class: 'input mono', type: 'number', style: { width: '84px' }, value: s.network.javaPort })
    const typeSel = h('select', { class: 'input', style: { width: '96px' } },
      h('option', { value: 'auto' }, '自动'),
      h('option', { value: 'java' }, 'Java 版'),
      h('option', { value: 'bedrock' }, '基岩版'))
    typeSel.value = type

    const result = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' } })
    const btnTest = h('button', { class: 'btn btn-primary', onclick: () => run() }, '测试')

    typeSel.onchange = () => {
      portInput.value = typeSel.value === 'bedrock' ? ctx.settings().network.bedrockPort : ctx.settings().network.javaPort
    }

    ctx.body.appendChild(
      h('div', { class: 'field' }, h('label', {}, '服务器地址'), h('div', { class: 'row' }, h('div', { class: 'grow' }, hostInput), portInput, typeSel))
    )
    ctx.body.appendChild(h('div', { class: 'row' }, btnTest,
      h('button', { class: 'btn btn-sm', onclick: () => showRaw() }, '原始数据'),
      h('button', { class: 'btn btn-sm', onclick: () => addToMonitor() }, '加入监测'),
      h('span', { class: 'spacer' })
    ))
    ctx.body.appendChild(h('div', { class: 'hr' }))
    ctx.body.appendChild(result)

    hostInput.onkeydown = (e) => { if (e.key === 'Enter') run() }

    async function run() {
      const host = hostInput.value.trim()
      if (!host) {
        toast('请输入服务器地址', 'err')
        return
      }
      btnTest.disabled = true
      btnTest.textContent = '测试中…'
      clear(result)
      result.appendChild(h('div', { class: 'muted' }, '正在探测…'))
      ctx.setBadge('测试中', 'info')
      try {
        const r = await api.post('/api/ping', { host, port: Number(portInput.value) || undefined, type: typeSel.value })
        lastResult = r
        renderResult(r)
      } catch (e) {
        lastResult = null
        clear(result)
        result.appendChild(h('div', { class: 'result-bad' }, '探测失败：' + e.message))
        ctx.setBadge('失败', 'bad')
      } finally {
        btnTest.disabled = false
        btnTest.textContent = '测试'
        // 记住最近使用的地址
        try { await api.put('/api/settings', { network: { lastHost: host } }) } catch {}
      }
    }

    function renderResult(r) {
      clear(result)
      const d = r.data || {}
      const ok = r.ok
      ctx.setBadge(ok ? (r.latency != null ? Math.round(r.latency) + ' ms' : '在线') : '离线', ok ? 'ok' : 'bad')

      result.appendChild(
        h('div', { class: 'row' },
          h('span', { class: 'dot ' + (ok ? 'ok' : 'bad') }),
          h('strong', { style: { fontSize: '14px' } }, ok ? '服务器在线' : '无法连接'),
          h('span', { class: 'spacer' }),
          h('span', { class: 'badge ' + (r.edition === 'bedrock' ? 'info' : '') }, r.edition === 'bedrock' ? '基岩版' : 'Java 版')
        )
      )

      if (!ok) {
        result.appendChild(h('div', { class: 'result-bad' }, r.error || '未知错误'))
        result.appendChild(h('dl', { class: 'kv' },
          h('dt', {}, '目标'), h('dd', { class: 'mono' }, `${r.host}:${r.port}`),
          h('dt', {}, '解析地址'), h('dd', { class: 'mono' }, `${r.resolvedHost}:${r.resolvedPort}${r.viaSrv ? ' (SRV)' : ''}`)))
        return
      }

      if (d.favicon) {
        result.appendChild(h('div', { class: 'row', style: { gap: '10px' } },
          h('img', { src: d.favicon, style: { width: '48px', height: '48px', borderRadius: '8px', imageRendering: 'pixelated' }, alt: 'icon' }),
          h('div', { style: { minWidth: 0 } },
            h('div', { style: { fontWeight: '600' } }, d.motd || '(无 MOTD)'),
            h('div', { class: 'muted' }, `${d.version} · 协议 ${d.protocol ?? '-'}`))
        ))
      } else {
        result.appendChild(h('div', {}, h('div', { class: 'muted' }, 'MOTD'), h('div', {}, d.motd || '(无)')))
      }

      const p = d.players || {}
      result.appendChild(
        h('dl', { class: 'kv' },
          h('dt', {}, '延迟'), h('dd', { class: 'mono' }, `${r.latency} ms`),
          h('dt', {}, '在线玩家'), h('dd', {}, `${p.online ?? '-'} / ${p.max ?? '-'}`),
          h('dt', {}, '版本'), h('dd', {}, `${d.version}${d.modded ? '（可能为模组服）' : ''}`),
          h('dt', {}, '地址'), h('dd', { class: 'mono' }, `${r.host}:${r.port}${r.viaSrv ? ' → ' + r.resolvedHost + ':' + r.resolvedPort : ''}`),
          h('dt', {}, 'IP'), h('dd', { class: 'mono' }, r.ip || '-')
        )
      )

      if (p.sample?.length) {
        result.appendChild(h('div', { class: 'muted' }, '玩家列表（最多 24）'))
        result.appendChild(h('div', { class: 'pill-list' }, ...p.sample.map((x) => h('span', { class: 'pill' }, x.name))))
      }
      result.appendChild(h('div', { class: 'muted' }, '最后测试：' + fmtAgo(Date.now())))
    }

    function showRaw() {
      if (!lastResult) {
        toast('请先测试一次', 'err')
        return
      }
      const pre = h('pre', { class: 'mono scroll-y', style: { maxHeight: '55vh', margin: 0, whiteSpace: 'pre-wrap', fontSize: '12px' } }, JSON.stringify(lastResult, null, 2))
      openModal({
        title: '原始响应数据',
        size: 'lg',
        body: pre,
        buttons: [
          { label: '复制', onClick: async () => { await copyText(JSON.stringify(lastResult, null, 2)); toast('已复制', 'ok') } },
          { label: '关闭' }
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
        name: lastResult.data?.motd ? lastResult.data.motd.slice(0, 18) : lastResult.host
      })
      toast('已请求加入延迟监测', 'ok')
    }

    // 快捷测试：内置（Hypixel / 本地）+ 用户自定义；都可删除（删除前二次确认），新增走弹窗设置框
    const quickWrap = h('div', { class: 'row wrap', style: { gap: '6px', alignItems: 'center' } })
    const btnQuickAdd = h('button', { class: 'btn btn-sm', onclick: openAddQuick }, '＋ 快捷')

    let quicks = Array.isArray(s.serverstatus?.quicks) ? s.serverstatus.quicks.map((q) => ({ ...q })) : []
    let removedBuiltins = new Set(Array.isArray(s.serverstatus?.removed) ? s.serverstatus.removed : [])
    const BUILTIN = [
      { id: 'b-hypixel', alias: 'Hypixel', host: 'mc.hypixel.net', port: 25565, type: 'java', builtin: true },
      { id: 'b-local', alias: '本地 25565', host: '127.0.0.1', port: 25565, type: 'java', builtin: true }
    ]

    function persistQuicks() {
      try { api.put('/api/settings', { serverstatus: { quicks } }) } catch {}
    }
    function persistRemoved() {
      try { api.put('/api/settings', { serverstatus: { removed: [...removedBuiltins] } }) } catch {}
    }

    function renderQuick() {
      clear(quickWrap)
      quickWrap.appendChild(h('span', { class: 'muted' }, '快捷：'))
      const all = [...BUILTIN.filter((b) => !removedBuiltins.has(b.id)), ...quicks]
      if (!all.length) quickWrap.appendChild(h('span', { class: 'muted' }, '（暂无，点击 ＋ 快捷 添加）'))
      for (const q of all) {
        const chip = h('span', { class: 'pill', style: { cursor: 'pointer' }, title: `${q.host}:${q.port}`, onclick: () => useQuick(q) },
          (q.alias || q.host),
          h('span', { class: 'muted', style: { marginLeft: '6px', cursor: 'pointer' }, onclick: (e) => { e.stopPropagation(); removeQuick(q) } }, ' ✕'))
        quickWrap.appendChild(chip)
      }
      quickWrap.appendChild(btnQuickAdd)
    }

    async function removeQuick(q) {
      const ok = await confirmDialog(`删除快捷项「${q.alias || q.host}」（${q.host}:${q.port}）？`, { danger: true })
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
      portInput.value = q.port
      typeSel.value = q.type || 'auto'
      if (typeSel.value === 'auto') typeSel.onchange()
      run()
    }

    function openAddQuick() {
      const alias = h('input', { class: 'input', placeholder: '别名（显示在快捷上）', style: { width: '220px' } })
      const host = h('input', { class: 'input mono', placeholder: '域名 / IP，如 mc.example.com' })
      const port = h('input', { class: 'input mono', type: 'number', value: '25565' })
      const type = h('select', { class: 'input' },
        h('option', { value: 'auto' }, '自动'),
        h('option', { value: 'java' }, 'Java 版'),
        h('option', { value: 'bedrock' }, '基岩版'))
      const body = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
        h('div', { class: 'field' }, h('label', {}, '别名'), alias),
        h('div', { class: 'row' },
          h('div', { class: 'field grow' }, h('label', {}, '域名 / IP'), host),
          h('div', { class: 'field' }, h('label', {}, '端口'), port),
          h('div', { class: 'field' }, h('label', {}, '类型'), type))
      )
      const modal = openModal({
        title: '添加快捷测试',
        body,
        buttons: [
          { label: '取消' },
          {
            label: '保存', class: 'btn-primary',
            onClick: async (m) => {
              const h = host.value.trim()
              if (!h) { toast('请填写域名 / IP', 'err'); return }
              const a = alias.value.trim() || h
              quicks = quicks.filter((x) => !(x.alias === a && x.host === h))
              quicks.push({ alias: a, host: h, port: Number(port.value) || 25565, type: type.value })
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
    }

    ctx.body.appendChild(h('div', { class: 'hr' }))
    ctx.body.appendChild(quickWrap)
    renderQuick()
  },

  renderExpanded(container, { ctx } = {}) {
    const c = ctx || ctxRef
    container.appendChild(h('div', { class: 'muted' }, '在展开视图中也可以使用完整功能，内容更大更易读。'))
    const wrap = h('div')
    container.appendChild(wrap)
    if (c) this.mount({ ...c, body: wrap })
  }
}
