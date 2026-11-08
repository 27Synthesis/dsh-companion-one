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

export function setSetting(db, key, value) {
  if (key === 'style') { setStyleEnabled(db, !!value); return settingsSnapshot(db) }
  if (key === 'personaFrozen') { setFrozen(db, !!value); return settingsSnapshot(db) }
  if (key === 'packScene') { kvSet(db, 'cfg:packScene', String(value || '').trim().slice(0, 40)); return settingsSnapshot(db) }
  if (!['memory', 'compression', 'companion', 'persona', 'voicePack'].includes(key)) throw new Error('unknown setting: ' + key)
  kvSet(db, 'cfg:' + key, !!value)
  return settingsSnapshot(db)
}

export function overview(db, session) {
  // 面板从地址栏拿到的是会话 id，不是 Session 对象：包一层让它走同一条 resolveScope
  const sess = typeof session === 'string' ? { id: session } : session
  const scope = resolveScope(sess, null, { db })
  const layers = {}
  for (const layer of LAYERS) {
    const rows = dbList(db, layer, { scope, limit: 500, includeArchived: false })
    layers[layer] = { label: LAYER_LABELS[layer], total: rows.length, active: rows.filter((r) => !r.invalid_at).length }
  }
  return {
    settings: settingsSnapshot(db),
    scope,
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
    heartVoice: latestHeartVoice(db, sess?.id || null),
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
      return { layer, rows: dbList(db, layer, { scope: a.scope || null, limit: a.limit || 200, includeArchived: !!a.archived, includeInvalid: true }) }
    }
    case 'memorySearch': {
      return { hits: searchMemory(db, a.query, { scope: a.scope || null, limit: a.limit || 20, includeInvalid: true }) }
    }
    case 'memoryAdd': {
      const res = remember(db, a.layer || 'fact', { content: a.content, scope: a.scope || 'global', source: 'panel' })
      return res
    }
    case 'memoryUpdate': {
      const row = dbUpdate(db, a.layer, a.id, {
        content: a.content,
        keywords: a.keywords !== undefined ? a.keywords : undefined,
        archived: a.archived === undefined ? undefined : (a.archived ? 1 : 0),
        invalid_at: a.invalid_at === undefined ? undefined : a.invalid_at,
        valid_until: a.valid_until === undefined ? undefined : a.valid_until,
      })
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
    case 'decompress': return decompressBlock(db, { ref: a.ref, offset: a.offset || 0, maxChars: a.maxChars || 6000 })
    case 'searchContext': return searchContext(db, { query: a.query, limit: a.limit || 10 })
    case 'acpStatus': return acpStatus({ db, session: a.session || null, windowTokens: a.windowTokens || 128000, sessionId: a.sessionId })

    case 'followups': return { rows: listFollowUps(db, a.scope || null, { limit: a.limit || 100, status: a.status }) }
    case 'followupAdd': {
      const id = addFollowUp(db, { scope: a.scope || 'global', content: a.content, dueAt: a.dueAt || null, size: a.size || 'small', source: 'panel' })
      return { ok: true, id }
    }
    case 'followupDone': return { ok: true, row: setFollowUpStatus(db, a.id, 'done') }
    case 'followupSilence': return { ok: true, row: setFollowUpStatus(db, a.id, 'silenced') }
    case 'followupAsk': return { ok: true, row: markAsked(db, a.id) }

    case 'style': return { enabled: styleEnabled(db), rows: listStyle(db), prompt: stylePrompt(db) }
    case 'styleToggle': return { enabled: setStyleEnabled(db, !!a.value) }
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
        prompt: null,
      }
    }
    case 'personaFreeze': { setFrozen(db, !!a.value); return { frozen: isFrozen(db) } }
    case 'personaPromote': return promoteNarrative(db, { summary: a.summary, values: a.values, rules: a.rules, taboos: a.taboos, source: { session: a.session, seq: a.seq } })
    case 'personaRollback': return rollbackNarrative(db, a.version)
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
