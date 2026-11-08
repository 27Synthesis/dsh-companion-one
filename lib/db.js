/**
 * companion-one / lib/db.js
 * 单一 SQLite 文件承载全部子系统：七层记忆、压缩块与归档、惦记事项、风格卡片、
 * 可塑人格三层，以及通用 kv（设置 / acp_state）。
 *
 * 来源说明（许可合规）：
 * - 七层记忆表结构（soul/user/project/fact/lesson/topic/rules）参考
 *   github.com/Phant0Meow/dsh-meow-memory（MIT），按陪伴场景增补 scope 隔离键、
 *   valid_until 有效期、keywords 命中词，非原样复制。
 * - 压缩块 / 归档消息 / FTS5 检索的工具语义参考
 *   github.com/ranxianglei/billion-context（ACP 工具族），用 node:sqlite 重写。
 * - 只使用 Node 内置 node:sqlite，无原生编译依赖。
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

export const LAYERS = ['soul', 'user', 'project', 'fact', 'lesson', 'topic', 'rules']
export const LAYER_LABELS = {
  soul: 'AI 自身设定', user: '用户信息与偏好', project: '项目信息',
  fact: '原子事实', lesson: '教训与纠正', topic: '进行中话题', rules: '行为准则',
}

export const now = () => Date.now()

/** 时间前缀 + 短 UUID：字典序即创建序（meow-memory 的 id 约定）。 */
export function makeId() {
  return Date.now().toString(36).padStart(9, '0') + '-' + randomUUID().slice(0, 8)
}

function tableFor(layer) {
  if (!LAYERS.includes(layer)) throw new Error('unknown memory layer: ' + layer)
  return 'memory_' + layer
}

export function openDb(path) {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  try { db.exec('pragma journal_mode = WAL') } catch {}
  try { db.exec('pragma busy_timeout = 4000') } catch {}
  try { db.exec('pragma synchronous = NORMAL') } catch {}
  ensureSchema(db)
  // 上次进程在「写 pending 归档」与「surface replace 成功」之间崩掉时，块会一直停在 pending。
  // 归档内容仍可读；这里只把它标成 orphan，避免面板/统计把它算成一次成功压缩。
  try {
    db.prepare("update compressed_blocks set status = 'orphan' where status = 'pending' and created_at < ?").run(Date.now() - 60000)
  } catch {}
  return db
}

const MEMORY_COLUMNS = [
  'id text primary key',
  'content text not null',
  "scope text not null default 'global'",
  "keywords text not null default ''",
  'subcategory text',
  'goal text',
  'valid_until integer',
  'invalid_at integer',
  'invalid_reason text',
  'superseded_by text',
  'archived integer not null default 0',
  'pinned integer not null default 0',
  'source text',
  "meta text not null default '{}'",
  'created_at integer not null',
  'updated_at integer not null',
].join(', ')

