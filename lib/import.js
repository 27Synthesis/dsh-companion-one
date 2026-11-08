/**
 * companion-one / lib/import.js — 把别家记忆插件的内容搬进七层记忆。
 *
 * 设计原则：
 * - 只读：源文件一个字节都不改，也不删除任何东西；
 * - 先预览后导入：scanOtherMemories() 只统计，importOtherMemories() 才写；
 * - 按我们自己的逻辑分类（soul/user/project/fact/lesson/topic/rules），
 *   不照搬对方的标签；写入统一走 memory.js 的 remember()，同层相近会自动合并、
 *   fact 层同一事实键的新值会让旧值失效（可回溯）；
 * - 只认「记忆类」数据：mnemon 的运行时记忆与项目文档、以及 DSH 目录下带
 *   记忆表的 SQLite；不认识的东西宁可跳过，也不乱塞。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { remember } from './memory.js'

const MAX_CONTENT = 1200
const MAX_ROWS = 400

function mnemonHome() {
  return process.env.MNEMON_HOME || join(homedir(), '.mnemon')
}

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

/** 明显是密钥/凭据的内容不搬（宁可少记，也别把密码搬进聊天记忆）。 */
function looksSecret(text) {
  return /(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|x-access-token|Bearer\s+[A-Za-z0-9._-]{20,})/.test(text) ||
    /(密码|口令|token|secret)\s*[:=：]\s*\S{8,}/i.test(text)
}

/**
 * 分类：先看来源给的提示（mnemon 的 target=user 直接进用户层），
 * 再按关键词给七层打分。拿不准就落到 fact（原子事实最不容易出错）。
 */
export function classifyForImport(text, hint) {
  const s = String(text || '')
  if (hint === 'user') return 'user'
  if (hint === 'project') return 'project'
  if (hint === 'rules') return 'rules'
  const score = { soul: 0, user: 0, project: 0, fact: 0, lesson: 0, topic: 0, rules: 0 }
  const hit = (layer, re, w) => { if (re.test(s)) score[layer] += w }
  hit('rules', /(必须|绝不|禁止|不准|只能|一定要|每次都要|规则是|纪律)/, 3)
  hit('lesson', /(教训|踩坑|坑|翻车|失败|下次|别再|不要再|注意不要|经验是|避免)/, 3)
  hit('project', /(项目|仓库|插件|源码|代码|部署|接口|脚本|配置|版本|路径|文件|目录|仓库|工程|commit|API)/, 2)
  hit('user', /(喜欢|讨厌|偏好|习惯|称呼|生日|家住|住在|工作|职业|家人|朋友|口味|作息|忌口)/, 2)
  hit('topic', /(话题|计划|打算|在纠结|考虑中|想来想去|正在做)/, 1)
  hit('fact', /(账号|密码|地址|电话|邮箱|时间|日期|金额|价格|编号|链接|网址|叫|是)/, 1)
  hit('soul', /(我是鲸鲸|我的身份|自我设定|人格设定|说话方式)/, 3)
  let best = 'fact'
  let bestScore = 0
  for (const [layer, n] of Object.entries(score)) {
    if (n > bestScore) { best = layer; bestScore = n }
  }
  return best
}

/** 正则/代码碎片不当记忆：去掉标点后至少 4 个实字，正则符号占比不能过高。 */
function looksMeaningful(text) {
  const s = String(text || '')
  const plain = s.replace(/[\s\p{P}\p{S}]/gu, '')
  if (plain.length < 4) return false
  if (/^[\\|/^$.*+?()[\]{}]/.test(s.trim())) return false
  const meta = (s.match(/[\\|()[\]{}.*+?^$/]/g) || []).length
  if (s.length && meta / s.length > 0.3) return false
  return true
}

