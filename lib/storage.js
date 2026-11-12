/**
 * companion-one / lib/storage.js — 占用统计与「聊天记录」清理。
 *
 * 为什么单独一个文件：这库的全部数据都在一个 SQLite 文件里，主人想清东西时
 * 需要先知道「东西在哪、占多少」。这里把页面级的真实占用摊开（dbstat），
 * 再按会话列出聊天归档，删完顺手收拾文件（checkpoint + VACUUM）。
 *
 * 只删归档，不动记忆：memory_* 七层、人格、风格、惦记都不在清理范围内。
 */
import { statSync } from 'node:fs'

/* ---------------- 文件占用 ---------------- */

function safeStat(p) {
  try { return statSync(p).size } catch { return 0 }
}

/** 库文件路径：问 SQLite 自己，省得从 index.js 往下传。 */
export function dbFilePath(db) {
  try {
    const rows = db.prepare('pragma database_list').all()
    const main = rows.find((r) => r.name === 'main')
    return (main && main.file) || ''
  } catch { return '' }
}

export function fileSizes(path) {
  if (!path) return { db: 0, wal: 0, shm: 0, total: 0 }
  const db = safeStat(path)
  const wal = safeStat(path + '-wal')
  const shm = safeStat(path + '-shm')
  return { db, wal, shm, total: db + wal + shm }
}

/* ---------------- 分块占用 ---------------- */

// dbstat 给的是「表 + 索引 + FTS 影子表」逐页的字节数，按前缀归成主人看得懂的分组。
const GROUP_DEFS = [
  ['chat', '聊天归档', (n) => /^compressed_messages/.test(n) || /^compressed_fts/.test(n) || /^idx_cmsg_/.test(n)],
  ['blocks', '压缩块摘要', (n) => /^compressed_blocks/.test(n) || /^idx_blocks_/.test(n) || n === 'sqlite_autoindex_compressed_blocks_1'],
  ['memory', '七层记忆', (n) => /^memory_/.test(n) || /^idx_memory/.test(n)],
  ['heart', '心声', (n) => /^heart_voice/.test(n) || /^idx_heart_session/.test(n)],
  ['persona', '人格', (n) => /^persona_/.test(n)],
  ['state', '会话状态', (n) => /^session_state/.test(n)],
  ['followup', '惦记', (n) => /^follow_ups/.test(n) || /^idx_follow_scope/.test(n)],
  ['style', '风格卡', (n) => /^style_card/.test(n)],
  ['kv', '设置与杂项', (n) => /^kv/.test(n)],
  ['schema', '表结构', (n) => n === 'sqlite_schema'],
]

function pageBytes(db) {
  try {
    const rows = db.prepare('select name, sum(pgsize) as bytes, count(*) as pages from dbstat group by name').all()
    return rows
  } catch { return null }  // 没编译 dbstat：退回估算
}

/** dbstat 不可用时的粗估：文本按长度，其余按行数 × 一页。 */
function estimateBytes(db) {
  const out = []
  const add = (name, bytes) => out.push({ name, bytes: Number(bytes) || 0, pages: 0 })
  try {
    add('compressed_messages', db.prepare('select sum(length(cast(content as blob))) b from compressed_messages').get().b || 0)
    add('compressed_fts_data', db.prepare('select sum(length(cast(content as blob))) b from compressed_fts').get().b || 0)
    add('compressed_blocks', db.prepare('select sum(length(cast(summary as blob))) b from compressed_blocks').get().b || 0)
    add('heart_voice', db.prepare('select sum(length(cast(content as blob))) b from heart_voice').get().b || 0)
    add('memory_all', db.prepare("select sum(length(cast(content as blob))) b from (select content from memory_soul union all select content from memory_user union all select content from memory_project union all select content from memory_fact union all select content from memory_lesson union all select content from memory_topic union all select content from memory_rules)").get().b || 0)
  } catch { /* 尽力而为 */ }
  return out
}

export function groupBytes(db) {
  const rows = pageBytes(db) || estimateBytes(db)
  const map = new Map(GROUP_DEFS.map(([id, label]) => [id, { id, label, bytes: 0, pages: 0 }]))
  map.set('other', { id: 'other', label: '其他', bytes: 0, pages: 0 })
  for (const r of rows) {
    const name = String(r.name || '')
    const hit = GROUP_DEFS.find(([, , test]) => test(name))
    const slot = map.get(hit ? hit[0] : 'other')
    slot.bytes += Number(r.bytes) || 0
    slot.pages += Number(r.pages) || 0
  }
  return [...map.values()].filter((g) => g.bytes > 0).sort((a, b) => b.bytes - a.bytes)
}