export function ensureSchema(db) {
  for (const layer of LAYERS) {
    const t = tableFor(layer)
    db.exec('create table if not exists ' + t + ' (' + MEMORY_COLUMNS + ')')
    db.exec('create index if not exists idx_' + layer + '_scope on ' + t + '(scope, archived, updated_at)')
  }

  db.exec([
    'create table if not exists compressed_blocks (',
    '  id text primary key,',
    '  session_id text not null,',
    '  tier integer not null default 1,',
    '  parent_id text,',
    "  child_refs text not null default '[]',",
    '  start_seq integer not null,',
    '  end_seq integer not null,',
    '  summary text not null,',
    '  summary_tokens integer not null default 0,',
    '  source_tokens integer not null default 0,',
    '  tokens_saved integer not null default 0,',
    '  message_count integer not null default 0,',
    "  status text not null default 'committed',",
    '  created_at integer not null',
    ')',
  ].join('\n'))
  db.exec('create index if not exists idx_blocks_session on compressed_blocks(session_id, created_at)')

  // 会话级即时状态：给 dsh-go 侧边面板读（每轮 pre-step 更新）
  db.exec([
    'create table if not exists session_state (',
    '  session_id text primary key,',
    '  scope text,',
    '  mood text,',
    '  mood_level integer not null default 0,',
    '  mood_why text,',
    '  mood_need text,',
    '  user_state text,',
    '  user_valence real not null default 0,',
    '  user_energy real not null default 0.5,',
    '  heart text,',
    '  heart_at integer,',
    '  heart_source text,',
    '  pressure real not null default 0,',
    '  user_msgs integer not null default 0,',
    '  last_user text,',
    '  updated_at integer not null',
    ')',
  ].join('\n'))
  // 旧库补列：create table if not exists 不会给已存在的表加字段。
  try {
    const have = new Set(db.prepare('pragma table_info(session_state)').all().map((c) => c.name))
    const addColumn = (name, sql) => {
      if (!have.has(name)) db.exec('alter table session_state add column ' + sql)
    }
    addColumn('mood_why', 'mood_why text')
    addColumn('mood_need', 'mood_need text')
    addColumn('user_state', 'user_state text')
    addColumn('user_valence', 'user_valence real not null default 0')
    addColumn('user_energy', 'user_energy real not null default 0.5')
    addColumn('heart', 'heart text')
    addColumn('heart_at', 'heart_at integer')
    addColumn('heart_source', 'heart_source text')
  } catch { /* 迁移失败不阻塞旧库使用 */ }

  // 心声：每轮一句，只用于面板展示，不参与人格学习（人格只看用户发言）。
  db.exec([
    'create table if not exists heart_voice (',
    '  id text primary key,',
    '  session_id text,',
    "  scope text not null default 'global',",
    '  mood text,',
    '  content text not null,',
    "  source text not null default 'model',",
    '  user_text text,',
    '  seq integer,',
    '  created_at integer not null',
    ')',
  ].join('\n'))
  db.exec('create index if not exists idx_heart_session on heart_voice(session_id, created_at)')

  db.exec([
    'create table if not exists compressed_messages (',
    '  id text primary key,',
    '  block_id text not null,',
    '  session_id text not null,',
    '  seq integer not null,',
    '  role text not null,',
    '  content text not null,',
    '  created_at integer not null',
    ')',
  ].join('\n'))
  db.exec('create index if not exists idx_cmsg_block on compressed_messages(block_id)')
  db.exec('create index if not exists idx_cmsg_session on compressed_messages(session_id, seq)')

  db.exec([
    'create table if not exists follow_ups (',
    '  id text primary key,',
    "  scope text not null default 'global',",
    '  content text not null,',
    '  due_at integer,',
    "  size text not null default 'small',",
    "  status text not null default 'open',",
    '  asked_at integer,',
    '  ask_count integer not null default 0,',
    '  source text,',
    '  created_at integer not null,',
    '  updated_at integer not null',
    ')',
  ].join('\n'))
  db.exec('create index if not exists idx_follow_scope on follow_ups(scope, status, due_at)')

  db.exec([
    'create table if not exists style_card (',
    '  key text primary key,',
    '  value text not null,',
    '  confidence real not null default 0.5,',
    '  samples integer not null default 0,',
    '  updated_at integer not null',
    ')',
  ].join('\n'))

  db.exec([
    'create table if not exists persona_reaction (',
    '  key text primary key,',
    '  value real not null,',
    '  updated_at integer not null,',
    '  source_session text,',
    '  source_seq integer',
    ')',
  ].join('\n'))

  db.exec([
    'create table if not exists persona_chain (',
    '  id text primary key,',
    '  content text not null,',
    '  uses integer not null default 0,',
    '  sentiment real not null default 0,',
    '  last_used_at integer,',
    '  created_at integer not null,',
    '  source_session text,',
    '  promoted integer not null default 0',
    ')',
  ].join('\n'))

  db.exec([
    'create table if not exists persona_narrative (',
    '  id text primary key,',
    '  version integer not null,',
    '  summary text not null,',
    "  values_json text not null default '[]',",
    "  rules_json text not null default '[]',",
    "  taboos_json text not null default '[]',",
    '  created_at integer not null,',
    '  source_session text,',
    '  source_seq integer,',
    '  is_current integer not null default 0',
    ')',
  ].join('\n'))
  db.exec('create index if not exists idx_narrative_version on persona_narrative(version)')

  db.exec([
    'create table if not exists kv (',
    '  key text primary key,',
    '  value text not null,',
    '  updated_at integer not null',
    ')',
  ].join('\n'))

  // FTS5：中文场景用 trigram 分词（>=3 字可子串命中），短词由 LIKE 兜底。
  const fts = [
    ["create virtual table if not exists compressed_fts using fts5(content, block_id UNINDEXED, message_id UNINDEXED, tokenize='trigram')",
     'create virtual table if not exists compressed_fts using fts5(content, block_id UNINDEXED, message_id UNINDEXED)'],
    ["create virtual table if not exists memory_fts using fts5(content, keywords, layer UNINDEXED, row_id UNINDEXED, tokenize='trigram')",
     'create virtual table if not exists memory_fts using fts5(content, keywords, layer UNINDEXED, row_id UNINDEXED)'],
  ]
  for (const pair of fts) {
    try { db.exec(pair[0]) } catch { try { db.exec(pair[1]) } catch { /* FTS 不可用则走 LIKE */ } }
  }
}