function pushItems(list, items) {
  for (const it of items) {
    if (!it || !it.content) continue
    const content = String(it.content).replace(/\s+/g, ' ').trim()
    if (content.length < 6) continue
    if (!looksMeaningful(content)) continue
    if (looksSecret(content)) continue
    list.push({ content: content.slice(0, MAX_CONTENT), hint: it.hint || '', at: it.at || null })
  }
}

/** 适配器 1：mnemon 运行时记忆（memories.json；没有就退回 MEMORY.md / USER.md）。 */
function readMnemonRuntime() {
  const root = join(mnemonHome(), 'runtime')
  const file = join(root, 'memories.json')
  const items = []
  if (existsSync(file)) {
    try {
      const j = JSON.parse(readFileSync(file, 'utf8'))
      const list = Array.isArray(j) ? j : (Array.isArray(j.entries) ? j.entries : [])
      pushItems(items, list.map((e) => ({
        content: e.content,
        hint: e.target === 'user' ? 'user' : 'memory',
        at: e.updated_at || e.created_at,
      })))
    } catch { /* 损坏就当没有 */ }
  }
  if (!items.length) {
    for (const [name, hint] of [['MEMORY.md', 'memory'], ['USER.md', 'user']]) {
      const f = join(root, name)
      if (!existsSync(f)) continue
      try {
        const text = readFileSync(f, 'utf8')
        for (const block of text.split(/^§$/m)) pushItems(items, [{ content: block, hint }])
      } catch {}
    }
  }
  if (!items.length) return null
  return { id: 'mnemon:runtime', label: 'Mnemon · 运行时记忆', path: file, items }
}

