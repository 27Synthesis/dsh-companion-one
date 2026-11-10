/**
 * companion-one / lib/api.js — 面板与工具共用的唯一实现。
 * 客户端只通过 HTTP 路由调用这里；工具调用同一批函数（references/user-actions.md：
 * 一个操作两种调用者，不维护两套逻辑）。
 */
import { LAYERS, LAYER_LABELS, listMemory as dbList, getMemory as dbGet, updateMemory as dbUpdate, deleteMemory as dbDelete, kvGet, kvSet, kvDelete } from './db.js'
import { remember, searchMemory, extractKeywords } from './memory.js'
import { listBlocks, blockByRef, decompressBlock, searchContext, acpStatus, estimateTokens } from './acp.js'
import { listFollowUps, addFollowUp, setFollowUpStatus, markAsked, readCrisis, clearCrisis, activeFacts, resolveScope } from './companion.js'
import { listStyle, setStyleEnabled, styleEnabled, deleteStyle, learnFromUserText, stylePrompt } from './style.js'
import { readValves, currentNarrative, listNarratives, promoteNarrative, rollbackNarrative, isFrozen, setFrozen, topChains, ensureNarrative, appraise } from './persona.js'
import { stats as ftStats, feedCorpus, startLearn, learnStatus, cancelLearn, packInfo } from './learn.js'
import { latestHeartVoice, listHeartVoices } from './mood.js'
import { scanOtherMemories, importOtherMemories } from './import.js'

export function settingsSnapshot(db) {
  return {
    memory: kvGet(db, 'cfg:memory', true) !== false,
    compression: kvGet(db, 'cfg:compression', true) !== false,
    companion: kvGet(db, 'cfg:companion', true) !== false,
    style: styleEnabled(db),
    persona: kvGet(db, 'cfg:persona', true) !== false,
    voicePack: kvGet(db, 'cfg:voicePack', true) !== false,
    packScene: String(kvGet(db, 'cfg:packScene', '') || ''),
    personaFrozen: isFrozen(db),
  }
}

// 面板走 GET 时参数会变成字符串：'false' / '0' / '' 必须当成 false，不然关不掉开关
const asBool = (v) => (typeof v === 'string' ? !(v === '' || v === 'false' || v === '0' || v === 'null') : !!v)

export function setSetting(db, key, value) {
  if (key === 'style') { setStyleEnabled(db, asBool(value)); return settingsSnapshot(db) }
  if (key === 'personaFrozen') { setFrozen(db, asBool(value)); return settingsSnapshot(db) }
  if (key === 'packScene') { kvSet(db, 'cfg:packScene', String(value || '').trim().slice(0, 40)); return settingsSnapshot(db) }
  if (!['memory', 'compression', 'companion', 'persona', 'voicePack'].includes(key)) throw new Error('unknown setting: ' + key)
  kvSet(db, 'cfg:' + key, asBool(value))
  return settingsSnapshot(db)
}

export function overview(db, session) {
  // 面板从地址栏拿到的是会话 id，不是 Session 对象：包一层让它走同一条 resolveScope
  const sess = typeof session === 'string' ? { id: session } : session
  const scope = resolveScope(sess, null, { db })
  // 会话即时状态（此刻心情 / 主人此刻 / 压力）：dsh-go 侧边栏早就在读这张表，
  // 网页面板之前没显示，才会让人觉得「心情一直不动」。
  let sessionState = null
  try {
    let row = null
    let recent = false
    if (sess && sess.id) {
      row = db.prepare('select * from session_state where session_id = ?').get(sess.id)
    }
    // 手机 App 里这个面板挂在「设置」下，地址栏没有 #/session/<id>，拿不到会话 id；
    // 之前就因此整卡空白（主人以为心情功能坏了）。这里退回最近一轮真实对话的状态。
    if (!row) {
      row = db.prepare("select * from session_state where mood is not null and mood <> '' order by updated_at desc limit 1").get()
      recent = !!row
    }
    if (row) {
      sessionState = {
        recent,
        sessionId: row.session_id,
        mood: row.mood || '',
        moodWhy: row.mood_why || '',
        need: row.mood_need || '',
        userState: row.user_state || '',
        valence: Number(row.user_valence || 0),
        energy: Number(row.user_energy || 0),
        pressure: Number(row.pressure || 0),
        userMsgs: Number(row.user_msgs || 0),
        lastUser: row.last_user || '',
        updatedAt: row.updated_at || null,
      }
    }
  } catch {}
  const layers = {}
  for (const layer of LAYERS) {
    const rows = dbList(db, layer, { scope, limit: 500, includeArchived: false })
    layers[layer] = { label: LAYER_LABELS[layer], total: rows.length, active: rows.filter((r) => !r.invalid_at).length }
  }
  return {
    settings: settingsSnapshot(db),
    scope,
    sessionState,
    layers,
    factsActive: activeFacts(db, scope, 50).length,
    blocks: listBlocks(db, null, 10).map((b) => ({ ref: b.id, tier: b.tier, saved: b.tokens_saved, messages: b.message_count, at: b.created_at, status: b.status })),
    tokensSaved: Number(kvGet(db, 'acp:tokens_saved_total', 0)),
    style: listStyle(db),
    styleEnabled: styleEnabled(db),
    valves: readValves(db),
    narrative: currentNarrative(db),
    narrativeCount: listNarratives(db, 50).length,
    chains: topChains(db, 8),
    followUps: listFollowUps(db, scope, { limit: 50 }),
    crisis: readCrisis(db, scope),
    heartVoice: latestHeartVoice(db, sess?.id || null) || (() => {
      try { const rows = listHeartVoices(db, null, 1); return rows[0] || null } catch { return null }
    })(),
    heartVoiceOfSession: !!(sess && sess.id && latestHeartVoice(db, sess.id)),
  }
}

