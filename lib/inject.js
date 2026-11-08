/**
 * companion-one / lib/inject.js — 记忆注入的三条路径。
 * 机制来源 dsh-meow-memory（MIT）：首轮 snapshot、每消息关键词命中、压缩后重注入。
 * 全部以「独立消息」注入，不改写用户 prompt。
 */
import { summarizeLayer, listMemory } from './memory.js'
import { activeFacts } from './companion.js'
import { narrativeSnapshot } from './persona.js'
import { estimateTokens } from './acp.js'

export function clip(text, maxTokens) {
  const s = String(text || '')
  if (estimateTokens(s) <= maxTokens) return s
  let lo = 0
  let hi = s.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (estimateTokens(s.slice(0, mid)) <= maxTokens) lo = mid
    else hi = mid - 1
  }
  return s.slice(0, lo) + '…'
}

const GUIDE = '记忆导引：memory_search 查旧事，memory_add 记新事（layer 可选 fact/lesson/user/project/topic/rules/soul）。宁可少记，也别记错。'

/** 首轮快照：soul / user / rules 摘要 + 记忆导引（不改写用户 prompt）。 */
export function firstTurnSnapshot(db, scope, budgetTokens) {
  const parts = []
  const soul = clamp(summarizeLayer(db, 'soul', { scope, limit: 3 }), 90)
  const user = clamp(summarizeLayer(db, 'user', { scope, limit: 6 }), 140)
  const rules = clamp(summarizeLayer(db, 'rules', { scope, limit: 4 }), 90)
  if (soul) parts.push('【我是谁】\n' + soul)
  if (user) parts.push('【关于对方】\n' + user)
  if (rules) parts.push('【行为准则】\n' + rules)
  parts.push(GUIDE)
  return clip('[陪伴记忆·首轮]\n' + parts.join('\n'), budgetTokens || 300)
}

function clamp(text, maxTokens) {
  return text ? clip(text, maxTokens) : ''
}

/** 每消息关键词命中：top-2（事实/教训/准则/话题，全局 + 当前 project）。 */
export function keywordHits(db, text, scope, limit) {
  return searchHits(db, text, scope, limit)
}

function searchHits(db, text, scope, limit) {
  const q = String(text || '').trim()
  if (!q) return []
  const out = []
  const seen = new Set()
  const push = (row, layer) => {
    if (!row || seen.has(row.id)) return
    seen.add(row.id)
    out.push({ layer, content: row.content, id: row.id })
  }
  // 事实/用户/教训优先，其次话题/准则/项目
  for (const layer of ['fact', 'user', 'lesson', 'topic', 'rules', 'project']) {
    if (out.length >= (limit || 2)) break
    const rows = hitLayer(db, layer, q, scope, 6)
    for (const r of rows) {
      if (out.length >= (limit || 2)) break
      push(r, layer)
    }
  }
  return out
}

const STOP = new Set(['什么', '怎么', '这个', '那个', '我们', '你们', '是不', '不是', '可以', '一个', '一下', '现在', '然后', '因为', '所以'])

/** 查询切词：拉丁词（≥2）+ 中文二元组（BM25 之外的关键词兜底）。 */
export function queryTerms(q) {
  const s = String(q || '')
  const terms = new Set()
  for (const w of s.match(/[A-Za-z0-9_]{2,}/g) || []) terms.add(w.toLowerCase())
  const cjk = s.replace(/[^\u4e00-\u9fa5]/g, ' ')
  for (const seg of cjk.split(/\s+/)) {
    for (let i = 0; i + 2 <= seg.length; i++) {
      const bg = seg.slice(i, i + 2)
      if (!STOP.has(bg)) terms.add(bg)
    }
  }
  return [...terms]
}

function hitLayer(db, layer, q, scope, n) {
  const rows = listMemory(db, layer, { scope, limit: 200, includeInvalid: false })
  const terms = queryTerms(q)
  if (!terms.length) return []
  const scored = []
  for (const r of rows) {
    const body = String(r.content || '')
    const keys = String(r.keywords || '')
    let score = 0
    for (const t of terms) {
      if (keys.includes(t)) score += 2
      else if (body.includes(t)) score += 1
    }
    if (score >= 2) scored.push({ r, score })
  }
  scored.sort((a, b) => b.score - a.score || b.r.updated_at - a.r.updated_at)
  return scored.slice(0, n).map((x) => x.r)
}

/** 命中注入文本（top-2，控制 token 增量）。 */
export function hitsPrompt(hits, budgetTokens) {
  if (!hits || !hits.length) return ''
  const lines = hits.map((h) => '- [' + h.layer + '] ' + String(h.content).replace(/\s+/g, ' ').slice(0, 90))
  return clip('[记忆命中]\n' + lines.join('\n'), budgetTokens || 120)
}

/**
 * 压缩后重注入：soul/user/rules 摘要 + 本会话 project 全景 + 本会话写入过的记忆原文
 * + persona 当前叙事摘要（≤100 token），总上限 300 token。
 */
export function postCompactionSnapshot(db, { scope, projectIds, writtenIds }, budgetTokens) {
  const parts = []
  const soul = clamp(summarizeLayer(db, 'soul', { scope, limit: 2 }), 60)
  const user = clamp(summarizeLayer(db, 'user', { scope, limit: 4 }), 90)
  const rules = clamp(summarizeLayer(db, 'rules', { scope, limit: 3 }), 60)
  if (soul) parts.push('【我是谁】' + soul)
  if (user) parts.push('【关于对方】' + user)
  if (rules) parts.push('【行为准则】' + rules)

  if (projectIds && projectIds.length) {
    const rows = projectIds.map((id) => db.prepare('select content from memory_project where id = ?').get(id)).filter(Boolean)
    if (rows.length) parts.push('【本会话项目】' + rows.map((r) => String(r.content).slice(0, 60)).join('；'))
  }
  if (writtenIds && writtenIds.length) {
    const rows = writtenIds.slice(0, 6).map((id) => findAny(db, id)).filter(Boolean)
    if (rows.length) parts.push('【本会话记下的】' + rows.map((r) => String(r.content).slice(0, 60)).join('；'))
  }
  const nar = narrativeSnapshot(db)
  if (nar) parts.push('【自我框架】' + nar)
  return clip('[压缩后记忆接续]\n' + parts.join('\n'), budgetTokens || 300)
}

function findAny(db, id) {
  for (const layer of ['fact', 'lesson', 'user', 'project', 'topic', 'rules', 'soul']) {
    try {
      const row = db.prepare('select content from memory_' + layer + ' where id = ?').get(id)
      if (row) return row
    } catch {}
  }
  return null
}

/** 分级压力提示（45% / 75% / 95%）。 */
export function pressureHint(pressure) {
  if (pressure >= 95) return '[上下文] 压力 ≥95%：请立刻调用 acp_status 查看可压缩范围，并调用 compress 提交忠实摘要（目标压到 80% 以下）。'
  if (pressure >= 75) return '[上下文] 压力 ≥75%：可以把较早的对话折叠成摘要了（compress），保留最近三条。'
  if (pressure >= 45) return '[上下文] 压力 ≥45%：留意上下文长度，重要结论及时用 memory_add 落库。'
  return ''
}
