/**
 * companion-one / lib/companion.js — 陪伴行为层。
 * 机制来源 github.com/lvzhuojun/dsh-companion-memory：按人隔离的 SQL 层过滤、
 * 事实有效期与键失效、到期跟进有分寸、危机词法分级。表结构与实现为本插件自有。
 */
import { now, makeId, kvGet, kvSet, listMemory } from './db.js'

/** 当前对话对象（隔离键）。硬门控：所有读路径都带 scope。 */
export function resolveScope(session, explicit, opts) {
  if (explicit) return String(explicit)
  // 1) 会话头里的对话对象（dsh Session 只有 header，没有 meta）
  const h = (session && session.header) || null
  const peer = (h && (h.peer || h.peerId || h.contact || h.userId)) ||
    (session && session.meta && (session.meta.peer || session.meta.userId))
  if (peer) return 'peer:' + peer
  // 2) 宿主/面板为这个会话绑定的隔离键（dsh-im 的「地址 → 会话」由调用方写进 kv）
  try {
    const db = opts && opts.db
    if (db && session && session.id) {
      const mapped = kvGet(db, 'scope:session:' + session.id, null)
      if (mapped) return String(mapped)
    }
  } catch {}
  // 3) 配置里的默认隔离键（单人使用时固定成 peer:xxx）
  if (opts && opts.defaultScope) return String(opts.defaultScope)
  return 'global'
}

/* ---------------- 惦记的事 ---------------- */
export function addFollowUp(db, { scope, content, dueAt, size, source }) {
  const id = makeId()
  const ts = now()
  db.prepare('insert into follow_ups (id, scope, content, due_at, size, status, source, created_at, updated_at) values (?,?,?,?,?,?,?,?,?)')
    .run(id, scope || 'global', String(content), dueAt || null, size === 'big' ? 'big' : 'small', 'open', source || null, ts, ts)
  return id
}

export function listFollowUps(db, scope, opts) {
  const o = opts || {}
  const args = []
  let sql = 'select * from follow_ups'
  const where = []
  if (scope) { where.push('(scope = ? or scope = \'global\')'); args.push(scope) }
  if (o.status) { where.push('status = ?'); args.push(o.status) }
  if (where.length) sql += ' where ' + where.join(' and ')
  sql += ' order by coalesce(due_at, created_at) asc limit ?'
  args.push(o.limit || 100)
  return db.prepare(sql).all(...args)
}

export function setFollowUpStatus(db, id, status) {
  db.prepare('update follow_ups set status = ?, updated_at = ? where id = ?').run(status, now(), id)
  return db.prepare('select * from follow_ups where id = ?').get(id) || null
}

/** 今天是否已经提过（每天最多一件，跨 scope 也限流）。 */
function askedToday(db) {
  const start = new Date(); start.setHours(0, 0, 0, 0)
  const row = db.prepare('select count(*) as n from follow_ups where asked_at >= ?').get(start.getTime())
  return Number(row?.n || 0) > 0
}

/**
 * 挑选本轮该提的「惦记的事」：到期 / 未提 / 今天还没提过 / 对方没有负面情绪。
 * 大事优先。返回 row 或 null。
 */
export function pickDueFollowUp(db, scope, { userText, nowMs }) {
  const ts = nowMs || now()
  if (askedToday(db)) return null
  const mood = classify(userText || '')
  if (mood.level >= 2) return null           // 对方正在负面情绪里，先不提
  if (/别问了|不想说|别提了|不要问/.test(String(userText || ''))) return null
  const rows = listFollowUps(db, scope, { status: 'open', limit: 50 })
  const due = rows.filter((r) => r.due_at && r.due_at <= ts)
  if (!due.length) return null
  due.sort((a, b) => (a.size === 'big' ? -1 : 0) - (b.size === 'big' ? -1 : 0) || a.due_at - b.due_at)
  return due[0]
}

export function markAsked(db, id) {
  db.prepare('update follow_ups set asked_at = ?, ask_count = ask_count + 1, status = case when status = \'open\' then \'asked\' else status end, updated_at = ? where id = ?')
    .run(now(), now(), id)
  return db.prepare('select * from follow_ups where id = ?').get(id) || null
}

