/**
 * companion-one / lib/acp.js — 内置压缩引擎（ACP 风格，无代理、不改写网络流量）。
 *
 * 工具语义参考 github.com/ranxianglei/billion-context：
 *   compress / decompress / search_context / acp_status，
 * 分层折叠（tier2/tier3）、只接受节省 token 的摘要、批量在一个事务里提交、
 * 压缩块稳定引用 b1/b2…（不回收）、重启后从 SQLite 恢复。
 *
 * 与上游的区别：不接管网络，不改写请求体；压缩通过 Session 的 surface replace
 * 完成——被折叠的事件仍留在会话日志里（可回溯），同时全量归档进本插件的 SQLite
 * 供 decompress / search_context 使用。失败或取消不会留下残缺摘要：
 * 先写 pending 归档，surface replace 成功后才置为 committed。
 */
import { now, makeId, kvGet, kvSet } from './db.js'

/* ---------------- token 估算 ---------------- */
/** 粗略但方向正确：CJK 每字≈1 token，拉丁按 4 字符≈1 token。 */
export function estimateTokens(text) {
  const s = String(text || '')
  let cjk = 0
  let other = 0
  for (const ch of s) {
    if (/[\u4e00-\u9fa5\u3040-\u30ff]/.test(ch)) cjk++
    else other++
  }
  return Math.ceil(cjk + other / 4)
}

/** 从 Surface 事件里抽出纯文本（reasoning 不归档、不参与摘要）。 */
export function renderEventText(event) {
  const msg = event?.data?.message
  const content = msg?.content ?? event?.data?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && block.text) parts.push(block.text)
    else if (block.type === 'reasoning') continue
    else if (block.type === 'tool-call') parts.push('[tool ' + block.name + '] ' + String(block.arguments || ''))
    else if (block.type === 'image') parts.push('[image]')
  }
  return parts.join('\n').trim()
}

export function roleOf(event) {
  if (event.type === 'user/message') return 'user'
  if (event.type === 'assistant/message') return 'assistant'
  if (event.type === 'tool/result') return 'tool'
  if (event.type === 'system/message') return 'system'
  if (event.type === 'developer/message') return 'developer'
  return 'other'
}

export const SURFACE_TYPES = new Set(['system/message', 'developer/message', 'user/message', 'assistant/message', 'tool/result'])

/**
 * 计算当前 Surface 节点序列（seq 递增）。
 * surfaceOp: 'append' | { op: 'replace', startSeq, endSeq }，端点是当前 surface 中节点的 seq。
 */
export function computeSurface(events) {
  const nodes = []
  for (const ev of events) {
    if (!SURFACE_TYPES.has(ev.type)) continue
    const op = ev.surfaceOp
    if (op && typeof op === 'object' && op.op === 'replace') {
      const a = nodes.findIndex((n) => n.seq === op.startSeq)
      const b = nodes.findIndex((n) => n.seq === op.endSeq)
      if (a < 0 || b < 0) continue
      nodes.splice(Math.min(a, b), Math.abs(b - a) + 1, { seq: ev.seq, replaced: [op.startSeq, op.endSeq] })
    } else {
      nodes.push({ seq: ev.seq })
    }
  }
  return nodes
}

/** 选择可折叠跨度：保留最近 keepTail 个节点，跳过 system 节点 0，保持工具配对完整。 */
export function selectRange(events, nodes, opts) {
  const keepTail = Math.max(3, (opts && opts.keepTail) || 8)
  if (nodes.length <= keepTail + 2) return null
  const bySeq = new Map(events.map((e) => [e.seq, e]))
  let startIdx = 0
  // 不折叠 system 节点（提示词入口）
  while (startIdx < nodes.length && bySeq.get(nodes[startIdx].seq)?.type === 'system/message') startIdx++
  let endIdx = nodes.length - keepTail - 1
  if (endIdx <= startIdx) return null
  // 工具配对：切点后不能留下未配对的 tool/result
  const open = new Set()
  for (let i = startIdx; i <= endIdx; i++) {
    const ev = bySeq.get(nodes[i].seq)
    if (!ev) return null
    if (ev.type === 'assistant/message') {
      const content = ev.data?.message?.content || []
      for (const b of content) if (b && b.type === 'tool-call') open.add(b.id)
    } else if (ev.type === 'tool/result') {
      const callId = ev.data?.message?.toolCallId || ev.data?.message?.source?.callId
      if (callId) open.delete(callId)
    }
  }
  while (open.size && endIdx < nodes.length - keepTail) endIdx++
  if (endIdx <= startIdx) return null
  const start = nodes[startIdx].seq
  const end = nodes[endIdx].seq
  return { startIdx, endIdx, startSeq: start, endSeq: end, nodeCount: endIdx - startIdx + 1 }
}

