/**
 * companion-one / lib/memory.js — 七层记忆的写入、去重合并、检索与有效期。
 *
 * 机制来源：
 * - 七层划分与「首轮注入 / 每消息关键词命中」参考 dsh-meow-memory（MIT）。
 * - 「事实键 + 旧条代码级失效（不删原文、可回溯）」参考 dsh-companion-memory 的
 *   事实有效期机制，用本插件自己的表结构重写。
 */
import { LAYERS, insertMemory, updateMemory, listMemory, getMemory, deleteMemory, makeId, now } from './db.js'

const CJK = /[\u4e00-\u9fa5]/

/** 关键词：中文双字 + 拉丁词，去停用词，最多 24 个。 */
const STOP = new Set(['这个', '那个', '就是', '可以', '一个', '我们', '你们', '他们', '什么', '怎么',
  '因为', '所以', '但是', '然后', '现在', '已经', '还是', '没有', '不是', '这样', '那样', '一下',
  '觉得', '知道', '感觉', '东西', '时候', '问题', '事情', '自己', '主人', '鲸鲸'])
export function extractKeywords(text) {
  const out = new Set()
  const s = String(text || '')
  for (const m of s.matchAll(/[A-Za-z][A-Za-z0-9_+-]{1,}/g)) out.add(m[0].toLowerCase())
  const cjk = s.match(/[\u4e00-\u9fa5]+/g) || []
  for (const seg of cjk) {
    for (let i = 0; i + 1 < seg.length; i++) {
      const g = seg.slice(i, i + 2)
      if (!STOP.has(g)) out.add(g)
    }
    if (seg.length >= 2 && seg.length <= 6) out.add(seg)
  }
  return [...out].slice(0, 24).join(' ')
}

/** 字符二元组集合，用于相似度。 */
function bigrams(text) {
  const s = String(text || '').replace(/[\s\p{P}]/gu, '').toLowerCase()
  const set = new Set()
  for (let i = 0; i + 1 < s.length; i++) set.add(s.slice(i, i + 2))
  if (s.length === 1) set.add(s)
  return set
}

export function similarity(a, b) {
  const A = bigrams(a), B = bigrams(b)
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const g of A) if (B.has(g)) inter++
  return inter / (A.size + B.size - inter)
}

/**
 * 事实键：同一人 + 同一键出现新值 → 旧值由代码标失效（不删、不改原文）。
 * 键表可按需扩充；返回 null 表示该条不参与键失效。
 */
const FACT_KEYS = [
  ['home', /住(在|址)?|家在|搬到|新家|房子/],
  ['job', /工作|上班|公司|入职|离职|岗位|职位|实习/],
  ['commute', /通勤|上班路|地铁|公交|骑车上班/],
  ['phone', /手机|电话|号码/],
  ['birthday', /生日/],
  ['school', /学校|大学|专业|上课|考试/],
  ['pet', /宠物|猫|狗|养了/],
  ['diet', /忌口|不吃|过敏|口味|爱吃/],
  ['sleep', /作息|几点睡|熬夜|早起/],
]
export function factKeyOf(content) {
  for (const [key, re] of FACT_KEYS) if (re.test(String(content || ''))) return key
  return null
}

/**
 * 写入一条记忆：同层同 scope 语义相近 → 合并（保留 updated_at 最新）；
 * fact 层命中事实键 → 旧条失效。
 * 返回 { id, merged, superseded }。
 */