/* ---------------- kv ---------------- */
export function kvGet(db, key, dflt) {
  const row = db.prepare('select value from kv where key = ?').get(key)
  if (!row) return dflt
  try { return JSON.parse(row.value) } catch { return dflt }
}

export function kvSet(db, key, value) {
  db.prepare('insert into kv(key, value, updated_at) values (?, ?, ?) on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at')
    .run(key, JSON.stringify(value), now())
}

export function kvDelete(db, key) {
  db.prepare('delete from kv where key = ?').run(key)
}

/* ---------------- 记忆读写 ---------------- */
export function insertMemory(db, layer, entry) {
  const t = tableFor(layer)
  const id = entry.id || makeId()
  const ts = now()
  db.prepare(
    'insert into ' + t + ' (id, content, scope, keywords, subcategory, goal, valid_until, invalid_at,' +
    ' invalid_reason, superseded_by, archived, pinned, source, meta, created_at, updated_at)' +
    ' values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
  ).run(
    id, entry.content, entry.scope || 'global', entry.keywords || '', entry.subcategory || null,
    entry.goal || null, entry.valid_until || null, entry.invalid_at || null, entry.invalid_reason || null,
    entry.superseded_by || null, entry.archived ? 1 : 0, entry.pinned ? 1 : 0,
    entry.source || null, JSON.stringify(entry.meta || {}), ts, ts,
  )
  indexMemory(db, layer, { id, content: entry.content, keywords: entry.keywords || '' })
  return id
}

export function updateMemory(db, layer, id, patch) {
  const t = tableFor(layer)
  const row = db.prepare('select * from ' + t + ' where id = ?').get(id)
  if (!row) return null
  const next = { ...row, ...patch, updated_at: now() }
  db.prepare(
    'update ' + t + ' set content=?, keywords=?, scope=?, subcategory=?, goal=?, valid_until=?,' +
    ' invalid_at=?, invalid_reason=?, superseded_by=?, archived=?, pinned=?, meta=?, updated_at=? where id=?',
  ).run(
    next.content, next.keywords || '', next.scope, next.subcategory || null, next.goal || null,
    next.valid_until || null, next.invalid_at || null, next.invalid_reason || null,
    next.superseded_by || null, next.archived ? 1 : 0, next.pinned ? 1 : 0,
    next.meta || '{}', next.updated_at, id,
  )
  unindexMemory(db, id)
  if (!next.archived) indexMemory(db, layer, { id, content: next.content, keywords: next.keywords || '' })
  return db.prepare('select * from ' + t + ' where id = ?').get(id)
}

export function deleteMemory(db, layer, id) {
  const t = tableFor(layer)
  db.prepare('delete from ' + t + ' where id = ?').run(id)
  unindexMemory(db, id)
}

export function listMemory(db, layer, opts) {
  const o = opts || {}
  const includeInvalid = o.includeInvalid !== false
  const includeArchived = o.includeArchived === true
  const limit = o.limit || 200
  const t = tableFor(layer)
  const where = []
  const args = []
  if (o.scope) { where.push("(scope = ? or scope = 'global')"); args.push(o.scope) }
  if (!includeArchived) where.push('archived = 0')
  if (!includeInvalid) where.push('invalid_at is null')
  const sql = 'select * from ' + t + (where.length ? ' where ' + where.join(' and ') : '') +
    ' order by updated_at desc limit ?'
  args.push(limit)
  return db.prepare(sql).all(...args)
}

export function getMemory(db, layer, id) {
  return db.prepare('select * from memory_' + layer + ' where id = ?').get(id) || null
}

/* ---------------- FTS 维护 ---------------- */
export function indexMemory(db, layer, row) {
  try {
    db.prepare('delete from memory_fts where row_id = ? and layer = ?').run(row.id, layer)
    db.prepare('insert into memory_fts(content, keywords, layer, row_id) values (?,?,?,?)')
      .run(row.content, row.keywords || '', layer, row.id)
  } catch { /* FTS 缺席时静默，搜索走 LIKE */ }
}

export function unindexMemory(db, id) {
  try { db.prepare('delete from memory_fts where row_id = ?').run(id) } catch {}
}