/** 统一入口：所有面板操作按 op 分发。 */
export function runOp(db, op, args, runtime) {
  const a = args || {}
  switch (op) {
    case 'debug': return runtime || { mounted: false }
    case 'overview': return overview(db, a.session || null)
    case 'settings': return settingsSnapshot(db)
    case 'setSetting': return setSetting(db, a.key, a.value)

    case 'memories': {
      const layer = a.layer
      if (!LAYERS.includes(layer)) throw new Error('bad layer')
      return { layer, rows: dbList(db, layer, { scope: a.scope || null, limit: Number(a.limit) || 200, includeArchived: a.archived !== undefined ? asBool(a.archived) : false, includeInvalid: true }) }
    }
    case 'memorySearch': {
      return { hits: searchMemory(db, a.query, { scope: a.scope || null, limit: a.limit || 20, includeInvalid: true }) }
    }
    case 'memoryAdd': {
      const res = remember(db, a.layer || 'fact', { content: a.content, scope: a.scope || 'global', source: 'panel' })
      return res
    }
    case 'memoryUpdate': {
      // 只把「真的传了」的字段拼进 patch：undefined 绑不进 SQLite 参数，
      // 之前点「归档」会报 Provided value cannot be bound to SQLite parameter 1。
      const patch = {}
      if (a.content !== undefined) patch.content = a.content
      if (a.keywords !== undefined) patch.keywords = a.keywords
      if (a.archived !== undefined) patch.archived = asBool(a.archived) ? 1 : 0
      if (a.pinned !== undefined) patch.pinned = asBool(a.pinned) ? 1 : 0
      if (a.invalid_at !== undefined) patch.invalid_at = a.invalid_at
      if (a.valid_until !== undefined) patch.valid_until = a.valid_until
      const row = dbUpdate(db, a.layer, a.id, patch)
      return { ok: !!row, row }
    }
    case 'memoryDelete': { dbDelete(db, a.layer, a.id); return { ok: true } }
    case 'memoryImportScan': return scanOtherMemories()
    case 'memoryImportRun': return importOtherMemories(db, { sourceId: a.sourceId, scope: a.scope, limit: a.limit, layer: a.layer })
    case 'memoryInvalidate': {
      const row = dbUpdate(db, a.layer, a.id, { invalid_at: Date.now(), invalid_reason: a.reason || 'manual' })
      return { ok: !!row, row }
    }

    case 'blocks': return { blocks: listBlocks(db, a.sessionId || null, a.limit || 50) }
    case 'block': return { block: blockByRef(db, a.ref) }
    case 'decompress': return decompressBlock(db, { ref: a.ref, offset: a.offset || 0, maxChars: Math.min(Number(a.maxChars) || 6000, 12000) })
    case 'searchContext': return searchContext(db, { query: a.query, limit: a.limit || 10 })
    case 'acpStatus': return acpStatus({ db, session: a.session || null, windowTokens: a.windowTokens || 128000, sessionId: a.sessionId })

    case 'followups': return { rows: listFollowUps(db, a.scope || null, { limit: Number(a.limit) || 100, status: a.status }) }
    case 'followupAdd': {
      const content = String(a.content || '').trim()
      if (!content) return { ok: false, reason: 'content_required' }
      const id = addFollowUp(db, { scope: a.scope || 'global', content, dueAt: a.dueAt || null, size: a.size || 'small', source: 'panel' })
      return { ok: true, id }
    }
    case 'followupDone': return { ok: true, row: setFollowUpStatus(db, a.id, 'done') }
    case 'followupSilence': return { ok: true, row: setFollowUpStatus(db, a.id, 'silenced') }
    case 'followupAsk': return { ok: true, row: markAsked(db, a.id) }

    case 'style': return { enabled: styleEnabled(db), rows: listStyle(db), prompt: stylePrompt(db) }
    case 'styleToggle': { setStyleEnabled(db, asBool(a.value)); return { enabled: styleEnabled(db) } }
    case 'styleDelete': { deleteStyle(db, a.key); return { ok: true, rows: listStyle(db) } }
    case 'styleLearn': { learnFromUserText(db, a.text || ''); return { ok: true, rows: listStyle(db) } }

    case 'persona': {
      ensureNarrative(db)
      return {
        frozen: isFrozen(db),
        valves: readValves(db),
        narrative: currentNarrative(db),
        narratives: listNarratives(db, 20),
        chains: topChains(db, 12),
        last: kvGet(db, 'persona:last', null),
        prompt: null,
      }
    }
    case 'personaFreeze': { setFrozen(db, asBool(a.value)); return { frozen: isFrozen(db) } }
    case 'personaPromote': return promoteNarrative(db, { summary: a.summary, values: a.values, rules: a.rules, taboos: a.taboos, source: { session: a.session, seq: a.seq } })
    case 'personaRollback': return rollbackNarrative(db, a.version != null && a.version !== '' ? Number(a.version) : undefined)
    case 'personaAppraise': return appraise(a.text || '')

    case 'setScope': {
      // 把当前会话绑定到某个隔离键（面板「这是谁」用）；空值 = 解除绑定
      if (!a.sessionId) throw new Error('sessionId required')
      if (a.scope) kvSet(db, 'scope:session:' + a.sessionId, String(a.scope))
      else kvDelete(db, 'scope:session:' + a.sessionId)
      return { ok: true, sessionId: a.sessionId, scope: a.scope || null }
    }
    case 'ftStats': return ftStats()
    case 'ftPack': return packInfo({ scene: a.scene })
    case 'ftFeed': return feedCorpus(db, { lines: a.lines || a.text || '', where: a.where, source: a.source, scene: a.scene })
    case 'ftLearn': return startLearn(db, { site: a.site, target: a.target, limit: a.limit })
    case 'ftJob': return learnStatus(db)
    case 'ftCancel': return cancelLearn(db)

    case 'diag': {
      // 面板「明细」页：本轮注入了什么、失败计数、库多大
      let inject = a.sessionId ? kvGet(db, 'inject:last:' + a.sessionId, null) : null
      let usedSession = a.sessionId || ''
      if (!inject) {
        // 引擎里的 session.id 和网页地址里的 #/session/... 不一定一致：
        // 找不到本会话就回落到最近一次真实注入，面板才不是永远空白。
        try {
          const row = db.prepare("select key, value from kv where key like 'inject:last:%' order by updated_at desc limit 1").get()
          if (row) { inject = JSON.parse(row.value); usedSession = String(row.key).replace('inject:last:', '') }
        } catch {}
      }
      let dbSize = 0
      try {
        dbSize = Number(db.prepare('pragma page_count').get().page_count) * Number(db.prepare('pragma page_size').get().page_size)
      } catch {}
      const fails = Number(kvGet(db, 'diag:fail', 0)) || 0
      return {
        inject,
        usedSession,
        fails,
        note: kvGet(db, 'diag:note', null),
        last: kvGet(db, 'diag:last', null),
        dbSize,
        wal: (() => { try { return db.prepare('pragma journal_mode').get() } catch { return null } })(),
      }
    }

    case 'crisis': return { state: readCrisis(db, a.scope || 'global') }
    case 'crisisClear': { clearCrisis(db, a.scope || 'global'); return { ok: true } }
    case 'heartVoice': return { row: latestHeartVoice(db, a.sessionId || null) }
    case 'heartVoices': return { rows: listHeartVoices(db, a.sessionId || null, a.limit || 20) }

    case 'stats': {
      const t = kvGet(db, 'acp:tokens_saved_total', 0)
      return { tokensSaved: t, estimateNote: '累计节省为各次压缩报告值之和；tokens 为粗略估算（CJK≈1/字）' }
    }
    default: throw new Error('unknown op: ' + op)
  }
}

export { estimateTokens, extractKeywords }