export function remember(db, layer, raw) {
  if (!LAYERS.includes(layer)) throw new Error('unknown layer: ' + layer)
  const content = String(raw.content || '').trim()
  if (!content) throw new Error('content required')
  const scope = raw.scope || 'global'
  const keywords = (raw.keywords && String(raw.keywords).trim()) || extractKeywords(content)

  // 1) fact 层先算键失效：旧值立刻失效，避免被下一步的「合并」吞掉（改正类事实必须留痕）
  const key = layer === 'fact' ? (raw.fact_key || factKeyOf(content)) : null
  const superseded = []
  if (key) {
    for (const row of listMemory(db, layer, { scope, limit: 400 })) {
      if (row.archived || row.invalid_at) continue
      if ((row.scope || 'global') !== scope) continue
      if (factKeyOf(row.content) !== key) continue
      if (similarity(content, row.content) >= 0.9) continue
      superseded.push(row.id)
    }
  }

  // 2) 同层同 scope 语义相近 → 合并（跳过已失效/归档/待失效的旧条目）
  const sameLayer = listMemory(db, layer, { scope, limit: 400 })
  let best = null
  let bestSim = 0
  for (const row of sameLayer) {
    if (row.archived || row.invalid_at) continue
    if ((row.scope || 'global') !== scope) continue
    if (superseded.includes(row.id)) continue
    const sim = Math.max(similarity(content, row.content), similarity(keywords, row.keywords || ''))
    if (sim > bestSim) { bestSim = sim; best = row }
  }
  if (best && bestSim >= 0.82) {
    const mergedText = content.length > best.content.length ? content : best.content
    const mergedKeywords = [...new Set((best.keywords + ' ' + keywords).split(/\s+/).filter(Boolean))].join(' ')
    const patched = updateMemory(db, layer, best.id, { content: mergedText, keywords: mergedKeywords })
    const ts2 = now()
    for (const oldId of superseded) updateMemory(db, layer, oldId, { invalid_at: ts2, invalid_reason: 'superseded', superseded_by: best.id })
    return { id: best.id, merged: true, row: patched, sim: Number(bestSim.toFixed(3)), superseded }
  }

  const id = insertMemory(db, layer, {
    content,
    scope,
    keywords,
    subcategory: raw.subcategory,
    goal: raw.goal,
    valid_until: raw.valid_until,
    source: raw.source,
    meta: key ? { fact_key: key } : raw.meta,
  })
  const ts = now()
  for (const oldId of superseded) {
    updateMemory(db, layer, oldId, { invalid_at: ts, invalid_reason: 'superseded', superseded_by: id })
  }
  return { id, merged: false, superseded }
}

/** 混合检索：FTS5 BM25 + LIKE 兜底（中文短词）。 */
export function searchMemory(db, query, opts) {
  const o = opts || {}
  const layers = o.layers && o.layers.length ? o.layers.filter((l) => LAYERS.includes(l)) : LAYERS.slice()
  const scope = o.scope || null
  const limit = o.limit || 5
  const q = String(query || '').trim()
  if (!q) return []
  const scored = new Map()

  // FTS：trigram 需要 >= 3 字符，短词跳过
  const terms = (extractKeywords(q) || '').split(' ').filter((t) => t.length >= 3).slice(0, 6)
  if (terms.length) {
    const match = terms.map((t) => '"' + t.replace(/"/g, '') + '"').join(' OR ')
    try {
      const rows = db.prepare(
        'select row_id as id, layer, bm25(memory_fts) as score from memory_fts where memory_fts match ? limit 200',
      ).all(match)
      for (const r of rows) {
        if (!layers.includes(r.layer)) continue
        const cur = scored.get(r.id) || { id: r.id, layer: r.layer, score: 0 }
        cur.score += Math.max(0, 3 - Math.abs(r.score))
        scored.set(r.id, cur)
      }
    } catch { /* FTS 查询失败退回 LIKE */ }
  }

  // LIKE 兜底：逐条比对（数据量小，可控）
  const like = '%' + q.replace(/[%_]/g, '') + '%'
  for (const layer of layers) {
    const rows = listMemory(db, layer, { scope, limit: 500, includeArchived: false })
    for (const row of rows) {
      if (row.invalid_at && o.includeInvalid !== true) continue
      const hay = row.content + ' ' + (row.keywords || '')
      if (hay.includes(q)) {
        const cur = scored.get(row.id) || { id: row.id, layer, score: 0 }
        cur.score += 2
        scored.set(row.id, cur)
      } else if (o.fuzzy !== false) {
        const sim = similarity(q, row.content)
        if (sim > 0.35) {
          const cur = scored.get(row.id) || { id: row.id, layer, score: 0 }
          cur.score += sim
          scored.set(row.id, cur)
        }
      }
    }
  }

  const out = []
  for (const hit of scored.values()) {
    const row = getMemory(db, hit.layer, hit.id)
    if (!row) continue
    if (row.archived) continue
    if (row.invalid_at && o.includeInvalid !== true) continue
    if (scope && row.scope !== scope && row.scope !== 'global') continue
    out.push({ ...row, layer: hit.layer, score: Number(hit.score.toFixed(3)) })
  }
  out.sort((a, b) => b.score - a.score || String(b.updated_at).localeCompare(String(a.updated_at)))
  return out.slice(0, limit)
}

/** 摘要块：注入用（soul / user / rules 摘要）。 */
export function summarizeLayer(db, layer, opts) {
  const rows = listMemory(db, layer, { scope: (opts || {}).scope, limit: (opts || {}).limit || 6, includeInvalid: false })
  return rows.map((r) => '- ' + r.content).join('\n')
}

export { listMemory, getMemory, updateMemory, deleteMemory, makeId }