/** 适配器 2：mnemon 项目文档（标题 + 摘要 + 正文开头，落到 project 层）。 */
function readMnemonDocuments() {
  const root = join(mnemonHome(), 'documents')
  const idx = join(root, 'index.json')
  if (!existsSync(idx)) return null
  const items = []
  try {
    const j = JSON.parse(readFileSync(idx, 'utf8'))
    const docs = Array.isArray(j) ? j : (Array.isArray(j.documents) ? j.documents : [])
    for (const d of docs) {
      if (!d || d.status === 'archived') continue
      const parts = []
      if (d.title) parts.push(String(d.title).trim())
      if (d.description) parts.push(String(d.description).trim())
      const rel = d.relativePath || (d.filename ? join('active', d.filename) : '')
      if (rel) {
        try {
          const body = readFileSync(join(root, rel), 'utf8')
            .replace(/^#.*$/gm, ' ')
            .replace(/```[\s\S]*?```/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
          if (body) parts.push(body.slice(0, 600))
        } catch {}
      }
      if (parts.length) pushItems(items, [{ content: parts.join('。'), hint: 'project', at: d.updatedAt }])
    }
  } catch { return null }
  if (!items.length) return null
  return { id: 'mnemon:documents', label: 'Mnemon · 项目文档', path: idx, items }
}

const MEMORY_TABLE = /^(memories|memory|insights|notes|facts|knowledge|entries|kv_memory)$/i
const CONTENT_COLUMN = /^(content|text|body|value|memory|summary)$/i

/** 适配器 3：DSH 目录下其它 SQLite 里的记忆表（保守：只认表名/列名都像记忆的）。 */
function readOtherSqlite() {
  const roots = [dshHome(), join(dshHome(), 'storages'), join(dshHome(), 'profiles', 'web')]
  const seen = new Set()
  const items = []
  const walked = []
  const scan = (dir, depth) => {
    if (depth > 2 || !existsSync(dir)) return
    let entries = []
    try { entries = readdirSync(dir) } catch { return }
    for (const name of entries) {
      const full = join(dir, name)
      let st
      try { st = statSync(full) } catch { continue }
      if (st.isDirectory()) {
        if (name === 'node_modules' || name === 'sessions' || name === 'cache') continue
        scan(full, depth + 1)
        continue
      }
      if (!/\.(db|sqlite|sqlite3)$/i.test(name)) continue
      if (/companion-one/i.test(name) || seen.has(full)) continue
      if (st.size < 200) continue
      seen.add(full)
      walked.push(full)
      let db
      try { db = new DatabaseSync(full, { readOnly: true }) } catch { continue }
      try {
        const tables = db.prepare("select name from sqlite_master where type='table'").all().map((r) => String(r.name))
        for (const table of tables) {
          if (!MEMORY_TABLE.test(table)) continue
          let cols = []
          try { cols = db.prepare('pragma table_info(' + table + ')').all().map((c) => String(c.name)) } catch { continue }
          const col = cols.find((c) => CONTENT_COLUMN.test(c))
          if (!col) continue
          let rows = []
          try { rows = db.prepare('select * from ' + table + ' limit ' + MAX_ROWS).all() } catch { continue }
          pushItems(items, rows.map((r) => ({ content: String(r[col] || ''), hint: '' })))
        }
      } catch { /* 不是能读的库就跳过 */ }
      finally { try { db.close() } catch {} }
    }
  }
  for (const root of roots) scan(root, 0)
  if (!items.length) return null
  return { id: 'sqlite:other', label: '其它 SQLite 记忆表', path: walked.join(', '), items }
}

const ADAPTERS = [readMnemonRuntime, readMnemonDocuments, readOtherSqlite]

/** 跑一遍所有适配器，拿回完整来源（含条目内容，只在进程内用）。 */
function collectSources() {
  const sources = []
  for (const adapter of ADAPTERS) {
    try {
      const src = adapter()
      if (!src || !src.items.length) continue
      sources.push(src)
    } catch { /* 单个适配器坏掉不影响其它 */ }
  }
  return sources
}

/** 只统计、不写入：面板先给用户看清单（不带全文，省带宽）。 */
export function scanOtherMemories() {
  const sources = collectSources().map((src) => {
    const byLayer = {}
    for (const it of src.items) {
      const layer = classifyForImport(it.content, it.hint)
      byLayer[layer] = (byLayer[layer] || 0) + 1
    }
    return {
      id: src.id,
      label: src.label,
      path: src.path,
      count: src.items.length,
      byLayer,
      sample: src.items.slice(0, 3).map((it) => it.content.slice(0, 70)),
    }
  })
  return { ok: true, sources, total: sources.reduce((n, s) => n + s.count, 0) }
}

/**
 * 真正导入。sourceId：all / 某个 adapter id / 省略=全部。
 * scope 默认 global（mnemon 的记忆本来就是全设备一份，没有按人隔离）。
 */
export function importOtherMemories(db, opts) {
  const o = opts || {}
  const scanned = collectSources()
  const wanted = String(o.sourceId || 'all')
  const picked = scanned.filter((s) => wanted === 'all' || wanted === s.id)
  if (!picked.length) return { ok: false, reason: 'nothing_to_import', scanned: scanned.map((s) => s.id) }
  const cap = Math.min(1000, Math.max(1, Number(o.limit) || 500))
  const scope = String(o.scope || 'global')
  const byLayer = {}
  const details = []
  let imported = 0
  let merged = 0
  let skipped = 0
  for (const src of picked) {
    for (const it of src.items) {
      if (imported + merged >= cap) break
      if (!it || !it.content) { skipped++; continue }
      const layer = o.layer || classifyForImport(it.content, it.hint)
      try {
        const res = remember(db, layer, { content: it.content, scope, source: 'import:' + src.id })
        if (res.merged) merged++
        else imported++
        byLayer[layer] = (byLayer[layer] || 0) + 1
        if (details.length < 8) details.push({ layer, content: it.content.slice(0, 60), merged: !!res.merged })
      } catch { skipped++ }
    }
  }
  return { ok: true, scope, sources: picked.map((s) => s.id), read: picked.reduce((n, s) => n + s.items.length, 0), imported, merged, skipped, byLayer, details }
}
