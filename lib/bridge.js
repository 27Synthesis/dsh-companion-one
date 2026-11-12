/**
 * companion-one / lib/bridge.js — 把「大肥鱼」那边的东西接进陪伴层（只读）。
 *
 * 那边有它自己的记忆库、便签、约和成长事件；这边不复制、不接管，只在一轮新发言时
 * 取回一小段（≤ budget token）给模型当参考，并在面板上交代一行状态。
 * 读不到就是「那边没东西」：不抛错、不写那边的文件、不因为那边挂了连累这里。
 */
import { clip, queryTerms } from './inject.js'
import { fishRoot, home, notes, appts, recentTalk, events } from './fish.js'
import { memDir, memoriesOf } from './fishmem.js'

const LABEL = '大肥鱼那边'

const norm = (s) => String(s == null ? '' : s).normalize('NFKC').toLowerCase()

function hitCount(text, terms) {
  const t = norm(text)
  if (!t) return 0
  let n = 0
  for (const term of terms) {
    const q = norm(term)
    if (q && t.includes(q)) n += 1
  }
  return n
}

/** 'YYYY-MM-DD' → 还有几天（今天 0，已过为负）；算不出返回 null。 */
export function daysUntil(due, now) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(due || ''))
  if (!m) return null
  const at = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  const d = new Date(now || Date.now())
  const base = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())
  return Math.round((at - base) / 86400000)
}

function dueWord(d, due) {
  if (d == null) return String(due || '')
  if (d === 0) return '今天'
  if (d === 1) return '明天'
  if (d === 2) return '后天'
  if (d < 0) return '已经过了 ' + Math.abs(d) + ' 天'
  return d + ' 天后'
}

const soon = (d) => (d != null && d >= 0 && d <= 3 ? 2 : 0)

function pickNotes(list, terms, limit) {
  const rows = list.map((n) => {
    const d = daysUntil(n.due)
    return { item: n, d, score: hitCount(n.text, terms) * 2 + soon(d) }
  })
  rows.sort((a, b) => (b.score - a.score) || ((a.d == null ? 99 : a.d) - (b.d == null ? 99 : b.d)))
  return rows.filter((r) => r.score > 0).slice(0, limit)
}

function pickAppts(list, terms, limit) {
  const rows = list.map((a) => {
    const d = daysUntil(a.due)
    return { item: a, d, score: hitCount(a.what, terms) * 2 + soon(d) }
  })
  rows.sort((a, b) => (b.score - a.score) || ((a.d == null ? 99 : a.d) - (b.d == null ? 99 : b.d)))
  return rows.filter((r) => r.score > 0).slice(0, limit)
}

function pickMemories(sessionId, terms, limit, env) {
  if (!sessionId) return []
  const rows = memoriesOf(sessionId, { env }).map((m) => ({
    item: m,
    score: hitCount(m.text, terms) * 2 + (m.importance >= 1 ? 1 : 0),
  }))
  rows.sort((a, b) => b.score - a.score)
  return rows.filter((r) => r.score > 1).slice(0, limit).map((r) => r.item)
}

function pickTalk(list, terms, limit) {
  const rows = list.map((t) => ({ item: t, score: hitCount(t.her + ' ' + t.me, terms) }))
  rows.sort((a, b) => b.score - a.score)
  return rows.filter((r) => r.score > 0).slice(0, limit).map((r) => r.item)
}

/**
 * 一轮新发言要带的那一小段。没有可带的东西就返回 ''（不占 token）。
 * query 是主人这句话：拿它的词去挑那边最相关的便签/约/记忆。
 */
export function fishBlock({ session, query, budget = 110, env } = {}) {
  const sid = session && session.id ? String(session.id) : ''
  const terms = queryTerms(String(query || '')).slice(0, 8)
  const lines = []
  try {
    for (const { item: n, d } of pickNotes(notes({ env }), terms, 2)) {
      lines.push('- 便签：' + String(n.text).slice(0, 30) + (n.due ? '（' + dueWord(d, n.due) + '）' : ''))
    }
    for (const { item: a, d } of pickAppts(appts({ env }), terms, 2)) {
      lines.push('- 约好了：' + String(a.what).slice(0, 24) + '（' + dueWord(d, a.due) + '）')
    }
    for (const m of pickMemories(sid, terms, 2, env)) {
      lines.push('- 她记着：' + String(m.text).slice(0, 34))
    }
    for (const t of pickTalk(recentTalk({ limit: 6, env }), terms, 1)) {
      lines.push('- 她最近说过：「' + String(t.her).slice(0, 30) + '」')
    }
  } catch {
    return ''
  }
  if (!lines.length) return ''
  return clip('[' + LABEL + ' · 只读]\n' + lines.join('\n') + '\n（那是另一边的记录，只当背景参考，别复述。）', budget)
}

/** 面板用的一行状态：那边醒着没有、有几张便签、几条约、她那边的记忆几条。 */
export function fishStatus({ session, env } = {}) {
  const sid = session && session.id ? String(session.id) : ''
  let h = null
  let ns = []
  let as = []
  let mems = 0
  let evts = 0
  try { h = home({ env }) } catch {}
  try { ns = notes({ env }) } catch {}
  try { as = appts({ env }) } catch {}
  try { mems = sid ? memoriesOf(sid, { env, limit: 500 }).length : 0 } catch {}
  try { evts = events({ limit: 500, env }).length } catch {}
  const bits = []
  if (ns.length) bits.push('便签 ' + ns.length)
  if (as.length) bits.push('约 ' + as.length)
  if (mems) bits.push('她记着 ' + mems)
  if (evts) bits.push('成长 ' + evts)
  return {
    on: !!h,
    title: h ? h.title : '',
    turns: h ? h.turns : 0,
    notes: ns.length,
    appts: as.length,
    mems,
    events: evts,
    line: h ? (bits.length ? bits.join(' · ') : '那边醒了，还没留下事') : '那边还没醒过',
    root: fishRoot(env),
    memDir: memDir(env),
  }
}