/* ---------------- 计数 ---------------- */

function count(db, sql, ...args) {
  try { return db.prepare(sql).get(...args).c || 0 } catch { return 0 }
}

export function counts(db) {
  let memories = 0
  for (const layer of ['soul', 'user', 'project', 'fact', 'lesson', 'topic', 'rules']) {
    memories += count(db, 'select count(*) c from memory_' + layer + ' where archived = 0 and invalid_at is null')
  }
  return {
    blocks: count(db, 'select count(*) c from compressed_blocks'),
    messages: count(db, 'select count(*) c from compressed_messages'),
    hearts: count(db, 'select count(*) c from heart_voice'),
    sessions: count(db, 'select count(distinct session_id) c from compressed_messages'),
    memories,
    followups: count(db, 'select count(*) c from follow_ups'),
  }
}

/** 面板「占用」栏用：文件大小 + 分组 + 计数 + 空闲页（删完不 VACUUM 就是这部分没还回去）。 */
export function storageReport(db) {
  const path = dbFilePath(db)
  const file = fileSizes(path)
  let freelist = 0
  try {
    freelist = Number(db.prepare('pragma freelist_count').get().freelist_count) || 0
    const pageSize = Number(db.prepare('pragma page_size').get().page_size) || 0
    freelist *= pageSize
  } catch { freelist = 0 }
  return {
    ok: true,
    path,
    file,
    total: file.total,
    freelist,
    groups: groupBytes(db),
    counts: counts(db),
  }
}

/* ---------------- 聊天记录（按会话） ---------------- */

const PREVIEW = 40

function clip(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}

// 会话名不能拿系统注入凑数：运行时快照、记忆提示、系统提醒都不是主人说的话。
const NOISE = /^(current runtime context|mnemon|\[mnemon\]|system-reminder|<|you are a helpful)/i

function pickName(lines) {
  for (const line of lines || []) {
    const t = String(line || '').trim()
    if (t && !NOISE.test(t)) return clip(t, PREVIEW)
  }
  return ''
}

/**
 * 像微信的会话列表：一个会话一行 —— 名字（取它最早那条用户发言）、条数、
 * 占用（内容字节，索引会让实际占用更大）、起止时间。
 */
export function chatSessions(db, { limit = 200 } = {}) {
  const rows = []
  try {
    rows.push(...db.prepare(
      'select session_id as sessionId, count(*) as messages,' +
      ' sum(length(cast(content as blob))) as bytes,' +
      ' min(created_at) as firstAt, max(created_at) as lastAt' +
      ' from compressed_messages m group by session_id order by lastAt desc limit ?').all(limit))
  } catch { /* 空库 */ }
  // 每个会话的头几条用户发言：用来挑一个像人话的名字
  const heads = new Map()
  try {
    for (const r of db.prepare(
      'select session_id as sessionId, content, row_number() over (partition by session_id order by seq) as rn' +
      " from compressed_messages where role = 'user'").all()) {
      if ((r.rn || 0) > 6) continue
      const list = heads.get(r.sessionId) || []
      list.push(r.content)
      heads.set(r.sessionId, list)
    }
  } catch {}
  // 没有归档消息但有压缩块/心声的会话也列出来，别让脏数据躲着
  const extra = []
  try {
    extra.push(...db.prepare(
      'select session_id as sessionId, count(*) as blocks, max(created_at) as lastAt from compressed_blocks group by session_id').all())
  } catch {}
  const out = new Map()
  for (const r of rows) {
    out.set(r.sessionId, {
      sessionId: r.sessionId,
      name: pickName(heads.get(r.sessionId)) || '(空会话)',
      messages: r.messages || 0,
      blocks: 0,
      hearts: 0,
      bytes: r.bytes || 0,
      firstAt: r.firstAt || null,
      lastAt: r.lastAt || null,
    })
  }
  for (const r of extra) {
    const hit = out.get(r.sessionId)
    if (hit) { hit.blocks = r.blocks || 0; hit.lastAt = Math.max(hit.lastAt || 0, r.lastAt || 0) || hit.lastAt; continue }
    out.set(r.sessionId, { sessionId: r.sessionId, name: '(只剩压缩块)', messages: 0, blocks: r.blocks || 0, hearts: 0, bytes: 0, firstAt: null, lastAt: r.lastAt || null })
  }
  try {
    for (const r of db.prepare('select session_id as sessionId, count(*) as hearts, max(created_at) as lastAt from heart_voice group by session_id').all()) {
      const hit = out.get(r.sessionId)
      if (hit) { hit.hearts = r.hearts || 0; hit.lastAt = Math.max(hit.lastAt || 0, r.lastAt || 0) || hit.lastAt }
      else out.set(r.sessionId, { sessionId: r.sessionId, name: '(仅心声)', messages: 0, blocks: 0, hearts: r.hearts || 0, bytes: 0, firstAt: null, lastAt: r.lastAt || null })
    }
  } catch {}
  // 有聊天内容的排前面，只剩心声的沉底（它们没有聊天记录可删，只有心声）
  const list = [...out.values()].sort((a, b) => {
    const ka = a.messages || a.blocks ? 1 : 0
    const kb = b.messages || b.blocks ? 1 : 0
    if (ka !== kb) return kb - ka
    return (b.lastAt || 0) - (a.lastAt || 0)
  })
  return {
    ok: true,
    sessions: list,
    hearts: db.prepare('select count(*) c from heart_voice').get().c || 0,
    bytes: list.reduce((n, s) => n + s.bytes, 0),
  }
}

