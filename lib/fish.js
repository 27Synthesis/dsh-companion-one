/**
 * companion-one / lib/fish.js — 「大肥鱼」那边只读的一角。
 *
 * dsh-fish 的 exports 只有 "."（没法 import 子路径），所以这里直接读它落在盘上的
 * 数据根（DSH_FISH_HOME，默认 ~/.dsh-fish），把 JSON / JSONL 解析成小结构。
 * 全部只读：文件缺失、损坏、字段改名都当「那边没有」处理，绝不影响陪伴层本身。
 */
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const MAX_TAIL = 1024 * 1024

export function fishRoot(env) {
  const e = env || process.env
  if (e && e.DSH_FISH_HOME) return String(e.DSH_FISH_HOME)
  return join(homedir(), '.dsh-fish')
}

export function fishPath(name, env) {
  return join(fishRoot(env), name)
}

/** 读文件尾部：events.jsonl 只增不减，别整份灌进内存。 */
function readTail(path, maxBytes) {
  let fd = null
  try {
    fd = openSync(path, 'r')
    const size = statSync(path).size
    const want = Math.max(0, Math.min(size, maxBytes || MAX_TAIL))
    const buf = Buffer.alloc(want)
    if (want > 0) readSync(fd, buf, 0, want, size - want)
    return buf.toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd != null) { try { closeSync(fd) } catch {} }
  }
}

function readJson(path) {
  try {
    const raw = readFileSync(path, 'utf8')
    if (!raw || !raw.trim()) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** 便签/预约有可能是数组，也可能包一层：两种都认。 */
function asList(raw, keys) {
  if (Array.isArray(raw)) return raw
  if (!raw || typeof raw !== 'object') return []
  for (const k of keys) if (Array.isArray(raw[k])) return raw[k]
  return []
}

/** 成长事件（events.jsonl）：返回最近的 limit 条，时间由旧到新。 */
export function events({ limit = 200, env } = {}) {
  const text = readTail(fishPath('events.jsonl', env))
  if (!text) return []
  const out = []
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (!s) continue
    let ev = null
    try { ev = JSON.parse(s) } catch { continue }
    if (!ev || typeof ev !== 'object' || !ev.id) continue
    if (String(ev.type || '') === 'meta') continue
    out.push({
      id: String(ev.id),
      ts: String(ev.ts || ''),
      type: String(ev.type || ''),
      text: String(ev.text || ''),
      refs: Array.isArray(ev.refs) ? ev.refs.map(String) : [],
      verdict: ev.verdict == null ? null : String(ev.verdict),
      confidence: Number(ev.confidence || 0),
      flags: Array.isArray(ev.flags) ? ev.flags.map(String) : [],
    })
  }
  return limit > 0 ? out.slice(-limit) : out
}

export function home({ env } = {}) {
  const raw = readJson(fishPath('home.json', env))
  if (!raw || typeof raw !== 'object') return null
  return {
    title: String(raw.title || ''),
    turns: Number(raw.turns || 0),
    hearAt: Number(raw.hearAt || 0),
    sessionId: raw.sessionId ? String(raw.sessionId) : '',
    createdAt: raw.createdAt ? String(raw.createdAt) : '',
  }
}

/** 最近几轮她跟主人说过的话（talk-recent.json 按场景分桶）。 */
export function recentTalk({ limit = 4, env } = {}) {
  const raw = readJson(fishPath('talk-recent.json', env))
  if (!raw || typeof raw !== 'object') return []
  const buckets = raw.buckets && typeof raw.buckets === 'object'
    ? raw.buckets
    : (Array.isArray(raw.items) ? { home: raw.items } : {})
  const out = []
  for (const [name, list] of Object.entries(buckets)) {
    if (!Array.isArray(list)) continue
    for (const it of list) {
      if (!it || typeof it !== 'object') continue
      const her = String(it.her || '').trim()
      if (!her) continue
      out.push({ at: String(it.at || ''), me: String(it.me || '').trim(), her, bucket: name })
    }
  }
  out.sort((x, y) => String(x.at).localeCompare(String(y.at)))
  return limit > 0 ? out.slice(-limit) : out
}

function normalizeNote(it) {
  if (!it || typeof it !== 'object') return null
  const text = String(it.text || '').trim()
  if (!text) return null
  return {
    id: String(it.id || ''),
    text,
    due: String(it.due || ''),
    created: String(it.created || ''),
    status: String(it.status || 'open'),
    reason: String(it.reason || ''),
  }
}

/** 还没划掉的便签。 */
export function notes({ env } = {}) {
  const raw = readJson(fishPath('notes.json', env))
  return asList(raw, ['notes', 'items', 'list'])
    .map(normalizeNote)
    .filter((n) => n && n.status === 'open')
}

function normalizeAppt(it) {
  if (!it || typeof it !== 'object') return null
  const what = String(it.what || '').trim()
  if (!what) return null
  return {
    id: String(it.id || ''),
    what,
    due: String(it.due || ''),
    created: String(it.created || ''),
    status: String(it.status || 'open'),
    outcome: String(it.outcome || ''),
    reason: String(it.reason || ''),
  }
}

/** 还没了结的预约。 */
export function appts({ env } = {}) {
  const raw = readJson(fishPath('appointments.json', env))
  return asList(raw, ['appointments', 'items', 'list'])
    .map(normalizeAppt)
    .filter((a) => a && (a.status === 'open' || a.status === 'notified'))
}