/* ---------------- 压缩块编号 ---------------- */
export function nextBlockRef(db) {
  const n = Number(kvGet(db, 'acp:block_counter', 0)) + 1
  kvSet(db, 'acp:block_counter', n)
  return 'b' + n
}

/**
 * 执行一次压缩。
 * @returns {{ok:true, ref, archived, tokensSaved, summaryTokens} | {ok:false, reason, detail?}}
 */
export function compressSession({ db, session, summary, keepTail, tier, sessionId }) {
  const text = String(summary || '').trim()
  if (!text) return { ok: false, reason: 'summary_required' }
  const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : []
  if (!events.length) return { ok: false, reason: 'empty_session' }
  const nodes = computeSurface(events)
  const range = selectRange(events, nodes, { keepTail })
  if (!range) return { ok: false, reason: 'nothing_to_compress', detail: '可折叠范围不足（需要更多历史，且保留最近至少三条）' }

  const bySeq = new Map(events.map((e) => [e.seq, e]))
  const span = []
  for (let i = range.startIdx; i <= range.endIdx; i++) {
    const ev = bySeq.get(nodes[i].seq)
    if (ev) span.push(ev)
  }
  const sourceText = span.map((e) => renderEventText(e)).filter(Boolean).join('\n')
  const sourceTokens = estimateTokens(sourceText)
  const summaryTokens = estimateTokens(text)
  if (summaryTokens >= sourceTokens * 0.85) {
    return { ok: false, reason: 'not_saving_tokens', detail: '摘要 ' + summaryTokens + ' tokens，原文 ' + sourceTokens + ' tokens（需压到 85% 以下）' }
  }

  const ref = nextBlockRef(db)
  const ts = now()
  const sid = sessionId || session.id || 'unknown'
  const messages = span.map((e) => ({ seq: e.seq, role: roleOf(e), text: renderEventText(e) })).filter((m) => m.text)

  // 1) 先写 pending 归档（事务）
  db.exec('begin')
  try {
    db.prepare('insert into compressed_blocks (id, session_id, tier, parent_id, child_refs, start_seq, end_seq,' +
      ' summary, summary_tokens, source_tokens, tokens_saved, message_count, status, created_at)' +
      " values (?,?,?,?,?,?,?,?,?,?,?,?,'pending',?)").run(
      ref, sid, tier || 1, null, '[]', range.startSeq, range.endSeq,
      text, summaryTokens, sourceTokens, sourceTokens - summaryTokens, messages.length, ts,
    )
    const insMsg = db.prepare('insert into compressed_messages (id, block_id, session_id, seq, role, content, created_at) values (?,?,?,?,?,?,?)')
    const insFts = db.prepare('insert into compressed_fts (content, block_id, message_id) values (?,?,?)')
    for (const m of messages) {
      const mid = makeId()
      insMsg.run(mid, ref, sid, m.seq, m.role, m.text, ts)
      try { insFts.run(m.text, ref, mid) } catch { /* FTS 缺席 */ }
    }
    db.exec('commit')
  } catch (err) {
    try { db.exec('rollback') } catch {}
    return { ok: false, reason: 'archive_failed', detail: String(err && err.message || err) }
  }

  // 2) surface replace（失败则回滚归档）
  try {
    session.append('user/message', {
      role: 'user',
      content: [{ type: 'text', text: text }],
      source: { kind: 'companion-one', form: 'compressed-block', blockId: ref, tier: tier || 1 },
    }, {
      surfaceOp: { op: 'replace', startSeq: range.startSeq, endSeq: range.endSeq },
      // dsh-session 校验：被替换掉的所有 surface 节点都要登记为来源
      sourceEventSeqs: span.map((e) => e.seq),
    })
  } catch (err) {
    try {
      db.exec('begin')
      db.prepare('delete from compressed_messages where block_id = ?').run(ref)
      try { db.prepare('delete from compressed_fts where block_id = ?').run(ref) } catch {}
      db.prepare('delete from compressed_blocks where id = ?').run(ref)
      db.exec('commit')
    } catch {}
    return { ok: false, reason: 'surface_replace_failed', detail: String(err && err.message || err) }
  }

  db.prepare("update compressed_blocks set status = 'committed' where id = ?").run(ref)
  kvSet(db, 'acp:last_compress:' + sid, { at: ts, ref, tokensSaved: sourceTokens - summaryTokens })
  try { consolidateBlocks(db, { sessionId: sid }) } catch {}
  return { ok: true, ref, archived: messages.length, tokensSaved: sourceTokens - summaryTokens, summaryTokens, sourceTokens }
}

