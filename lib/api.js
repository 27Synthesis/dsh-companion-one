/**
 * companion-one / lib/api.js — 面板与工具共用的唯一实现。
 * 客户端只通过 HTTP 路由调用这里；工具调用同一批函数（references/user-actions.md：
 * 一个操作两种调用者，不维护两套逻辑）。
 */
import { LAYERS, LAYER_LABELS, listMemory as dbList, getMemory as dbGet, updateMemory as dbUpdate, deleteMemory as dbDelete, kvGet, kvSet, kvDelete } from './db.js'
import { remember, searchMemory, extractKeywords, findDecayCandidates, applyDecay } from './memory.js'
import { listBlocks, blockByRef, decompressBlock, searchContext, acpStatus, estimateTokens } from './acp.js'
import { listFollowUps, addFollowUp, setFollowUpStatus, markAsked, readCrisis, clearCrisis, activeFacts, resolveScope } from './companion.js'
import { listStyle, setStyleEnabled, styleEnabled, deleteStyle, learnFromUserText, stylePrompt } from './style.js'
import { readValves, currentNarrative, listNarratives, promoteNarrative, rollbackNarrative, isFrozen, setFrozen, topChains, ensureNarrative, appraise } from './persona.js'
import { stats as ftStats, feedCorpus, startLearn, learnStatus, cancelLearn, packInfo } from './learn.js'
import { latestHeartVoice, listHeartVoices } from './mood.js'
import { scanOtherMemories, importOtherMemories } from './import.js'
import { collabStatus } from './collab.js'
import { storageReport, chatSessions, purgeChat, compactDb } from './storage.js'

export function settingsSnapshot(db) {
  return {
    memory: kvGet(db, 'cfg:memory', true) !== false,
    compression: kvGet(db, 'cfg:compression', true) !== false,
    companion: kvGet(db, 'cfg:companion', true) !== false,
    style: styleEnabled(db),
    persona: kvGet(db, 'cfg:persona', true) !== false,
    voicePack: kvGet(db, 'cfg:voicePack', true) !== false,
    packScene: String(kvGet(db, 'cfg:packScene', '') || ''),
    // 跨插件桥接（大肥鱼的便签/约/记忆）：只读，读不到就是没内容
    bridge: kvGet(db, 'cfg:bridge', true) !== false,
    personaFrozen: isFrozen(db),
  }
}

// 面板走 GET 时参数会变成字符串：'false' / '0' / '' 必须当成 false，不然关不掉开关
const asBool = (v) => (typeof v === 'string' ? !(v === '' || v === 'false' || v === '0' || v === 'null') : !!v)