/* ---------------- 清理 ---------------- */

function checkpoint(db) {
  try { db.exec('pragma wal_checkpoint(truncate)') } catch {}
}

function vacuum(db) {
  try { db.exec('vacuum') } catch (err) { return String(err && err.message || err) }
  return ''
}

/**
 * 删聊天记录。all=true 清全部；否则按 sessionId。
 * 删的都是「归档副本」：七层记忆、人格、风格卡、惦记、设置一律不碰。
 * 心声默认保留 —— 它不在「聊天记录」里，得显式 heart=true 才动。
 */
export function purgeChat(db, { sessionId, all, heart, compact = true } = {}) {
  const sid = String(sessionId || '').trim()
  if (!all && !sid) throw new Error('need sessionId or all')
  const path = dbFilePath(db)
  checkpoint(db)

  const deleted = { messages: 0, blocks: 0, hearts: 0 }
  const where = all ? '' : ' where session_id = ?'
  const args = all ? [] : [sid]

  db.exec('begin')
  try {
    if (heart) deleted.hearts = Number(db.prepare('delete from heart_voice' + where).run(...args).changes) || 0
    // 先删 FTS 正文再删消息，block_id 在 FTS 里是 UNINDEXED 列，靠全表扫描匹配
    const blockIds = all
      ? db.prepare('select id from compressed_blocks').all().map((r) => r.id)
      : db.prepare('select id from compressed_blocks where session_id = ?').all(sid).map((r) => r.id)
    const delFts = db.prepare('delete from compressed_fts where block_id = ?')
    for (const id of blockIds) { try { delFts.run(id) } catch {} }
    deleted.messages = Number(db.prepare('delete from compressed_messages' + where).run(...args).changes) || 0
    deleted.blocks = Number(db.prepare('delete from compressed_blocks' + where).run(...args).changes) || 0
    db.exec('commit')
  } catch (err) {
    try { db.exec('rollback') } catch {}
    throw err
  }

  checkpoint(db)
  const before = fileSizes(path).total
  let note = ''
  if (compact) note = vacuum(db)
  checkpoint(db)
  const afterSizes = fileSizes(path)
  return {
    ok: true,
    dry: false,
    scope: all ? 'all' : sid,
    deleted,
    before,
    after: afterSizes.total,
    freed: Math.max(0, before - afterSizes.total),
    vacuumError: note || null,
    file: afterSizes,
  }
}

/** 「整理数据库」：只 checkpoint + VACUUM，不删任何行。 */
export function compactDb(db) {
  const path = dbFilePath(db)
  checkpoint(db)
  const before = fileSizes(path).total
  const err = vacuum(db)
  checkpoint(db)
  const after = fileSizes(path).total
  return { ok: true, before, after, freed: Math.max(0, before - after), vacuumError: err || null, file: fileSizes(path) }
}