/* ---------------- 读取 ---------------- */
export function blockByRef(db, ref) {
  return db.prepare('select * from compressed_blocks where id = ?').get(String(ref || '').trim()) || null
}

/**
 * 分层折叠：tier1 块攒多了就合并成一个 tier2（摘要再摘要）。
 * 子块不删，只标 folded —— 原文与子摘要仍可回溯（decompress 会列 child_refs）。
 */
export function consolidateBlocks(db, { sessionId, threshold, keep } = {}) {
  const limit = threshold || 6
  let rows = db.prepare("select * from compressed_blocks where status = 'committed' and tier = 1" +
    (sessionId ? " and session_id = ?" : "") + " order by created_at asc").all(...(sessionId ? [sessionId] : []))
  const bySession = new Map()
  for (const r of rows) {
    const list = bySession.get(r.session_id) || []
    list.push(r)
    bySession.set(r.session_id, list)
  }
  const made = []
  for (const [sid, list] of bySession) {
    if (list.length <= limit) continue
    const take = list.slice(0, list.length - (keep || 3))
    if (take.length < 2) continue
    const summary = take.map((b) => String(b.summary)).join('\n')
    const merged = summary.slice(0, 2400)
    const id = 'b' + (Number(kvGet(db, 'acp:block_counter', 0)) + 1)
    kvSet(db, 'acp:block_counter', Number(String(id).slice(1)))
    const ts = now()
    try {
      db.exec('begin')
      db.prepare('insert into compressed_blocks (id, session_id, tier, parent_id, child_refs, start_seq, end_seq,' +
        ' summary, summary_tokens, source_tokens, tokens_saved, message_count, status, created_at)' +
        " values (?,?,?,?,?,?,?,?,?,?,?,?, 'committed', ?)").run(
        id, sid, 2, null, JSON.stringify(take.map((b) => b.id)),
        take[0].start_seq, take[take.length - 1].end_seq, merged,
        estimateTokens(merged), take.reduce((n, b) => n + Number(b.source_tokens || 0), 0),
        take.reduce((n, b) => n + Number(b.tokens_saved || 0), 0),
        take.reduce((n, b) => n + Number(b.message_count || 0), 0), ts,
      )
      for (const b of take) db.prepare("update compressed_blocks set status = 'folded', parent_id = ? where id = ?").run(id, b.id)
      db.exec('commit')
      made.push({ ref: id, children: take.map((b) => b.id) })
    } catch (err) {
      try { db.exec('rollback') } catch {}
    }
  }
  return made
}

export function listBlocks(db, sessionId, limit) {
  const lim = limit || 50
  const where = sessionId ? "where session_id = ? and status != 'folded'" : "where status != 'folded'"
  const args = sessionId ? [sessionId, lim] : [lim]
  return db.prepare('select * from compressed_blocks ' + where + ' order by created_at desc limit ?').all(...args)
}