/** 惦记事项的注入文本（一次一件，分寸感）。 */
export function followUpPrompt(row) {
  if (!row) return ''
  const big = row.size === 'big'
  return '[惦记的事] ' + (big ? '这件对主人挺重要：' : '有件小事一直想问问：') + row.content +
    '。自然地问一句就好，对方不想聊就不追问。'
}

/* ---------------- 危机协议 ---------------- */
const LEVELS = [
  { level: 0, name: '平稳', test: () => false },
  { level: 1, name: '轻微低落', words: ['有点累', '不太开心', '烦', '无语', '郁闷'] },
  { level: 2, name: '明显负面', words: ['很难过', '崩溃', '受不了', '好痛苦', '绝望', '没希望', '撑不住', '焦虑'] },
  { level: 3, name: '消沉/无意义', words: ['活着没意思', '不想活', '活着好累', '没有意义', '消失就好了', '没人需要我'] },
  { level: 4, name: '自伤风险', words: ['伤害自己', '自残', '割腕', '想死', '不如死', '结束自己'] },
  { level: 5, name: '急迫危机', words: ['已经准备', '写好了遗书', '现在就结束', '跳下去', '吞药', '马上就想死'] },
]

/** 零成本词法分级 0–5。 */
export function classify(text) {
  const s = String(text || '')
  let level = 0
  let name = LEVELS[0].name
  for (const lv of LEVELS) {
    if (!lv.words) continue
    if (lv.words.some((w) => s.includes(w)) && lv.level > level) { level = lv.level; name = lv.name }
  }
  return { level, name }
}

export const CRISIS_GUIDE = {
  0: '',
  1: '[分寸] 对方有点低落：先陪着，别急着讲道理，也别追问细节。',
  2: '[分寸] 对方情绪明显不好：先接住情绪（一句具体的体谅），再问要不要一起看看办法；不要评估、不要说教。',
  3: '[谨慎期] 对方说出无意义感/不想活类的话：认真对待，直接表达在意；问一句现在身边有没有人；不承诺保密、不评判。',
  4: '[谨慎期·高] 出现自伤/想死的表达：优先安全工作——直接、温和地确认对方此刻是否安全，鼓励联系身边可信任的人或当地心理援助热线（如 12356 心理援助热线、400-161-9995 希望24热线）；不要独自承担、不要转移话题。',
  5: '[谨慎期·急] 可能有即时危险：用最短的话表达在意并给出具体求助方式（110 / 120 / 当地心理援助热线），鼓励立刻联系身边人；同时通知主人这一情况。',
}

/** 危机状态在两轮之间不衰减：由调用方把最高等级记在 kv 里。 */
export function crisisStateKey(scope) { return 'crisis:' + scope }
export function bumpCrisis(db, scope, level) {
  const key = crisisStateKey(scope)
  const prev = kvGet(db, key, { level: 0, at: 0 })
  if (level > (prev.level || 0)) kvSet(db, key, { level, at: now() })
  return kvGet(db, key, { level: 0, at: 0 })
}
export function readCrisis(db, scope) {
  return kvGet(db, crisisStateKey(scope), { level: 0, at: 0 })
}
export function clearCrisis(db, scope) {
  kvSet(db, crisisStateKey(scope), { level: 0, at: now() })
}

/* ---------------- 事实有效期 ---------------- */
/** 当前有效事实（注入用）：invalid_at 为空、未归档、未过期。 */
export function activeFacts(db, scope, limit) {
  const rows = listMemory(db, 'fact', { scope, limit: limit || 30, includeInvalid: false })
  const ts = now()
  return rows.filter((r) => !r.valid_until || r.valid_until > ts)
}

export function expireStale(db, scope) {
  const ts = now()
  const rows = listMemory(db, 'fact', { scope, limit: 200, includeInvalid: false })
  let n = 0
  for (const r of rows) {
    if (r.valid_until && r.valid_until <= ts) {
      db.prepare('update memory_fact set invalid_at = ?, invalid_reason = ? where id = ?').run(ts, 'expired', r.id)
      n++
    }
  }
  return n
}
