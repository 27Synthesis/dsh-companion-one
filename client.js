/**
 * companion-one — 设置面板（Client 半边）。
 * 以 dsh.client bundle 格式加载；注册 settings.section「陪伴」页。
 * 数据全部走 Host 的 /companion-one/api（与工具共用同一套实现）。
 * 样式只用 --dsw-alias-* 主题 token，不引入其它 Harness Client 包。
 */
window.__ModuleLoader__.load({
  id: 'companion-one',
  factory: (require) => {
    const React = require('react')
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const h = React.createElement
    const { useState, useEffect, useCallback, useMemo } = React

    const CSS = [
      '.co-panel{padding:2px 0 8px;font-size:13px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:12px}',
      '.co-tabs{display:flex;gap:4px;flex-wrap:wrap;border-bottom:1px solid var(--dsw-alias-border-l1);padding-bottom:6px}',
      '.co-subtabs{display:flex;gap:4px;flex-wrap:wrap;padding:6px 0 2px 6px}',
      '.co-subtab{font-size:12px;padding:4px 9px;opacity:.85}',
      '.co-tab{background:transparent;border:none;color:var(--dsw-alias-label-secondary);padding:6px 10px;border-radius:6px;cursor:pointer;font-size:13px}',
      '.co-tab:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.co-tab.on{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-brand-primary);font-weight:600}',
      '.co-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.co-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:10px 12px;background:var(--dsw-alias-bg-layer-1);display:flex;flex-direction:column;gap:8px}',
      '.co-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary);letter-spacing:.03em}',
      '.co-muted{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.co-input,.co-textarea,.co-select{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:6px 10px;font-size:13px;outline:none;font-family:inherit;flex:1;min-width:120px}',
      '.co-textarea{resize:vertical;min-height:54px;width:100%}',
      '.co-btn{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:5px 12px;font-size:13px;cursor:pointer}',
      '.co-btn:hover{border-color:var(--dsw-alias-brand-primary)}',
      '.co-btn[disabled]{opacity:.5;cursor:default}',
      '.co-btn-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);border-color:var(--dsw-alias-button-primary-fill)}',
      '.co-list{display:flex;flex-direction:column;gap:6px;max-height:46vh;overflow:auto}',
      '.co-item{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:7px 10px;display:flex;flex-direction:column;gap:4px;background:var(--dsw-alias-bg-base)}',
      '.co-item .co-meta{font-size:11px;color:var(--dsw-alias-label-secondary);display:flex;gap:8px;flex-wrap:wrap}',
      '.co-pill{font-size:11px;padding:1px 7px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}',
      '.co-pill.warn{color:var(--dsw-alias-label-warning, var(--dsw-alias-brand-primary))}',
      '.co-switch{position:relative;width:38px;height:21px;border-radius:999px;background:var(--dsw-alias-border-l1);cursor:pointer;flex:none;border:none;padding:0}',
      '.co-switch::after{content:"";position:absolute;top:2px;left:2px;width:17px;height:17px;border-radius:50%;background:var(--dsw-alias-bg-base);transition:transform .15s ease}',
      '.co-switch.on{background:var(--dsw-alias-brand-primary)}',
      '.co-switch.on::after{transform:translateX(17px)}',
      '.co-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px}',
      '.co-kv{display:flex;justify-content:space-between;gap:8px;font-size:12px}',
      '.co-empty{font-size:12px;color:var(--dsw-alias-label-secondary);padding:8px 0}',
    ].join('\n')

    async function api(op, args, method) {
      const qs = new URLSearchParams({ op })
      const isGet = !method || method === 'GET'
      if (isGet && args) for (const [k, v] of Object.entries(args)) if (v !== undefined && v !== null) qs.set(k, String(v))
      const res = await fetch('/companion-one/api?' + qs.toString(), isGet
        ? undefined
        : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op, ...(args || {}) }) })
      const body = await res.json()
      if (!body.ok) throw new Error(body.error || 'request failed')
      return body.data
    }

    function Switch({ on, onChange, title }) {
      return h('button', { className: 'co-switch' + (on ? ' on' : ''), title, onClick: () => onChange(!on) })
    }

    function Row({ children }) { return h('div', { className: 'co-row' }, children) }

    /** 当前会话 id 从地址栏拿（设置面板没有直接的 session 上下文）。 */
    function sessionIdFromHash() {
      const m = /#\/session\/([^/?#]+)/.exec(window.location.hash || '')
      return m ? decodeURIComponent(m[1]) : ''
    }

    function WhoCard({ data, refresh }) {
      const sid = useMemo(() => sessionIdFromHash(), [])
      const [scope, setScope] = useState(data.scope || '')
      const [msg, setMsg] = useState('')
      useEffect(() => { setScope(data.scope || '') }, [data.scope])
      const save = async () => {
        if (!sid) { setMsg('分不清当前会话：请先点进一个对话，再打开这个面板'); return }
        try {
          await api('setScope', { sessionId: sid, scope: scope.trim() }, 'POST')
          setMsg(scope.trim() ? '已绑定，下一条消息起按这个对象隔离' : '已解除绑定')
          refresh()
        } catch (e) { setMsg('保存失败：' + (e.message || e)) }
      }
      return h('div', { className: 'co-card', key: 'who' }, [
        h('div', { className: 'co-title', key: 't' }, '这是谁（把当前会话绑到一个对话对象）'),
        h(Row, { key: 'r' }, [
          h('input', {
            key: 'i', className: 'co-input', value: scope,
            placeholder: '比如 peer:u1、妈妈、同事张三（留空=解除）',
            onChange: (e) => setScope(e.target.value),
          }),
          h('button', { key: 'b', className: 'co-btn co-btn-primary', onClick: () => save().catch(() => {}) }, '绑定'),
        ]),
        h('div', { key: 'm', className: 'co-muted' }, msg || ('会话：' + (sid || '未知') + ' · 记忆与惦记按这个键隔离')),
      ])
    }

    function Overview({ data, refresh, busy }) {
      const s = data.settings || {}
      const set = async (key, value) => { await api('setSetting', { key, value }, 'POST'); refresh() }
      const layers = data.layers || {}
      const ss = data.sessionState || {}
      const toggles = [
        ['memory', '七层记忆'], ['compression', '压缩引擎'], ['companion', '陪伴行为层'],
        ['style', '沟通风格学习'], ['persona', '可塑人格'], ['voicePack', '文风包进 ⑤ 区'],
      ]
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } }, [
        h('div', { className: 'co-card', key: 'sw' }, [
          h('div', { className: 'co-title', key: 't' }, '子系统开关'),
          ...toggles.map(([key, label]) => h(Row, { key }, [
            h(Switch, { key: 's', on: !!s[key], onChange: (v) => set(key, v) }),
            h('span', { key: 'l' }, label),
          ])),
          h(Row, { key: 'frozen' }, [
            h(Switch, { key: 's', on: !!s.personaFrozen, onChange: async (v) => { await api('setSetting', { key: 'personaFrozen', value: v }, 'POST'); refresh() } }),
            h('span', { key: 'l' }, '冻结人格（只读不写）'),
          ]),
        ]),
        h('div', { className: 'co-card', key: 'st' }, [
          h('div', { className: 'co-title', key: 't' }, '状态'),
          h('div', { className: 'co-kv', key: 'k1' }, [h('span', { key: 'a' }, '当前对话对象'), h('span', { key: 'b' }, data.scope || 'global')]),
          h('div', { className: 'co-kv', key: 'k2' }, [h('span', { key: 'a' }, '压缩块'), h('span', { key: 'b' }, String((data.blocks || []).length))]),
          h('div', { className: 'co-kv', key: 'k3' }, [h('span', { key: 'a' }, '累计节省 tokens（估算）'), h('span', { key: 'b' }, String(data.tokensSaved || 0))]),
          h('div', { className: 'co-kv', key: 'k4' }, [h('span', { key: 'a' }, '惦记的事'), h('span', { key: 'b' }, String((data.followUps || []).filter((f) => f.status === 'open' || f.status === 'asked').length))]),
          h('div', { className: 'co-kv', key: 'k5' }, [h('span', { key: 'a' }, '危机等级'), h('span', { key: 'b' }, String((data.crisis && data.crisis.level) || 0))]),
        ]),
        h('div', { className: 'co-card', key: 'mood' }, [
          h('div', { key: 't', className: 'co-title' }, '此刻心情'),
          h('div', { key: 'm', style: { fontSize: 15, fontWeight: 600 } }, ss.mood || '还没听到主人说话，我在旁边等着'),
          h('div', { key: 'w', className: 'co-muted' }, ss.moodWhy || (ss.mood ? '' : '聊一句就有了')),
          h('div', { key: 'kv', style: { display: 'flex', flexDirection: 'column', gap: 2 } }, [
            h('div', { key: 'u', className: 'co-kv' }, [h('span', {}, '主人此刻'), h('span', {}, ss.userState || '—')]),
            h('div', { key: 'v', className: 'co-kv' }, [h('span', {}, '情绪值'), h('span', {}, ss.mood ? Number(ss.valence || 0).toFixed(2) : '—')]),
            h('div', { key: 'p', className: 'co-kv' }, [h('span', {}, '上下文压力'), h('span', {}, ss.mood ? Math.round(Number(ss.pressure || 0)) + '%' : '—')]),
            h('div', { key: 'n', className: 'co-kv' }, [h('span', {}, '本会话轮数'), h('span', {}, String(ss.userMsgs || 0))]),
          ]),
          ss.updatedAt ? h('div', { key: 'at', className: 'co-muted' }, '更新于 ' + new Date(ss.updatedAt).toLocaleString()) : null,
        ]),
        h('div', { className: 'co-card', key: 'heart' }, [
          h('div', { key: 't', className: 'co-title' }, '心声（最近一句）'),
          data.heartVoice
            ? h('div', { key: 'c', style: { display: 'flex', flexDirection: 'column', gap: 4 } }, [
              h('div', { key: 'x', style: { fontSize: 13 } }, String(data.heartVoice.content)),
              h('div', { key: 'm', className: 'co-muted' },
                (data.heartVoice.source === 'auto' ? '自动' : '模型') + (data.heartVoice.mood ? ' · ' + data.heartVoice.mood : '') + ' · ' + new Date(data.heartVoice.created_at).toLocaleString()),
            ])
            : h('div', { key: 'e', className: 'co-muted' }, '这轮还没写，聊一句就有了'),
        ]),
        h(WhoCard, { key: 'who', data, refresh }),
        h('div', { className: 'co-card', key: 'ly' }, [
          h('div', { className: 'co-title', key: 't' }, '七层记忆'),
          h('div', { className: 'co-grid', key: 'g' }, Object.entries(layers).map(([k, v]) =>
            h('div', { key: k, className: 'co-item' }, [
              h('div', { key: 'l' }, v.label),
              h('div', { key: 'n', className: 'co-meta' }, v.active + ' 条有效 / 共 ' + v.total),
            ]))),
        ]),
      ])
    }

    function MemoryImport({ data, refresh }) {
      const [scan, setScan] = useState(null)
      const [busy, setBusy] = useState('')
      const [msg, setMsg] = useState('')
      const [sourceId, setSourceId] = useState('all')
      const [scope, setScope] = useState(data.scope || 'global')
      const [result, setResult] = useState(null)
      const doScan = async () => {
        setBusy('scan')
        try { setScan(await api('memoryImportScan')); setMsg('') }
        catch (e) { setMsg('扫描失败：' + (e.message || e)) }
        finally { setBusy('') }
      }
      const doImport = async () => {
        setBusy('run')
        try {
          const r = await api('memoryImportRun', { sourceId, scope: scope.trim() || 'global' }, 'POST')
          setResult(r)
          setMsg(r.ok === false ? '没找到可导入的来源' : '导入完成')
          refresh()
        } catch (e) { setMsg('导入失败：' + (e.message || e)) }
        finally { setBusy('') }
      }
      const sources = (scan && scan.sources) || []
      return h('div', { className: 'co-card', key: 'imp' }, [
        h('div', { key: 't', className: 'co-title' }, '合并其他插件的记忆'),
        h('div', { key: 'h', className: 'co-muted' }, '只读扫描已装的记忆插件（Mnemon 运行时记忆 / 项目文档、其它 SQLite 记忆表），按本插件七层规则分类后导入。源数据不会被改动，重复内容会自动合并。'),
        h(Row, { key: 'r1' }, [
          h('button', { key: 'b', className: 'co-btn', disabled: busy === 'scan', onClick: () => doScan().catch(() => {}) }, busy === 'scan' ? '扫描中…' : '扫描来源'),
          scan ? h('span', { key: 's', className: 'co-muted' }, '共 ' + (scan.total || 0) + ' 条 / ' + sources.length + ' 个来源') : null,
        ]),
        sources.length
          ? h('div', { key: 'list', className: 'co-list', style: { maxHeight: '30vh' } }, sources.map((s) =>
            h('div', { key: s.id, className: 'co-item' }, [
              h(Row, { key: 'r' }, [
                h('strong', { key: 'n', style: { flex: 1 } }, s.label),
                h('span', { key: 'c', className: 'co-pill' }, s.count + ' 条'),
              ]),
              h('div', { key: 'b', className: 'co-meta' }, Object.entries(s.byLayer || {}).map(([k, v]) => h('span', { key: k, className: 'co-pill' }, k + ' ' + v))),
              h('div', { key: 'p', className: 'co-muted', style: { wordBreak: 'break-all' } }, String(s.path || '').slice(0, 110)),
              h('div', { key: 'x', className: 'co-muted' }, (s.sample || []).join(' / ').slice(0, 120)),
            ])))
          : null,
        h(Row, { key: 'r2' }, [
          h('select', {
            key: 'src', className: 'co-select', value: sourceId, style: { flex: '0 0 170px' },
            onChange: (e) => setSourceId(e.target.value),
          }, [h('option', { key: 'all', value: 'all' }, '全部来源')].concat(sources.map((s) => h('option', { key: s.id, value: s.id }, s.label)))),
          h('input', {
            key: 'scope', className: 'co-input', value: scope, placeholder: '导入到哪个隔离键（默认 global）',
            onChange: (e) => setScope(e.target.value),
          }),
          h('button', {
            key: 'go', className: 'co-btn co-btn-primary', disabled: busy === 'run' || !sources.length,
            onClick: () => doImport().catch(() => {}),
          }, busy === 'run' ? '导入中…' : '导入七层'),
        ]),
        msg ? h('div', { key: 'm', className: 'co-muted' }, msg) : null,
        result && result.ok !== false ? h('div', { key: 'res', className: 'co-muted' },
          '新增 ' + result.imported + ' 条 · 合并 ' + result.merged + ' 条 · 跳过 ' + result.skipped + ' 条（' +
          Object.entries(result.byLayer || {}).map(([k, v]) => k + ' ' + v).join(' / ') + '）') : null,
      ])
    }

    function Memories({ data, refresh }) {
      const [layer, setLayer] = useState('fact')
      const [rows, setRows] = useState([])
      const [q, setQ] = useState('')
      const [draft, setDraft] = useState('')
      const load = useCallback(async () => {
        if (q.trim()) setRows((await api('memorySearch', { query: q.trim(), limit: 30 })).hits)
        else setRows((await api('memories', { layer, limit: 100, scope: data.scope })).rows)
      }, [layer, q, data.scope])
      useEffect(() => { load().catch(() => {}) }, [load])
      const add = async () => {
        if (!draft.trim()) return
        await api('memoryAdd', { layer, content: draft.trim(), scope: data.scope }, 'POST')
        setDraft(''); load(); refresh()
      }
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } }, [
        h(MemoryImport, { key: 'imp', data, refresh }),
        h(Row, { key: 'r1' }, [
          h('select', { className: 'co-select', value: layer, onChange: (e) => setLayer(e.target.value), style: { flex: '0 0 130px' } },
            [['soul', 'AI 自身'], ['user', '用户'], ['project', '项目'], ['fact', '事实'], ['lesson', '教训'], ['topic', '话题'], ['rules', '准则']]
              .map(([v, l]) => h('option', { key: v, value: v }, l))),
          h('input', { className: 'co-input', placeholder: '搜索（留空=按层浏览）', value: q, onChange: (e) => setQ(e.target.value) }),
          h('button', { className: 'co-btn', onClick: () => load().catch(() => {}) }, '刷新'),
        ]),
        h(Row, { key: 'r2' }, [
          h('input', { className: 'co-input', placeholder: '新增一条到当前层…', value: draft, onChange: (e) => setDraft(e.target.value) }),
          h('button', { className: 'co-btn co-btn-primary', onClick: () => add().catch(() => {}) }, '添加'),
        ]),
        h('div', { className: 'co-list', key: 'list' }, rows.length === 0
          ? [h('div', { key: 'e', className: 'co-empty' }, '没有条目')]
          : rows.map((r) => h('div', { key: r.id, className: 'co-item' }, [
            h('div', { key: 'c' }, r.content),
            h('div', { key: 'm', className: 'co-meta' }, [
              h('span', { key: 'l', className: 'co-pill' }, r.layer || layer),
              r.invalid_at ? h('span', { key: 'i', className: 'co-pill warn' }, '已失效') : null,
              h('span', { key: 'd' }, new Date(r.updated_at || Date.now()).toLocaleString()),
              h('button', {
                key: 'x', className: 'co-btn', style: { padding: '1px 8px', fontSize: 11 },
                onClick: async () => { await api('memoryInvalidate', { layer: r.layer || layer, id: r.id }, 'POST'); load(); refresh() },
              }, '失效'),
              h('button', {
                key: 'a', className: 'co-btn', style: { padding: '1px 8px', fontSize: 11 },
                onClick: async () => { await api('memoryUpdate', { layer: r.layer || layer, id: r.id, archived: true }, 'POST'); load(); refresh() },
              }, '归档'),
            ].filter(Boolean)),
          ]))),
      ])
    }

    function Compression({ data, refresh }) {
      const [status, setStatus] = useState(null)
      const [open, setOpen] = useState(null)
      // 带上当前会话 id：不带的话后端只能回 0，面板永远显示 0% 压力
      useEffect(() => { api('acpStatus', { windowTokens: 128000, sessionId: sessionIdFromHash() }).then(setStatus).catch(() => {}) }, [])
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } }, [
        h('div', { className: 'co-card', key: 's' }, [
          h('div', { className: 'co-title' }, '上下文压力'),
          h('div', { className: 'co-kv' }, [h('span', {}, '估算用量'), h('span', {}, status ? status.historyTokens + ' / ' + status.windowTokens + ' tokens' : '—')]),
          h('div', { className: 'co-kv' }, [h('span', {}, '压力'), h('span', {}, status ? status.pressure + '%' : '—')]),
          h('div', { className: 'co-kv' }, [h('span', {}, '可压缩范围'), h('span', {}, status && status.compressible ? ('seq ' + status.compressible.startSeq + '–' + status.compressible.endSeq) : '不足以压缩')]),
          h('div', { className: 'co-muted' }, '自动策略：45% / 75% / 95% 分级提示；90% 或超限时紧急压缩，目标 < 80%。保留最近三条与工作尾部。'),
          h('div', { className: 'co-muted', key: 'budget' }, '注入预算：首轮快照 300 / 命中 120 / 压缩后快照 300 / 风格 200 / 阀门 150（token）'),
        ]),
        h('div', { className: 'co-card', key: 'b' }, [
          h('div', { className: 'co-title' }, '压缩块'),
          h('div', { className: 'co-list' }, (data.blocks || []).length === 0 ? [h('div', { key: 'e', className: 'co-empty' }, '还没有压缩块')]
            : data.blocks.map((b) => h('div', { key: b.ref, className: 'co-item' }, [
              h('div', {}, b.ref + ' · tier ' + b.tier + ' · 省 ' + b.saved + ' tokens · ' + b.messages + ' 条'),
              h('div', { className: 'co-meta' }, [
                h('span', {}, new Date(b.at).toLocaleString()),
                h('button', {
                  key: 'v', className: 'co-btn', style: { padding: '1px 8px', fontSize: 11 },
                  onClick: async () => setOpen(await api('decompress', { ref: b.ref, offset: 0, maxChars: 4000 })),
                }, '查看归档'),
              ]),
            ]))),
        ]),
        open ? h('div', { className: 'co-card', key: 'o' }, [
          h('div', { className: 'co-title' }, '归档片段 · ' + open.ref + (open.partial ? ' · 未完（可续读）' : '')),
          h('textarea', { className: 'co-textarea', readOnly: true, value: open.content, style: { minHeight: 160 } }),
          h(Row, {}, [
            open.partial ? h('button', {
              className: 'co-btn', onClick: async () => {
                const next = await api('decompress', { ref: open.ref, offset: open.nextOffset, maxChars: 4000 })
                setOpen({ ...next, content: open.content + '\n' + next.content })
              },
            }, '继续读') : null,
            h('button', { className: 'co-btn', onClick: () => setOpen(null) }, '关闭'),
          ]),
        ]) : null,
      ])
    }

    function FollowUps({ data, refresh }) {
      const [rows, setRows] = useState(data.followUps || [])
      const [text, setText] = useState('')
      const [days, setDays] = useState(1)
      const [size, setSize] = useState('small')
      const load = async () => setRows((await api('followups', { scope: data.scope })).rows)
      const add = async () => {
        if (!text.trim()) return
        await api('followupAdd', { scope: data.scope, content: text.trim(), dueAt: Date.now() + Number(days) * 86400000, size }, 'POST')
        setText(''); load(); refresh()
      }
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } }, [
        h(Row, { key: 'add' }, [
          h('input', { className: 'co-input', placeholder: '惦记的事…', value: text, onChange: (e) => setText(e.target.value) }),
          h('input', { className: 'co-input', type: 'number', min: 0, value: days, onChange: (e) => setDays(e.target.value), style: { flex: '0 0 70px' } }),
          h('select', { className: 'co-select', value: size, onChange: (e) => setSize(e.target.value), style: { flex: '0 0 86px' } }, [
            h('option', { key: 's', value: 'small' }, '小事'), h('option', { key: 'b', value: 'big' }, '大事'),
          ]),
          h('button', { className: 'co-btn co-btn-primary', onClick: () => add().catch(() => {}) }, '记下'),
        ]),
        h('div', { className: 'co-list', key: 'l' }, rows.length === 0 ? [h('div', { key: 'e', className: 'co-empty' }, '还没有惦记的事')]
          : rows.map((f) => h('div', { key: f.id, className: 'co-item' }, [
            h('div', {}, f.content),
            h('div', { className: 'co-meta' }, [
              h('span', { className: 'co-pill' }, f.size === 'big' ? '大事' : '小事'),
              h('span', { className: 'co-pill' }, f.status),
              h('span', {}, f.due_at ? '到期 ' + new Date(f.due_at).toLocaleDateString() : '无期限'),
              h('button', { className: 'co-btn', style: { padding: '1px 8px', fontSize: 11 }, onClick: async () => { await api('followupDone', { id: f.id }, 'POST'); load(); refresh() } }, '完成'),
              h('button', { className: 'co-btn', style: { padding: '1px 8px', fontSize: 11 }, onClick: async () => { await api('followupSilence', { id: f.id }, 'POST'); load(); refresh() } }, '别再问'),
            ]),
          ]))),
      ])
    }

    function Style({ data, refresh }) {
      const [rows, setRows] = useState(data.style || [])
      const [enabled, setEnabled] = useState(!!data.styleEnabled)
      // 概览刷新/删除后把卡片数据同步过来，别一直显示打开面板时的旧值
      useEffect(() => { setRows(data.style || []) }, [data.style])
      useEffect(() => { setEnabled(!!data.styleEnabled) }, [data.styleEnabled])
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } }, [
        h(Row, { key: 'sw' }, [
          h(Switch, { on: enabled, onChange: async (v) => { const r = await api('styleToggle', { value: v }, 'POST'); setEnabled(!!r.enabled); refresh() } }),
          h('span', {}, '沟通风格学习（关闭后立刻停止注入）'),
        ]),
        h('div', { className: 'co-list', key: 'l' }, rows.length === 0 ? [h('div', { key: 'e', className: 'co-empty' }, '还没学到风格特征')]
          : rows.map((r) => h('div', { key: r.key, className: 'co-item' }, [
            h(Row, {}, [
              h('span', { key: 'k', style: { flex: 1 } }, r.key),
              h('span', { key: 'v', className: 'co-pill' }, Number(r.value).toFixed(2)),
              h('span', { key: 'c', className: 'co-pill' }, '置信 ' + Number(r.confidence).toFixed(2)),
              h('button', {
                key: 'd', className: 'co-btn', style: { padding: '1px 8px', fontSize: 11 },
                onClick: async () => { const res = await api('styleDelete', { key: r.key }, 'POST'); setRows(res.rows); refresh() },
              }, '删除'),
            ]),
          ]))),
      ])
    }

    function Persona({ data, refresh }) {
      const [p, setP] = useState(data)
      const reload = async () => { setP(await api('persona')); refresh() }
      const nar = p.narrative || {}
      const valves = p.valves || {}
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } }, [
        h('div', { className: 'co-card', key: 'n' }, [
          h(Row, {}, [
            h('div', { className: 'co-title', key: 't', style: { flex: 1 } }, '当前叙事 v' + (nar.version || 1)),
            h(Switch, { key: 'f', on: !!p.frozen, onChange: async (v) => { await api('personaFreeze', { value: v }, 'POST'); reload() } }),
            h('span', { key: 'l' }, p.frozen ? '已冻结' : '可塑'),
          ]),
          h('div', { key: 's' }, nar.summary || '（无）'),
          h('div', { key: 'r', className: 'co-muted' }, '准则：' + ((() => { try { const v = JSON.parse(nar.rules_json || '[]'); return Array.isArray(v) ? v.join('；') : '' } catch { return '' } })() || '—')),
          h(Row, { key: 'act' }, [
            h('button', { className: 'co-btn', onClick: async () => { await api('personaRollback', {}, 'POST'); reload() } }, '回滚上一版'),
          ]),
        ]),
        p.last ? h('div', { className: 'co-card', key: 'last' }, [
          h('div', { className: 'co-title', key: 't' }, '最近一次迭代'),
          h('div', { key: 'w', className: 'co-muted' },
            new Date(p.last.at).toLocaleString() + ' · ' + (p.last.outcome === 'negative' ? '负面信号' : '正向信号') +
            (p.last.weight != null ? ' · 权重 ' + p.last.weight : '')),
          h('div', { key: 'c' }, (p.last.changed && p.last.changed.length) ? p.last.changed.join('；') : '这轮没有变化（信号太平）'),
          p.last.chain ? h('div', { key: 'ch', className: 'co-muted' }, '推演：' + p.last.chain) : null,
        ]) : null,
        h('div', { className: 'co-card', key: 'v' }, [
          h('div', { className: 'co-title' }, '四个阀门'),
          h('div', { className: 'co-kv' }, [h('span', {}, '关注点'), h('span', {}, ({ opportunity: '先看机会', threat: '先看风险', relation: '先看关系', task: '先看任务' })[valves.attention] || String(valves.attention))]),
          h('div', { className: 'co-kv' }, [h('span', {}, '归因方式'), h('span', {}, ({ method: '先归因方法', ability: '先看能力', situation: '先看情境', other: '先看他人' })[valves.explanation] || String(valves.explanation))]),
          h('div', { className: 'co-kv' }, [h('span', {}, '情绪阈值'), h('span', {}, String(valves.emotion))]),
          h('div', { className: 'co-kv' }, [h('span', {}, '目标优先级'), h('span', {}, String(valves.goal))]),
          h('div', { className: 'co-muted' }, '速率上限：每轮最多微调一个阀门；每次更新都记录来源会话与事件序号。'),
        ]),
        h('div', { className: 'co-card', key: 'c' }, [
          h('div', { className: 'co-title' }, '推演层（思维链轨迹）'),
          h('div', { className: 'co-list' }, (p.chains || []).length === 0 ? [h('div', { key: 'e', className: 'co-empty' }, '还没有轨迹')]
            : p.chains.map((c) => h('div', { key: c.id, className: 'co-item' }, [
              h('div', {}, c.content),
              h('div', { className: 'co-meta' }, [
                h('span', { className: 'co-pill' }, '用 ' + c.uses + ' 次'),
                h('span', { className: 'co-pill' }, '情绪 ' + Number(c.sentiment).toFixed(2)),
                c.promoted ? h('span', { className: 'co-pill warn' }, '已晋升') : null,
              ].filter(Boolean)),
            ]))),
        ]),
        h('div', { className: 'co-card', key: 'h' }, [
          h('div', { className: 'co-title' }, '叙事版本历史'),
          h('div', { className: 'co-list' }, (p.narratives || []).map((n) => h('div', { key: n.id, className: 'co-item' }, [
            h('div', {}, 'v' + n.version + (n.is_current ? '（当前）' : '')),
            h('div', { className: 'co-muted' }, String(n.summary).slice(0, 120)),
            h('div', { className: 'co-meta' }, [
              h('span', {}, new Date(n.created_at).toLocaleString()),
              n.is_current ? null : h('button', {
                key: 'r', className: 'co-btn', style: { padding: '1px 8px', fontSize: 11 },
                onClick: async () => { await api('personaRollback', { version: n.version }, 'POST'); reload() },
              }, '回到这版'),
            ].filter(Boolean)),
          ]))),
        ]),
      ])
    }

    function SoulEditor({ data, refresh }) {
      const [rows, setRows] = useState([])
      const [drafts, setDrafts] = useState({})
      const [draft, setDraft] = useState('')
      const [msg, setMsg] = useState('')
      const load = useCallback(async () => {
        const r = await api('memories', { layer: 'soul', limit: 50, scope: data.scope })
        setRows(r.rows)
        setDrafts(Object.fromEntries(r.rows.map((x) => [x.id, x.content])))
      }, [data.scope])
      useEffect(() => { load().catch((e) => setMsg('读取失败：' + (e.message || e))) }, [load])

      const add = async () => {
        if (!draft.trim()) return
        await api('memoryAdd', { layer: 'soul', content: draft.trim(), scope: data.scope }, 'POST')
        setDraft(''); setMsg('已写入，下一轮对话生效'); load(); refresh()
      }
      const save = async (id) => {
        const text = (drafts[id] || '').trim()
        if (!text) return
        await api('memoryUpdate', { layer: 'soul', id, content: text }, 'POST')
        setMsg('已保存'); load(); refresh()
      }
      const invalidate = async (id) => {
        await api('memoryInvalidate', { layer: 'soul', id }, 'POST')
        setMsg('已标记失效'); load(); refresh()
      }
      const remove = async (id) => {
        await api('memoryDelete', { layer: 'soul', id }, 'POST')
        setMsg('已删除'); load(); refresh()
      }

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } }, [
        h('div', { className: 'co-muted', key: 'hint' }, '「AI 自身设定」（soul 层）：写鲸鲸是谁、怎么说话、什么不做。每轮首播会带上最新的 3 条。'),
        h('div', { className: 'co-card', key: 'new' }, [
          h('div', { className: 'co-title', key: 't' }, '新增一条设定'),
          h('textarea', {
            className: 'co-textarea', key: 'in',
            placeholder: '例如：我是鲸鲸，一条会撒娇也会认真办事的鲸鱼，把主人放在第一位。',
            value: draft, onChange: (e) => setDraft(e.target.value),
          }),
          h(Row, { key: 'r' }, [
            h('button', { className: 'co-btn co-btn-primary', key: 'b', onClick: () => add().catch((e) => setMsg('写入失败：' + (e.message || e))) }, '写入'),
            msg ? h('span', { key: 'm', className: 'co-muted' }, msg) : null,
          ]),
        ]),
        h('div', { className: 'co-list', key: 'list' }, rows.length === 0
          ? [h('div', { key: 'e', className: 'co-empty' }, '还没有设定，写一条吧')]
          : rows.map((r) => h('div', { key: r.id, className: 'co-item' }, [
            h('textarea', {
              key: 't', className: 'co-textarea',
              value: drafts[r.id] !== undefined ? drafts[r.id] : r.content,
              onChange: (e) => setDrafts({ ...drafts, [r.id]: e.target.value }),
            }),
            h(Row, { key: 'r' }, [
              h('button', { key: 's', className: 'co-btn', onClick: () => save(r.id).catch((e) => setMsg('保存失败：' + (e.message || e))) }, '保存'),
              h('button', { key: 'i', className: 'co-btn', onClick: () => invalidate(r.id).catch(() => {}) }, r.invalid_at ? '已失效' : '失效'),
              h('button', { key: 'd', className: 'co-btn', onClick: () => remove(r.id).catch(() => {}) }, '删除'),
              r.invalid_at ? h('span', { key: 'x', className: 'co-pill warn' }, '已失效') : null,
            ].filter(Boolean)),
          ]))),
      ])
    }

    function Learn() {
      const [stats, setStats] = useState(null)
      const [job, setJob] = useState(null)
      const [pack, setPack] = useState(null)
      const [packScene, setPackScene] = useState('')
      const [packSceneMsg, setPackSceneMsg] = useState('')
      const [text, setText] = useState('')
      const [where, setWhere] = useState('')
      const [scene, setScene] = useState('')
      const [target, setTarget] = useState('知识区')
      const [limit, setLimit] = useState(3)
      const [msg, setMsg] = useState('')
      const [err, setErr] = useState('')

      const load = useCallback(async () => {
        try {
          const [s, j, p, cfg] = await Promise.all([api('ftStats'), api('ftJob'), api('ftPack'), api('settings')])
          setStats(s); setJob(j); setPack(p); setErr('')
          if (cfg && cfg.packScene !== undefined) setPackScene(cfg.packScene)
        } catch (e) { setErr(String(e.message || e)) }
      }, [])
      useEffect(() => { load() }, [load])
      useEffect(() => {
        if (!job || job.state !== 'running') return
        const timer = setInterval(() => { api('ftJob').then(setJob).catch(() => {}) }, 3000)
        return () => clearInterval(timer)
      }, [job && job.state])

      const feed = async () => {
        if (!text.trim()) { setMsg('先贴几行真人说的话'); return }
        setMsg('投喂中…')
        try {
          const r = await api('ftFeed', { lines: text, where, scene }, 'POST')
          setMsg('读入 ' + r.read + ' 条，新增 ' + r.added + ' 条' + (r.added ? '；文风包已更新（真人 ' + r.human + ' / 鱼 ' + r.fish + '）' : '（都重复了，没新增）'))
          setText(''); load()
        } catch (e) { setMsg('投喂失败：' + (e.message || e)) }
      }

      const learn = async () => {
        if (!target.trim()) { setMsg('填个分区名，比如 知识区'); return }
        setMsg('已开始，后台慢慢抓…')
        try { const r = await api('ftLearn', { site: 'bili', target, limit: Number(limit) || 3 }, 'POST'); setJob(r.job || null); load() }
        catch (e) { setMsg('开始失败：' + (e.message || e)) }
      }

      const cancel = async () => {
        try {
          const r = await api('ftCancel', {}, 'POST')
          setJob(r.job || null)
          setMsg('已取消这次学习')
          load()
        } catch (e) { setMsg('取消失败：' + (e.message || e)) }
      }

      const s = stats || {}
      const running = job && job.state === 'running'
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } }, [
        h('div', { className: 'co-card', key: 'st' }, [
          h('div', { className: 'co-title', key: 't' }, '语料库'),
          s.ok
            ? h('div', { key: 'v', className: 'co-muted' }, '共 ' + s.total + ' 条 · 真人 ' + s.human + ' / 鱼 ' + s.fish + ' · 场合 ' + s.scenes + ' 个')
            : h('div', { key: 'v', className: 'co-muted' }, '没找到 fishtalk 插件：' + (s.hint || '') ),
          err ? h('div', { key: 'e', className: 'co-muted' }, '读取失败：' + err) : null,
        ]),
        h('div', { className: 'co-card', key: 'pack' }, [
          h('div', { className: 'co-title', key: 't' }, '文风包（⑤ 区真正读到的那句）'),
          !pack ? h('div', { key: 'l', className: 'co-muted' }, '读取中…')
            : pack.ok === false ? h('div', { key: 'e', className: 'co-muted' }, '没找到 fishtalk 插件：' + (pack.hint || pack.reason || ''))
            : (!pack.scenes || pack.scenes.length === 0)
              ? h('div', { key: 'e', className: 'co-muted' }, '还没有文风包：先投喂语料，或跑一次 B 站学习')
              : h('div', { key: 'body', style: { display: 'flex', flexDirection: 'column', gap: 6 } }, [
                h('div', { key: 'b', className: 'co-muted' }, pack.brief || '（语料还不够，暂时不注入）'),
                h('div', { key: 'l', className: 'co-meta', style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
                  (pack.scenes || []).slice(0, 6).map((x) => h('span', { key: x.name, className: 'co-pill' }, x.name + ' · ' + x.count))),
                pack.chatBrief ? h('div', { key: 'c', className: 'co-muted' }, '私聊会用：' + pack.chatBrief)
                  : h('div', { key: 'c', className: 'co-muted' }, '私聊暂时不会用：还没有聊天语料（QQ/微信），先投喂几行群聊记录'),
                h(Row, { key: 'r' }, [
                  h('input', {
                    key: 'i', className: 'co-input', value: packScene,
                    placeholder: '⑤ 区固定用哪个场合（留空=自动）',
                    onChange: (e) => setPackScene(e.target.value),
                  }),
                  h('button', {
                    key: 'b', className: 'co-btn',
                    onClick: async () => {
                      try {
                        await api('setSetting', { key: 'packScene', value: packScene.trim() }, 'POST')
                        setPackSceneMsg('已保存（下一轮生效）'); load()
                      } catch (e) { setPackSceneMsg('保存失败：' + (e.message || e)) }
                    },
                  }, '保存场合'),
                ]),
                packSceneMsg ? h('div', { key: 'm', className: 'co-muted' }, packSceneMsg) : null,
              ]),
        ]),
        h('div', { className: 'co-card', key: 'bili' }, [
          h('div', { className: 'co-title', key: 't' }, 'B 站联网学习'),
          h(Row, { key: 'r' }, [
            h('input', { className: 'co-input', value: target, onChange: (e) => setTarget(e.target.value), placeholder: '分区名，如 知识区；或 搜:关键词' }),
            h('input', { className: 'co-input', type: 'number', min: 1, max: 10, value: limit, onChange: (e) => setLimit(e.target.value), style: { flex: '0 0 66px' } }),
            h('button', { className: 'co-btn co-btn-primary', onClick: () => learn().catch(() => {}) }, running ? '学习中…' : '开始学习'),
            running ? h('button', { className: 'co-btn', onClick: () => cancel().catch(() => {}) }, '取消') : null,
          ]),
          running
            ? h('div', { key: 'j', className: 'co-muted' }, '找到 ' + (job.found || 0) + ' 个，读了 ' + (job.read || 0) + ' 条，新增 ' + (job.added || 0) + ' 条…')
            : (job && job.state !== 'idle'
              ? h('div', { key: 'j2', className: 'co-muted' }, '上次：' + job.state + ' · 新增 ' + (job.added || 0) + ' 条' + (job.error ? ' · ' + job.error : ''))
              : h('div', { key: 'j3', className: 'co-muted' }, '去 B 站找讨论度高的视频，抓高赞评论和弹幕来学，比较慢。')),
        ]),
        h('div', { className: 'co-card', key: 'feed' }, [
          h('div', { className: 'co-title', key: 't' }, '投喂语料'),
          h('textarea', {
            key: 'in', className: 'co-textarea', value: text, onChange: (e) => setText(e.target.value),
            placeholder: '一行一条真人说的话：聊天记录、帖子、评论都行。别贴自己的（AI 写的）。',
          }),
          h(Row, { key: 'r' }, [
            h('input', { className: 'co-input', value: where, onChange: (e) => setWhere(e.target.value), placeholder: '从哪来的（群名/帖子）' }),
            h('input', { className: 'co-input', value: scene, onChange: (e) => setScene(e.target.value), placeholder: '场合（可空）' }),
            h('button', { className: 'co-btn co-btn-primary', onClick: () => feed().catch(() => {}) }, '投喂'),
          ]),
          msg ? h('div', { key: 'm', className: 'co-muted' }, msg) : null,
        ]),
      ])
    }

    function Diag({ sessionId }) {
      const [d, setD] = useState(null)
      const [err, setErr] = useState('')
      const load = useCallback(async () => {
        try { setD(await api('diag', { sessionId: sessionId || '' })); setErr('') } catch (e) { setErr(String(e.message || e)) }
      }, [sessionId])
      useEffect(() => { load() }, [load])
      const inj = d && d.inject
      const rows = []
      if (inj && inj.parts) {
        inj.parts.forEach((p, i) => rows.push(h('div', { key: 'p' + i, className: 'co-kv' }, [h('span', {}, p.label + '…'), h('span', {}, p.tokens + ' tok')])))
        rows.push(h('div', { key: 'sum', className: 'co-kv' }, [h('span', {}, '合计'), h('span', {}, inj.total + ' tok')]))
      }
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } }, [
        h('div', { className: 'co-card', key: 'a' }, [
          h('div', { className: 'co-title', key: 't' }, '本轮注入（最近一次发给模型的提示）'),
          h('div', { key: 'h', className: 'co-muted' }, d && d.usedSession ? '来自会话 ' + String(d.usedSession).slice(0, 12) + '…' : '还没记录到任何注入'),
          err ? h('div', { key: 'e', className: 'co-muted' }, '读取失败：' + err) : null,
          !inj ? h('div', { key: 'n', className: 'co-muted' }, '这个会话还没有注入记录（发一句话再看看）') : h('div', { key: 'l', className: 'co-list' }, rows),
        ]),
        h('div', { className: 'co-card', key: 'b' }, [
          h('div', { className: 'co-title', key: 't' }, '健康'),
          h('div', { className: 'co-kv', key: 'f' }, [h('span', {}, '注入失败次数'), h('span', {}, String((d && d.fails) || 0))]),
          h('div', { key: 'n2', className: 'co-muted' }, '只统计真异常；正常提示（比如把压缩让给 billion-context）不算失败。'),
          d && d.note ? h('div', { key: 'n3', className: 'co-muted' }, '最近提示：' + d.note.msg) : null,
          h('div', { className: 'co-kv', key: 's' }, [h('span', {}, '数据库大小'), h('span', {}, d ? (Math.round(d.dbSize / 1024) + ' KB') : '—')]),
          d && d.last ? h('div', { key: 'l2', className: 'co-muted' }, '最近一次：' + d.last.msg + ' · ' + d.last.err) : null,
          h(Row, { key: 'r' }, [h('button', { className: 'co-btn', onClick: () => load().catch(() => {}) }, '刷新')]),
        ]),
      ])
    }

    // 页 → 栏：同类的东西收进同一页，原页变成页内一栏（内容原样平移，功能不丢）
    const TABS = [
      ['overview', '概览'], ['memories', '记忆'], ['learning', '学习'],
      ['compression', '压缩'], ['persona', '人格'],
    ]
    const SUBS = {
      overview: [['overview', '概览'], ['diag', '明细']],
      memories: [['memories', '记忆'], ['soul', '设定'], ['followups', '惦记'], ['style', '风格']],
      learning: [['learning', '学习']],
      compression: [['compression', '压缩']],
      persona: [['persona', '人格']],
    }

    function Panel() {
      const [tab, setTab] = useState('overview')
      const [sub, setSub] = useState('overview')
      const [data, setData] = useState(null)
      const [err, setErr] = useState('')
      const load = useCallback(async () => {
        try { setData(await api('overview', { session: sessionIdFromHash() })); setErr('') } catch (e) { setErr(String(e.message || e)) }
      }, [])
      useEffect(() => { load() }, [load])

      const subs = SUBS[tab] || [['' + tab, '']]
      // 切页时若当前栏不属于新页，回落到新页第一栏
      const cur = subs.some(([id]) => id === sub) ? sub : subs[0][0]
      const pick = (id) => { setTab(id); const first = (SUBS[id] || [[id]])[0][0]; setSub(first) }

      const body = {
        overview: h(Overview, { key: 'ov', data, refresh: load }),
        diag: h(Diag, { key: 'dg', sessionId: sessionIdFromHash() }),
        memories: h(Memories, { key: 'mm', data, refresh: load }),
        soul: h(SoulEditor, { key: 'sl', data, refresh: load }),
        followups: h(FollowUps, { key: 'fu', data, refresh: load }),
        style: h(Style, { key: 'st', data, refresh: load }),
        learning: h(Learn, { key: 'ln' }),
        compression: h(Compression, { key: 'cp', data, refresh: load }),
        persona: h(Persona, { key: 'pe', data, refresh: load }),
      }[cur]

      return h('div', { className: 'co-panel' }, [
        h('style', { key: 'css' }, CSS),
        h('div', { className: 'co-tabs', key: 'tabs' }, TABS.map(([id, label]) =>
          h('button', { key: id, className: 'co-tab' + (tab === id ? ' on' : ''), onClick: () => pick(id) }, label))),
        subs.length > 1
          ? h('div', { className: 'co-subtabs', key: 'subs' }, subs.map(([id, label]) =>
              h('button', { key: id, className: 'co-tab co-subtab' + (cur === id ? ' on' : ''), onClick: () => setSub(id) }, label)))
          : null,
        err ? h('div', { key: 'err', className: 'co-muted' }, '读取失败：' + err) : null,
        !data ? h('div', { key: 'ld', className: 'co-muted' }, '加载中…') : null,
        data ? body : null,
      ])
    }

    function apply(ctx) {
      const slots = ctx && typeof ctx.get === 'function' ? ctx.get('slots') : null
      if (!slots) return
      slots.inject('settings.section', () => slots.register(
        { name: 'settings.section', id: 'companion-one', order: 26, label: '陪伴' },
        () => h(Panel),
      ))
      // 插件详情页（插件 → 陪伴）复用同一份面板与同一套 HTTP API
      slots.inject('plugins.bundle.config', () => slots.register(
        { name: 'plugins.bundle.config', key: 'companion-one' },
        () => h(Panel),
      ))
    }

    exports.apply = apply
    exports.__test = { api }
    return module.exports
  },
})