export function setSetting(db, key, value) {
  if (key === 'style') { setStyleEnabled(db, asBool(value)); return settingsSnapshot(db) }
  if (key === 'personaFrozen') { setFrozen(db, asBool(value)); return settingsSnapshot(db) }
  if (key === 'packScene') { kvSet(db, 'cfg:packScene', String(value || '').trim().slice(0, 40)); return settingsSnapshot(db) }
  if (!['memory', 'compression', 'companion', 'persona', 'voicePack', 'bridge'].includes(key)) throw new Error('unknown setting: ' + key)
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

/** 面板参数是字符串：limit 取整并夹在 (0, max]，负数会让 SQLite 变成「不限制」。 */
function limitArg(v, def, max) {
  const n = Math.floor(Number(v))
  if (!Number.isFinite(n) || n <= 0) return def
  return Math.min(n, max)
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
      return { layer, rows: dbList(db, layer, { scope: a.scope || null, limit: limitArg(a.limit, 200, 1000), includeArchived: a.archived !== undefined ? asBool(a.archived) : false, includeInvalid: true }) }
    }
    case 'memorySearch': {
      return { hits: searchMemory(db, a.query, { scope: a.scope || null, limit: limitArg(a.limit, 20, 200), includeInvalid: true }) }
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
    case 'memoryCleanup': {
      // 工作类记忆的衰减清理：不带 apply 只算候选（面板先给预览），带 apply 才真的归档。
      // 只把 archived 置 1，不删行——用户翻得回来，改回 0 就恢复。
      const candidates = findDecayCandidates(db, { scope: a.scope || null })
      const apply = a.apply === true || a.apply === 'true' || a.apply === 1 || a.apply === '1'
      if (!apply) return { ok: true, dry: true, count: candidates.length, candidates }
      const done = applyDecay(db, candidates)
      return { ok: true, dry: false, archived: done.length, count: candidates.length, candidates }
    }

    case 'blocks': return { blocks: listBlocks(db, a.sessionId || null, limitArg(a.limit, 50, 500)) }
    case 'block': return { block: blockByRef(db, a.ref) }
    case 'decompress': return decompressBlock(db, { ref: a.ref, offset: a.offset || 0, maxChars: Math.min(Number(a.maxChars) || 6000, 12000) })
    case 'searchContext': return searchContext(db, { query: a.query, limit: limitArg(a.limit, 10, 100) })
    case 'acpStatus': return acpStatus({ db, session: a.session || null, windowTokens: a.windowTokens || 128000, sessionId: a.sessionId })

    case 'followups': return { rows: listFollowUps(db, a.scope || null, { limit: limitArg(a.limit, 100, 500), status: a.status }) }
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
      const sessId = String(a.sessionId == null ? '' : a.sessionId).trim()
      if (!sessId) throw new Error('sessionId required')
      // sessionId 会拼进 kv 主键：不限长就能一直灌新行
      if (sessId.length > 200) throw new Error('sessionId too long')
      const scopeVal = a.scope == null ? '' : String(a.scope).trim()
      if (scopeVal) {
        // scope 会进 SQL 参数、面板回显和注入快照：限长、去控制字符
        if (scopeVal.length > 200) throw new Error('scope too long')
        if (/[\u0000-\u001f\u007f]/.test(scopeVal)) throw new Error('bad scope')
        kvSet(db, 'scope:session:' + sessId, scopeVal)
      } else kvDelete(db, 'scope:session:' + sessId)
      return { ok: true, sessionId: sessId, scope: scopeVal || null }
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

    // 协作页：大肥鱼 / 鱼记忆装没装、多少东西、内嵌地址（只读，写操作在它们自己页面里）
    case 'collab': return collabStatus()

    case 'crisis': return { state: readCrisis(db, a.scope || 'global') }
    case 'crisisClear': { clearCrisis(db, a.scope || 'global'); return { ok: true } }
    case 'heartVoice': return { row: latestHeartVoice(db, a.sessionId || null) }
    case 'heartVoices': return { rows: listHeartVoices(db, a.sessionId || null, limitArg(a.limit, 20, 200)) }

    // 存储：占用多少、都占在哪（dbstat 页面级真实数字）
    case 'storage': return storageReport(db)
    case 'chatSessions': return chatSessions(db, { limit: limitArg(a.limit, 200, 1000) })
    // 像微信那样删聊天记录：按会话删或全清；只删归档副本，记忆/人格/风格/惦记不动
    case 'chatPurge': {
      const all = a.all === true || a.all === 'true' || a.all === 1 || a.all === '1'
      const heart = a.heart === true || a.heart === 'true' || a.heart === 1 || a.heart === '1'
      return purgeChat(db, { sessionId: a.sessionId, all, heart })
    }
    // 只整理文件不删数据（删完没 VACUUM 时，空间其实还没还给系统）
    case 'vacuum': return compactDb(db)

    case 'stats': {
      const t = kvGet(db, 'acp:tokens_saved_total', 0)
      return { tokensSaved: t, estimateNote: '累计节省为各次压缩报告值之和；tokens 为粗略估算（CJK≈1/字）' }
    }
    default: throw new Error('unknown op: ' + op)
  }
}

export { estimateTokens, extractKeywords }