/**
 * 分页读取归档：单次不超过窗口 1/4，超出返回 partial + nextOffset。
 */
export function decompressBlock(db, opts) {
  const ref = String(opts.ref || '').trim()
  const block = blockByRef(db, ref)
  if (!block) return { ok: false, reason: 'block_not_found', ref }
  const maxChars = Math.max(500, opts.maxChars || 6000)
  const offset = Math.max(0, opts.offset || 0)
  const rows = db.prepare('select seq, role, content from compressed_messages where block_id = ? order by seq asc').all(ref)
  const childRefs = (() => { try { return JSON.parse(block.child_refs || '[]') } catch { return [] } })()
  // 二级摘要块没有原始消息：直接把子块摘要列出来，并说明怎么取原文，
  // 不让人再猜「为什么 decompress 是空的」。
  if (!rows.length && childRefs.length) {
    const lines = []
    let used = 0
    for (const id of childRefs) {
      const child = blockByRef(db, id)
      if (!child) continue
      const line = '[' + id + '] ' + String(child.summary || '').replace(/\s+/g, ' ').slice(0, 140)
      if (used + line.length > maxChars) break
      lines.push(line)
      used += line.length
    }
    const body = lines.join('\n')
    return {
      ok: true,
      ref,
      tier: block.tier,
      summary: block.summary,
      children: childRefs,
      content: body,
      totalChars: body.length,
      offset: 0,
      nextOffset: null,
      partial: false,
      hint: '这是二级摘要块。要原文就按 children 里的 ref 再调一次 decompress。',
    }
  }
  let out = ''
  let i = 0
  let skipped = 0
  const chunks = []
  for (const row of rows) {
    chunks.push('[' + row.seq + '|' + row.role + '] ' + row.content)
  }
  const full = chunks.join('\n\n')
  const slice = full.slice(offset, offset + maxChars)
  const nextOffset = offset + slice.length < full.length ? offset + slice.length : null
  return {
    ok: true,
    ref,
    tier: block.tier,
    summary: block.summary,
    children: (() => { try { return JSON.parse(block.child_refs || '[]') } catch { return [] } })(),
    totalChars: full.length,
    offset,
    nextOffset,
    partial: nextOffset !== null,
    content: slice,
  }
}

