/**
 * companion-one / lib/fishmem.js — 读 fish-memory 的会话库（只读）。
 *
 * 那边的 storePath = <DSH_HOME>/fish-memory/<库名>.json：session 模式下库名就是会话 id，
 * workspace 模式下是同工作区共用一个 ws_*.json。这里只读不写 —— 没有库文件就是
 * 「她还没在这台机上记过事」，不新建、不改写，那边的 purgeEpoch 校验就永远不会被我们惹到。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

function baseDir(env) {
  const e = env || process.env
  return (e && e.DSH_HOME) ? String(e.DSH_HOME) : join(homedir(), '.dsh')
}

export function memDir(env) {
  return join(baseDir(env), 'fish-memory')
}

function cfgPath(env) {
  return join(baseDir(env), 'fish-memory-config.json')
}

/** 那边的模式：workspace 时同一工作区共用一个库。读不到就当按会话。 */
export function memMode(env) {
  try {
    const raw = readFileSync(cfgPath(env), 'utf8')
    const cfg = raw && raw.trim() ? JSON.parse(raw) : null
    return String((cfg && cfg.模式) || 'session') === 'workspace' ? 'workspace' : 'session'
  } catch {
    return 'session'
  }
}

const sanitize = (s) => String(s == null ? '' : s).replace(/[^a-zA-Z0-9_-]/g, '_')

export function storePath(sessionId, env) {
  return join(memDir(env), sanitize(sessionId) + '.json')
}

function loadStore(path) {
  try {
    const raw = readFileSync(path, 'utf8')
    if (!raw || !raw.trim()) return null
    const data = JSON.parse(raw)
    if (!data || typeof data !== 'object' || !Array.isArray(data.memories)) return null
    return data
  } catch {
    return null
  }
}

/**
 * 会话库里的记忆（新→旧）。deleted 里出现过的 id 一律不返回 ——
 * 那边删东西是「标 id + 留着合并」，我们照着它的意思当没这条。
 */
export function memoriesOf(sessionId, { env, limit = 0, storeFile = '' } = {}) {
  const path = storeFile ? join(memDir(env), storeFile) : storePath(sessionId, env)
  const data = loadStore(path)
  if (!data) return []
  const dead = new Set((Array.isArray(data.deleted) ? data.deleted : []).map((d) => String((d && d.id) || d)))
  const out = []
  for (const m of data.memories) {
    if (!m || typeof m !== 'object') continue
    const id = String(m.id || '')
    if (!id || dead.has(id)) continue
    const text = String(m.text || '').trim()
    if (!text) continue
    out.push({
      id,
      text,
      at: String(m.at || m.createdAt || ''),
      category: String(m.category || ''),
      importance: Number(m.importance || 0),
      tags: Array.isArray(m.tags) ? m.tags.map(String).slice(0, 6) : [],
      key: m.事实键 ? String(m.事实键) : '',
    })
  }
  out.sort((a, b) => String(b.at).localeCompare(String(a.at)))
  return limit > 0 ? out.slice(0, limit) : out
}

/** 目录里有哪些库（面板状态与排错用）。 */
export function stores(env) {
  try {
    return readdirSync(memDir(env))
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        let size = 0
        try { size = statSync(join(memDir(env), f)).size } catch {}
        return { file: f, size }
      })
  } catch {
    return []
  }
}