/** BM25 检索归档与摘要。 */
export function searchContext(db, opts) {
  const q = String(opts.query || '').trim()
  const limit = opts.limit || 5
  if (!q) return { ok: false, reason: 'query_required' }
  const hits = []
  const seen = new Set()

  if (q.length >= 3) {
    try {
      const rows = db.prepare('select message_id as id, block_id, content, bm25(compressed_fts) as score' +
        ' from compressed_fts where compressed_fts match ? order by score limit 40').all('"' + q.replace(/"/g, '') + '"')
      for (const r of rows) {
        if (seen.has(r.id)) continue
        seen.add(r.id)
        hits.push({ kind: 'message', id: r.id, ref: r.block_id, score: -r.score, snippet: snippetOf(r.content, q) })
      }
    } catch {}
  }
  if (hits.length < limit) {
    const rows = db.prepare("select id, block_id, content from compressed_messages where content like ? order by seq limit 40")
      .all('%' + q.replace(/[%_]/g, '') + '%')
    for (const r of rows) {
      if (seen.has(r.id)) continue
      seen.add(r.id)
      hits.push({ kind: 'message', id: r.id, ref: r.block_id, score: 0.5, snippet: snippetOf(r.content, q) })
      if (hits.length >= 60) break
    }
  }
  if (hits.length < limit) {
    for (const b of db.prepare('select id, summary from compressed_blocks where summary like ? limit 20').all('%' + q + '%')) {
      hits.push({ kind: 'summary', ref: b.id, score: 0.3, snippet: snippetOf(b.summary, q) })
    }
  }
  hits.sort((a, b) => b.score - a.score)
  return { ok: true, query: q, hits: hits.slice(0, limit) }
}

function snippetOf(text, q) {
  const s = String(text || '')
  const i = s.indexOf(q)
  if (i < 0) return s.slice(0, 160)
  return (i > 40 ? '…' : '') + s.slice(Math.max(0, i - 40), i + 120) + (i + 120 < s.length ? '…' : '')
}

/* ---------------- 压力估算缓存 ---------------- */
// 事件一旦写进日志就不再变化，所以按 session 缓存「seq → token 数」；
// 之前这里用 chars/3 粗估，中文会低估三倍，压力条永远偏低。
const TOKEN_CACHE = new WeakMap()
function tokenCacheFor(session) {
  if (!session || typeof session !== 'object') return new Map()
  let m = TOKEN_CACHE.get(session)
  if (!m) { m = new Map(); TOKEN_CACHE.set(session, m) }
  return m
}
function tokensOfEvent(ev, cache) {
  if (!ev) return 0
  const hit = cache.get(ev.seq)
  if (hit !== undefined) return hit
  const t = estimateTokens(renderEventText(ev))
  if (cache.size > 8000) cache.clear()
  cache.set(ev.seq, t)
  return t
}

/** 上下文压力与可压缩范围。 */
export function acpStatus({ db, session, windowTokens, sessionId }) {
  const events = session && typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : []
  // 面板/HTTP 路径拿不到 live session：退回最近一次 pre-step 记下的压力值，别显示 0
  if (!session && sessionId) {
    let row = null
    try { row = db.prepare('select * from session_state where session_id = ?').get(sessionId) } catch {}
    if (row) {
      return {
        ok: true,
        windowTokens: windowTokens || 128000,
        historyTokens: Math.round(Number(row.pressure || 0) / 100 * (windowTokens || 128000)),
        pressure: Number(row.pressure || 0),
        surfaceNodes: null,
        keepTail: 8,
        source: 'session_state',
        lastCompress: kvGet(db, 'acp:last_compress:' + sessionId, null),
        compressible: null,
        blocks: listBlocks(db, sessionId, 20).map((b) => ({ ref: b.id, tier: b.tier, saved: b.tokens_saved, messages: b.message_count, at: b.created_at, status: b.status })),
        rules: { tiers: 'tier1 原始消息归档；tier2 摘要再摘要；tier3 会话总纲', trigger: '45% / 75% / 95% 分级提示', retainsRecent: '至少保留最近 3 条消息' },
      }
    }
  }
  const nodes = computeSurface(events)
  const bySeq = new Map(events.map((e) => [e.seq, e]))
  const surfaceNodes = nodes.map((n) => ({ seq: n.seq, type: bySeq.get(n.seq)?.type || 'replaced' }))
  // 只看当前 surface：被折叠的节点不在请求视图里，不该算进压力。
  // 逐事件估算并缓存（事件不可变、按 session 记忆），避免每步重算整段历史。
  const cache = tokenCacheFor(session)
  let historyTokens = 0
  for (const node of nodes) historyTokens += tokensOfEvent(bySeq.get(node.seq), cache)
  const win = windowTokens || 128000
  const pressure = Math.min(999, Math.round((historyTokens / win) * 1000) / 10)
  const range = selectRange(events, nodes, { keepTail: 8 })
  const blocks = listBlocks(db, sessionId, 20)
  return {
    ok: true,
    windowTokens: win,
    historyTokens,
    pressure,
    surfaceNodes: surfaceNodes.length,
    keepTail: 8,
    lastCompress: sessionId ? kvGet(db, 'acp:last_compress:' + sessionId, null) : null,
    compressible: range ? { startSeq: range.startSeq, endSeq: range.endSeq, nodes: range.nodeCount } : null,
    blocks: blocks.map((b) => ({ ref: b.id, tier: b.tier, saved: b.tokens_saved, messages: b.message_count, at: b.created_at, status: b.status })),
    rules: {
      tiers: 'tier1 原始消息归档；tier2 摘要再摘要；tier3 会话总纲',
      trigger: '45% / 75% / 95% 分级提示；90% 或超限时紧急压缩，目标 < 80%',
      retainsRecent: '至少保留最近 3 条消息与工作尾部，system 消息不折叠',
    },
  }
}
