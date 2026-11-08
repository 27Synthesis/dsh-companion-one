/**
 * companion-one — 自包含陪伴单体插件（Host 半边）。
 *
 * 六个子系统全在本包内：压缩引擎（ACP 风格）、七层记忆、陪伴行为层、
 * 沟通风格学习、可塑人格、设置面板（Client 半边见 client.js）。
 * 不依赖任何外部插件；持久化只用 node:sqlite。
 *
 * 注入原则（references/practices.md）：
 * - system prompt 只注册一次静态导引，文本恒定，不破坏 KV 缓存；
 * - 动态记忆走 agent/pre-step 的独立 snapshot 消息，排在真实用户消息之前，
 *   不改写用户 prompt；
 * - 压缩通过 Session surface replace 实现，原始事件仍留在会话日志里。
 */
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { openDb, kvGet, kvSet, LAYERS } from './lib/db.js'
import { remember, searchMemory, listMemory, updateMemory, deleteMemory, getMemory, extractKeywords } from './lib/memory.js'
import { compressSession, decompressBlock, searchContext, acpStatus, listBlocks, estimateTokens } from './lib/acp.js'
import { firstTurnSnapshot, hitsPrompt, keywordHits, postCompactionSnapshot, pressureHint, clip } from './lib/inject.js'
import { resolveScope, classify, CRISIS_GUIDE, bumpCrisis, readCrisis, pickDueFollowUp, markAsked, followUpPrompt, addFollowUp, listFollowUps, setFollowUpStatus, expireStale } from './lib/companion.js'
import { stylePrompt, learnFromUserText, styleEnabled, listStyle, setStyleEnabled, deleteStyle } from './lib/style.js'
import { appraise, valvePrompt, endOfTurn, readValves, currentNarrative, listNarratives, promoteNarrative, rollbackNarrative, isFrozen, setFrozen, topChains, ensureNarrative } from './lib/persona.js'
import { userState, personaReaction, addHeartVoice, latestHeartVoice, fallbackHeartVoice } from './lib/mood.js'
import { expressionStage, checkText, violationHint } from './lib/persona.js'
import { runOp, settingsSnapshot, setSetting } from './lib/api.js'

export const name = 'companion-one'
export const inject = ['tools', 'systemPrompt', 'webServer']

const ROUTE = '/companion-one/api'
const STATIC_GUIDE = [
  'companion-one 陪伴层（静态导引，恒定文本）：',
  '- 长期记忆在 SQLite 七层里（soul/user/project/fact/lesson/topic/rules）。需要旧事时用 memory_search；',
  '  值得长期记住的新事实（住址、工作、偏好、约定、教训）用 memory_add 落库，宁可少记也别记错。',
  '- 上下文压力大时用 acp_status 看可压缩范围，再用 compress 提交忠实摘要（保留最近三条对话）。',
  '  被折叠的历史仍可用 search_context / decompress 取回，不用担心丢。',
  '- 主动关心用 followup 记录「惦记的事」，到期后系统会提醒你自然地问一句。',
  '- 每轮回复后调用 heart_voice 写一句心声：第一人称 20–60 字，写你此刻真实的反应和刚才回复时的想法；',
  '  心声只给自己看、不反哺人格，别复述用户原话，也别写成总结或待办。',
].join('\n')

function dbPath(config) {
  if (config && config.dbPath) return String(config.dbPath)
  const dir = process.env.DSH_PROFILE_DIR || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'companion-one')
  return join(dir, 'companion-one.db')
}

/* ---------------- 工具定义（裸对象，不 import dsh-tools） ---------------- */
const P = (props, required) => ({ type: 'object', properties: props, required: required || [], additionalProperties: false })
function tool(spec) {
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' } }, additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : String(value && value.text != null ? value.text : JSON.stringify(value)) }],
    },
    execute: async (args, exec) => {
      const r = await spec.execute(args || {}, exec || {})
      return typeof r === 'string' ? { text: r } : { text: JSON.stringify(r) }
    },
  }
}

function sessionOf(exec, ctx) {
  return exec?.agent?.session || ctx?.agents?.currentInitiator?.()?.session || null
}

export function apply(ctx, config) {
  const cfg = config || {}
  const db = openDb(dbPath(cfg))
  try { ensureNarrative(db) } catch {}
  // 过期事实（valid_until 到点）启动时立刻失效，之后每 10 分钟扫一次
  try { expireStale(db) } catch {}
  ctx.effect(() => {
    const timer = setInterval(() => { try { expireStale(db) } catch {} }, 10 * 60 * 1000)
    if (timer.unref) timer.unref()
    return () => clearInterval(timer)
  }, 'companion-one:expire')
  const state = new Map()          // sessionId -> per-session state
  let lastCrisisNote = null

  ctx.effect(() => () => { try { db.close() } catch {} }, 'companion-one:db')

  // 静态导引：只注册一次，文本恒定（缓存友好）
  if (cfg.memory !== false && ctx.systemPrompt && typeof ctx.systemPrompt.section === 'function') {
    try {
      ctx.effect(() => ctx.systemPrompt.section({ name: 'companion-one:guide', order: 50, text: STATIC_GUIDE }), 'companion-one:section')
    } catch (err) { log(ctx, 'prompt section failed', err) }
  }

  const scopeOf = (session, explicit) => resolveScope(session, explicit, { db, defaultScope: cfg.defaultScope })

  const st = (session) => {
    const id = (session && session.id) || 'unknown'
    let s = state.get(id)
    if (!s) {
      s = { userMsgs: 0, lastUser: '', lastMsgId: '', lastAssistant: '', postCompact: false, written: [], projects: [], lastPressureHint: 0, moodPrev: null, mood: null, heartWritten: false, voiceHint: '' }
      state.set(id, s)
      // 长跑引擎里会话会越攒越多：只留最近 200 个会话的瞬时状态（DB 里的记忆不受影响）
      if (state.size > 200) {
        const oldest = state.keys().next().value
        if (oldest !== undefined) state.delete(oldest)
      }
    }
    return s
  }

  // 会话即时状态：心情由两步得出——① userState 读用户这句话 + 上一轮情绪余温；
  // ② personaReaction 用当前人格（叙事 + 阀门）决定「我看到主人这样，会是什么心情」。
  const saveSessionState = (session, scope, s, userText, pressure) => {
    if (!session) return
    if (userText) {
      const crisis = readCrisis(db, scope)
      const fresh = Date.now() - Number(crisis.at || 0) < 3 * 86400000
      const us = userState(userText, { prev: s.moodPrev, crisisLevel: fresh ? crisis.level : 0 })
      const pr = personaReaction({ state: us, narrative: currentNarrative(db), valves: readValves(db) })
      s.moodPrev = { valence: us.valence, need: us.need, at: Date.now() }
      s.mood = { ...pr, user: us }
      try {
        db.prepare('insert into session_state (session_id, scope, mood, mood_level, mood_why, mood_need, user_state, user_valence, user_energy, pressure, user_msgs, last_user, updated_at)' +
          ' values (?,?,?,?,?,?,?,?,?,?,?,?,?)' +
          ' on conflict(session_id) do update set scope=excluded.scope, mood=excluded.mood, mood_level=excluded.mood_level,' +
          ' mood_why=excluded.mood_why, mood_need=excluded.mood_need, user_state=excluded.user_state,' +
          ' user_valence=excluded.user_valence, user_energy=excluded.user_energy, pressure=excluded.pressure,' +
          ' user_msgs=excluded.user_msgs, last_user=excluded.last_user, updated_at=excluded.updated_at')
          .run(session.id, scope, pr.mood, us.crisis, pr.why, us.need, us.label, us.valence, us.energy, pressure, s.userMsgs, String(userText).slice(0, 120), Date.now())
      } catch (err) { log(ctx, 'session state write failed', err) }
    } else {
      try {
        db.prepare('insert into session_state (session_id, scope, pressure, user_msgs, updated_at) values (?,?,?,?,?)' +
          ' on conflict(session_id) do update set scope=excluded.scope, pressure=excluded.pressure,' +
          ' user_msgs=excluded.user_msgs, updated_at=excluded.updated_at')
          .run(session.id, scope, pressure, s.userMsgs, Date.now())
      } catch {}
    }
  }

  /* ---------- 会话事件：检测压缩换代 / 记录助手回复 ---------- */
  ctx.on('session/event', (session, event) => {
    const s = st(session)
    if (event.type === 'user/message') {
      const op = event.surfaceOp
      // 任何提供方做的折叠（包括 billion-context）都要触发记忆重注入
      if (op && typeof op === 'object' && op.op === 'replace') s.postCompact = true
    } else if (event.type === 'compaction/end') {
      s.postCompact = true
    } else if (event.type === 'assistant/message') {
      const c = event.data?.message?.content || []
      const text = c.filter((b) => b && b.type === 'text').map((b) => b.text).join(' ')
      if (text) s.lastAssistant = text.slice(0, 2000)
    } else if (event.type === 'turn/end') {
      finishTurn(session, event)
    }
  })

  /* ---------- 主注入点 ---------- */
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (!decision || decision.kind === 'reject') return decision
    if (payload.signal && payload.signal.aborted) return decision

    const session = payload.agent && payload.agent.session
    const s = st(session)
    const scope = scopeOf(session)
    // 同一条用户消息在一次 turn 的每一步都会被 pre-step 看到：只认第一次，
    // 否则 user_msgs 会按步翻倍，记忆命中/危机分级/风格学习/心情每步重复算一遍。
    const fresh = extractUserMessage(decision.messages)
    const realUser = !!fresh && fresh.id !== s.lastMsgId
    const userText = fresh ? fresh.text : ''
    if (realUser) { s.lastMsgId = fresh.id; s.userMsgs += 1; s.lastUser = userText }

    const parts = []
    const enabled = settingsSnapshot(db)

    // 1) 首轮记忆快照
    if (enabled.memory && realUser && s.userMsgs === 1) {
      const snap = firstTurnSnapshot(db, scope, cfg.firstTurnBudget || 300)
      if (snap) parts.push(snap)
    } else if (enabled.memory && realUser) {
      // 2) 每消息关键词命中 top-2
      const hits = keywordHits(db, userText, scope, 2)
      const text = hitsPrompt(hits, cfg.hitBudget || 120)
      if (text) parts.push(text)
    }

    // 2.5) 明确的「记住/记一下」指令 → 自动落库（模型经常忘了调 memory_add，这里兜底）
    if (enabled.memory && realUser) {
      const m = /(?:记住|记一下|记下来|帮我记一下?|别忘了)[：:，,\s]*([^\n。！？!?]{2,100})/.exec(userText)
      if (m && m[1].trim().length >= 2) {
        try {
          const res = remember(db, 'fact', { content: m[1].trim(), scope, source: 'auto:explicit' })
          if (!s.written.includes(res.id)) {
            s.written.push(res.id)
            if (s.written.length > 60) s.written = s.written.slice(-60)
          }
        } catch (err) { log(ctx, 'auto remember failed', err) }
      }
    }

    // 3) 压缩后重注入
    if (enabled.memory && s.postCompact) {
      s.postCompact = false
      parts.push(postCompactionSnapshot(db, { scope, projectIds: s.projects, writtenIds: s.written }, cfg.postCompactBudget || 300))
    }

    // 4) 危机分级 + 惦记的事
    if (enabled.companion && realUser) {
      const level = classify(userText)
      if (level.level >= 1) {
        const state2 = bumpCrisis(db, scope, level.level)
        if (level.level >= 4) {
          lastCrisisNote = { at: Date.now(), level: level.level, session: session?.id || null, excerpt: userText.slice(0, 120) }
          kvSet(db, 'crisis:last', lastCrisisNote)
          notify(ctx, '危机提示（等级 ' + level.level + '）', '当前对话出现高风险表达，请留意。')
        }
        if (state2.level >= 3 || level.level >= 3) parts.push(CRISIS_GUIDE[Math.max(level.level, 3)])
        else if (level.level >= 2) parts.push(CRISIS_GUIDE[level.level])
      } else {
        const prev = readCrisis(db, scope)
        if (prev.level >= 3 && Date.now() - (prev.at || 0) < 3 * 86400000) parts.push(CRISIS_GUIDE[prev.level])
      }
      if (realUser) {
        const due = pickDueFollowUp(db, scope, { userText })
        if (due) {
          parts.push(followUpPrompt(due))
          markAsked(db, due.id)
        }
      }
    }

    // 5) 风格卡片（一次性后处理提示）
    if (enabled.style && styleEnabled(db) && realUser) {
      learnFromUserText(db, userText)
      const sp = stylePrompt(db)
      if (sp) parts.push(clip(sp, 200))
    }

    // 6) 人格阀门（一次性调节，≤150 token）
    if (enabled.persona) {
      parts.push(clip(valvePrompt(db), 150))
    }

    // ⑥ ⑤区·语言—社会表达：生成前最后一次调音——人话优先，压掉鱼八股（fishtalk 底座）
    if (enabled.persona) {
      try {
        const expr = expressionStage(db, { publicScene: !!cfg.publicScene, pack: enabled.voicePack !== false, scene: enabled.packScene || '' })
        if (expr) parts.push(clip(expr, 200))
        if (s.voiceHint) { parts.push(clip(s.voiceHint, 60)); s.voiceHint = '' }
      } catch (err) { log(ctx, 'expression stage failed', err) }
    }

    // 7) 上下文压力：每步只算一次，压力提示与面板状态共用（原来这里算了两遍）
    let status = null
    if (session) {
      try { status = acpStatus({ db, session, windowTokens: cfg.windowTokens || 128000, sessionId: session.id }) } catch {}
    }
    if (enabled.compression && status) {
      const hint = pressureHint(status.pressure)
      if (hint && Date.now() - s.lastPressureHint > 60000) { parts.push(hint); s.lastPressureHint = Date.now() }
    }

    // 会话即时状态：给 dsh-go 侧边面板读（心情 / 压力 / 轮数）
    if (session) saveSessionState(session, scope, s, userText, status ? status.pressure : 0)

    const text = parts.filter(Boolean).join('\n\n')
    if (!text) return decision
    const message = {
      id: randomUUID(),
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'runtime-context', form: 'snapshot', sections: [{ name: 'companion-one', text }] },
    }
    return { ...decision, messages: [message, ...decision.messages] }
  })

  /* ---------- 一轮结束：人格与风格闭环（session/event 的 turn/end） ---------- */
  function finishTurn(session, event) {
    const enabled = settingsSnapshot(db)
    const s = st(session)
    const user = s.lastUser
    const said = s.lastAssistant
    // 先落状态再提前返回：没有可识别用户发言的轮次也要把标记清掉，
    // 否则 heartWritten 会带到下一轮、让下一轮误以为「已经写过心声」。
    s.heartWritten = false
    s.lastUser = ''
    s.lastAssistant = ''
    if (!user) return
    const weight = appraise(user)
    const outcome = classify(user).level >= 2 ? 'negative' : 'positive'
    if (enabled.persona) {
      try {
        // 人格只由用户发言驱动；心声（heart_voice）不进入这里
        endOfTurn(db, {
          sessionId: session?.id,
          seq: event?.seq,
          userText: user,
          weight: weight.weight,
          outcome,
        })
      } catch (err) { log(ctx, 'persona update failed', err) }
    }
    // 心声兜底：模型没调用 heart_voice 时，用当前心情写一句模板，面板会标注「自动」。
    if (enabled.companion !== false && !s.heartWritten) {
      try {
        const reaction = s.mood || { mood: '安心' }
        addHeartVoice(db, {
          sessionId: session?.id,
          scope: scopeOf(session),
          content: fallbackHeartVoice(reaction),
          mood: reaction.mood,
          source: 'auto',
          userText: user,
          seq: event?.seq,
        })
      } catch (err) { log(ctx, 'heart voice fallback failed', err) }
    }
    // ⑤区自检：上一轮如果冒出鱼八股/AI 腔，下一轮开头给一句纠偏（不惩罚、不重复）
    if (enabled.persona && said) {
      try {
        const rep = checkText(said)
        if (rep.fish) s.voiceHint = violationHint(rep)
      } catch (err) { log(ctx, 'fish check failed', err) }
    }
  }

  /* ---------- 工具 ---------- */
  const runtime = { mounted: true, tools: [], aliases: {}, sections: ['companion-one:guide'], dbPath: dbPath(cfg) }
  ctx.inject(['tools'], (tctx) => {
    // 同名工具探测：宿主或别的插件可能已经占了 compress / memory_* 这类名字
    // （典型是同装的 billion-context —— 它提供压缩四件套 + acp_cache）。
    // 策略：压缩四件套一旦被占用就整体让位（别人的 ACP 继续工作，我们只做记忆/陪伴/人格），
    //       其它工具被占用则加 co_ 前缀；注册抛 "already registered" 时同样兜底，绝不让插件炸掉。
    const taken = (name) => {
      try { return tctx.tools.get(name) !== undefined } catch { return false }
    }
    const ACP_TOOLS = ['compress', 'decompress', 'search_context', 'acp_status']
    const acpOwner = [...ACP_TOOLS, 'acp_cache'].find((n) => taken(n)) || null
    runtime.acpOwner = acpOwner
    if (acpOwner && cfg.compression !== 'force') {
      runtime.skipped = [...ACP_TOOLS]
      log(ctx, 'compression tools yielded to existing ACP provider (' + acpOwner + ')')
    }
    const reg = (spec) => {
      if (runtime.skipped && runtime.skipped.includes(spec.name) && cfg.compression !== 'force') return
      const conflict = 'already registered'
      let name = taken(spec.name) ? 'co_' + spec.name : spec.name
      try {
        tctx.tools.register(tool({ ...spec, name }))
      } catch (err) {
        if (!String(err && err.message || err).includes(conflict)) throw err
        if (name === spec.name) {
          name = 'co_' + spec.name
          try { tctx.tools.register(tool({ ...spec, name })) } catch (err2) {
            log(ctx, 'tool ' + spec.name + ' skipped', err2)
            return
          }
        } else { log(ctx, 'tool ' + spec.name + ' skipped', err); return }
      }
      if (name !== spec.name) runtime.aliases[spec.name] = name
      runtime.tools.push(name)
    }

    reg({
      name: 'memory_add',
      description: '把值得长期记住的一条信息写进七层记忆。layer: soul/user/project/fact/lesson/topic/rules。同层语义相近会自动合并；fact 层同一事实键的新值会让旧值失效（可回溯）。',
      parameters: P({
        layer: { type: 'string', enum: LAYERS },
        content: { type: 'string' },
        scope: { type: 'string', description: '隔离键，省略=当前对话对象' },
        keywords: { type: 'string', description: '命中关键词，省略自动提取' },
        valid_until: { type: 'number', description: '有效期时间戳（毫秒），省略=长期有效' },
      }, ['layer', 'content']),
      execute: async (args, exec) => {
        const session = sessionOf(exec, ctx)
        const scope = scopeOf(session, args.scope)
        const res = remember(db, args.layer, { content: args.content, scope, keywords: args.keywords, valid_until: args.valid_until, source: session?.id })
        const s = st(session)
        if (!s.written.includes(res.id)) s.written.push(res.id)
        if (args.layer === 'project' && !s.projects.includes(res.id)) s.projects.push(res.id)
        return { ok: true, id: res.id, merged: res.merged, superseded: res.superseded, scope }
      },
    })

    reg({
      name: 'memory_search',
      description: '在七层记忆里检索（FTS5 BM25 + 关键词兜底）。默认只搜当前对话对象可见的条目。',
      parameters: P({
        query: { type: 'string' },
        layers: { type: 'array', items: { type: 'string', enum: LAYERS } },
        scope: { type: 'string' },
        limit: { type: 'number' },
      }, ['query']),
      execute: async (args, exec) => {
        const session = sessionOf(exec, ctx)
        const scope = scopeOf(session, args.scope)
        const rows = searchMemory(db, args.query, { layers: args.layers, scope, limit: args.limit || 6 })
        return { count: rows.length, rows: rows.map((r) => ({ id: r.id, layer: r.layer, content: r.content, score: r.score, invalid: !!r.invalid_at })) }
      },
    })

    reg({
      name: 'memory_update',
      description: '修改/归档/失效一条记忆。archive=true 归档（不再注入但保留）；invalidate=true 标记失效（可回溯）。',
      parameters: P({
        layer: { type: 'string', enum: LAYERS },
        id: { type: 'string' },
        content: { type: 'string' },
        keywords: { type: 'string' },
        archive: { type: 'boolean' },
        invalidate: { type: 'boolean' },
      }, ['layer', 'id']),
      execute: async (args) => {
        const patch = {}
        if (args.content !== undefined) patch.content = args.content
        if (args.keywords !== undefined) patch.keywords = args.keywords
        if (args.archive !== undefined) patch.archived = args.archive ? 1 : 0
        if (args.invalidate) { patch.invalid_at = Date.now(); patch.invalid_reason = 'manual' }
        const row = updateMemory(db, args.layer, args.id, patch)
        return { ok: !!row, row }
      },
    })

    reg({
      name: 'memory_list',
      description: '列出某一层记忆（默认不含归档）。',
      parameters: P({
        layer: { type: 'string', enum: LAYERS },
        scope: { type: 'string' },
        includeArchived: { type: 'boolean' },
        limit: { type: 'number' },
      }, ['layer']),
      execute: async (args, exec) => {
        const session = sessionOf(exec, ctx)
        const rows = listMemory(db, args.layer, { scope: scopeOf(session, args.scope), includeArchived: !!args.includeArchived, limit: args.limit || 50 })
        return { count: rows.length, rows }
      },
    })

    reg({
      name: 'memory_forget',
      description: '彻底删除一条记忆（不可恢复）。一般用 memory_update 归档或失效即可。',
      parameters: P({ layer: { type: 'string', enum: LAYERS }, id: { type: 'string' } }, ['layer', 'id']),
      execute: async (args) => { deleteMemory(db, args.layer, args.id); return { ok: true } },
    })

    reg({
      name: 'compress',
      description: '把较早的对话折叠成一条忠实摘要（保留最近至少三条）。摘要必须明显短于原文，只接受节省 token 的摘要。被折叠的原文完整归档，可用 decompress / search_context 取回。',
      parameters: P({
        summary: { type: 'string', description: '你自己写的忠实摘要：保留事实、决定、未完成事项与用户偏好，不要编造' },
        keepTail: { type: 'number', description: '保留最近多少条消息原文，默认 8（最少 3）' },
        tier: { type: 'number', description: '折叠层级：1 原始摘要，2 摘要再摘要，3 会话总纲' },
      }, ['summary']),
      execute: async (args, exec) => {
        const session = sessionOf(exec, ctx)
        if (!session) return { ok: false, reason: 'no_session' }
        if (settingsSnapshot(db).compression === false) return { ok: false, reason: 'disabled', detail: '设置里关掉了压缩，面板可重新开启' }
        const res = compressSession({ db, session, summary: args.summary, keepTail: args.keepTail, tier: args.tier || 1, sessionId: session.id })
        if (res.ok) {
          const total = Number(kvGet(db, 'acp:tokens_saved_total', 0)) + res.tokensSaved
          kvSet(db, 'acp:tokens_saved_total', total)
          st(session).postCompact = true
        }
        return res
      },
    })

    reg({
      name: 'decompress',
      description: '按块引用（b1/b2…）取回被压缩的原文。分页返回：结果过大时 partial=true 并给出 nextOffset。',
      parameters: P({
        ref: { type: 'string' },
        offset: { type: 'number' },
        maxChars: { type: 'number' },
      }, ['ref']),
      execute: async (args) => decompressBlock(db, { ref: args.ref, offset: args.offset || 0, maxChars: Math.min(args.maxChars || 6000, 12000) }),
    })

    reg({
      name: 'search_context',
      description: '在压缩归档与摘要里做 BM25 检索（支持中文关键词命中），返回命中片段与所属块引用。',
      parameters: P({ query: { type: 'string' }, limit: { type: 'number' } }, ['query']),
      execute: async (args) => searchContext(db, { query: args.query, limit: args.limit || 5 }),
    })

    reg({
      name: 'acp_status',
      description: '查看压缩块、可压缩范围、上下文压力与分层摘要规则。',
      parameters: P({ windowTokens: { type: 'number' } }),
      execute: async (args, exec) => {
        const session = sessionOf(exec, ctx)
        return acpStatus({ db, session, windowTokens: args.windowTokens || cfg.windowTokens || 128000, sessionId: session?.id })
      },
    })

    reg({
      name: 'followup',
      description: '管理「惦记的事」：add 记录、list 查看、done 完成、silence 静默。到期后系统每天最多提醒一件，对方情绪不好时自动不提。',
      parameters: P({
        action: { type: 'string', enum: ['add', 'list', 'done', 'silence'] },
        content: { type: 'string' },
        dueAt: { type: 'number', description: '到期时间戳（毫秒）' },
        size: { type: 'string', enum: ['big', 'small'] },
        id: { type: 'string' },
      }, ['action']),
      execute: async (args, exec) => {
        const session = sessionOf(exec, ctx)
        const scope = scopeOf(session)
        if (args.action === 'add') return { ok: true, id: addFollowUp(db, { scope, content: args.content, dueAt: args.dueAt, size: args.size, source: session?.id }) }
        if (args.action === 'list') return { rows: listFollowUps(db, scope, { limit: 50 }) }
        if (args.action === 'done') return { ok: true, row: setFollowUpStatus(db, args.id, 'done') }
        return { ok: true, row: setFollowUpStatus(db, args.id, 'silenced') }
      },
    })

    reg({
      name: 'style_card',
      description: '查看/开关/删除沟通风格卡片（从用户原话学到的句长、直接度、emoji 频率等）。',
      parameters: P({
        action: { type: 'string', enum: ['view', 'toggle', 'delete'] },
        key: { type: 'string' },
        enabled: { type: 'boolean' },
      }, ['action']),
      execute: async (args) => {
        if (args.action === 'toggle') return { enabled: setStyleEnabled(db, !!args.enabled) }
        if (args.action === 'delete') { deleteStyle(db, args.key); return { rows: listStyle(db) } }
        return { enabled: styleEnabled(db), rows: listStyle(db), prompt: stylePrompt(db) }
      },
    })

    reg({
      name: 'persona',
      description: '可塑人格：status 查看叙事版本/三层轨迹/四个阀门；promote 提交新的自我叙事（会新增版本）；rollback 回滚；freeze 冻结（只读）。',
      parameters: P({
        action: { type: 'string', enum: ['status', 'promote', 'rollback', 'freeze'] },
        summary: { type: 'string' },
        rules: { type: 'array', items: { type: 'string' } },
        values: { type: 'array', items: { type: 'string' } },
        taboos: { type: 'array', items: { type: 'string' } },
        version: { type: 'number' },
        frozen: { type: 'boolean' },
      }, ['action']),
      execute: async (args, exec) => {
        const session = sessionOf(exec, ctx)
        if (args.action === 'promote') {
          return promoteNarrative(db, { summary: args.summary, rules: args.rules, values: args.values, taboos: args.taboos, source: { session: session?.id } })
        }
        if (args.action === 'rollback') return rollbackNarrative(db, args.version)
        if (args.action === 'freeze') { setFrozen(db, !!args.frozen); return { frozen: isFrozen(db) } }
        ensureNarrative(db)
        return { frozen: isFrozen(db), valves: readValves(db), narrative: currentNarrative(db), narratives: listNarratives(db, 10), chains: topChains(db, 8) }
      },
    })

    reg({
      name: 'heart_voice',
      description: '写完一轮回复后记一句「心声」：第一人称 20–60 字，写你看到主人这句话时真实的反应、以及刚才回复时的想法。只用于陪伴面板展示，不写回人格或记忆；每轮以最后一次为准。',
      parameters: P({
        content: { type: 'string', description: '第一人称心声，20–60 字；不要复述用户原话，不要写成总结或待办' },
        mood: { type: 'string', description: '可选：此刻心情词，省略则用系统算出的心情' },
        seq: { type: 'number' },
      }, ['content']),
      execute: async (args, exec) => {
        const session = sessionOf(exec, ctx)
        const s = st(session)
        const content = String(args.content || '').trim()
        if (!content) return { ok: false, reason: 'empty' }
        const reaction = s.mood || {}
        const row = addHeartVoice(db, {
          sessionId: session?.id,
          scope: scopeOf(session),
          content,
          mood: args.mood || reaction.mood,
          source: 'model',
          userText: s.lastUser,
          seq: args.seq,
        })
        s.heartWritten = true
        return { ok: true, id: row?.id, content: row?.content, mood: row?.mood }
      },
    })
  })

  /* ---------- 面板 API（HTTP 路由） ---------- */
  const web = ctx.webServer ?? (typeof ctx.get === 'function' ? ctx.get('webServer') : null)
  if (web && typeof web.register === 'function') {
    ctx.effect(() => web.register({
      kind: 'prefix',
      path: ROUTE,
      async handler(req, res) {
        const send = (code, obj) => {
          try {
            res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify(obj))
          } catch {}
        }
        // 写操作只收 POST：GET 可能是 <img>/<link> 或别的页面顺手带的请求，
        // 让它有机会删记忆、改设置、清危机状态太危险。
        const WRITE_OPS = new Set([
          'setSetting', 'memoryAdd', 'memoryUpdate', 'memoryDelete', 'memoryInvalidate', 'memoryImportRun',
          'followupAdd', 'followupDone', 'followupSilence', 'followupAsk',
          'styleToggle', 'styleDelete', 'styleLearn',
          'personaFreeze', 'personaPromote', 'personaRollback',
          'setScope', 'ftFeed', 'ftLearn', 'ftCancel', 'crisisClear',
        ])
        try {
          const url = new URL(req.url || '/', 'http://127.0.0.1')
          const op = url.searchParams.get('op') || 'overview'
          if (WRITE_OPS.has(op)) {
            if (req.method === 'GET') return send(405, { ok: false, error: 'method_not_allowed', hint: '写操作请用 POST' })
            // 跨站页面能用 text/plain 直接 POST 到 127.0.0.1（不受 CORS 限制），
            // 要求 application/json 会先触发预检，等于加了一道 CSRF 闸。
            const ct = String((req.headers && req.headers['content-type']) || '')
            if (!/application\/json/i.test(ct)) {
              return send(415, { ok: false, error: 'unsupported_media_type', hint: '写操作请用 application/json' })
            }
          }
          let body = {}
          if (req.method && req.method !== 'GET') {
            const chunks = []
            for await (const chunk of req) chunks.push(chunk)
            const raw = Buffer.concat(chunks).toString('utf8')
            body = raw ? JSON.parse(raw) : {}
          }
          const args = { ...Object.fromEntries(url.searchParams.entries()), ...body }
          send(200, { ok: true, data: runOp(db, op, args, runtime) })
        } catch (err) {
          send(200, { ok: false, error: String(err && err.message || err) })
        }
      },
    }), 'companion-one:api')
  }

  /* ---------- dsh-go 原生侧边面板（陪伴速览） ---------- */
  ctx.inject(['dshGo'], (goCtx) => {
    const go = goCtx.dshGo
    if (!go || typeof go.panel !== 'function') return

    const snapshotFor = (sessionId) => {
      let row = null
      try { row = sessionId ? db.prepare('select * from session_state where session_id = ?').get(sessionId) : null } catch {}
      const scope = row?.scope || 'global'
      const valves = readValves(db)
      const nar = currentNarrative(db)
      const crisis = readCrisis(db, scope)
      const heart = latestHeartVoice(db, sessionId)
      const open = listFollowUps(db, scope, { status: 'open', limit: 3 })
      let memCount = 0
      try {
        for (const layer of LAYERS) memCount += db.prepare('select count(*) c from memory_' + layer + ' where archived = 0 and invalid_at is null').get().c
      } catch {}
      let blocks = 0
      try { blocks = db.prepare('select count(*) c from compressed_blocks where status = \'committed\'').get().c } catch {}
      const pressure = Math.max(0, Math.min(100, Math.round(Number(row?.pressure || 0))))
      const mood = row?.mood || (crisis.level >= 3 ? '担心' : '安心')
      const moodWhy = row?.mood_why || (crisis.level >= 3 ? '主人之前说过那样的话，我还没完全放下心。' : '还没听到主人说话，我在旁边等着。')
      const userState = row?.user_state || (crisis.level >= 3 ? '需要被接住' : '还没开始')
      const safety = crisis.level >= 4 ? '谨慎期·高' : crisis.level >= 3 ? '谨慎期' : crisis.level === 2 ? '留意' : '平稳'
      const follow = open.length
        ? open.map((f) => (f.size === 'big' ? '· ' : '· ') + String(f.content).slice(0, 18)).join('  ')
        : '暂无'
      const heartLine = heart
        ? '心声（' + (heart.source === 'auto' ? '自动' : '模型') + ' · ' + new Date(heart.created_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) + '）：' + String(heart.content)
        : '心声：这轮还没写，聊一句就有了。'
      return {
        mood,
        moodWhy,
        userState,
        heartLine,
        heart: heart ? String(heart.content) : '',
        heartSource: heart ? heart.source : '',
        moodHint: row ? (row.user_msgs + ' 轮 · ' + new Date(row.updated_at).toLocaleTimeString()) : '还没有对话记录',
        attention: valves.attention,
        explanation: valves.explanation,
        emotion: String(valves.emotion),
        goal: String(valves.goal),
        safety,
        narrative: nar ? String(nar.summary).slice(0, 60) : '（还没有叙事）',
        pressure,
        pressureText: pressure + '%',
        follow,
        memCount: String(memCount),
        blocks: String(blocks),
      }
    }

    go.panel('mood', {
      view: () => ({
        type: 'stack',
        title: '陪伴速览',
        children: [
          { type: 'metric', label: '此刻心情', value: { $: 'data.mood' }, caption: { $: 'data.moodWhy' } },
          { type: 'callout', tone: 'info', text: { $: 'data.heartLine' } },
          { type: 'progress', label: '上下文压力', value: { $: 'data.pressure' }, caption: { $: 'data.pressureText' } },
          {
            type: 'keyValue',
            items: [
              ['主人此刻', { $: 'data.userState' }],
              ['注意', { $: 'data.attention' }],
              ['解释', { $: 'data.explanation' }],
              ['情绪阈值', { $: 'data.emotion' }],
              ['目标优先级', { $: 'data.goal' }],
              ['安全', { $: 'data.safety' }],
            ],
          },
          { type: 'text', text: { $: 'data.narrative' } },
          {
            type: 'keyValue',
            items: [
              ['惦记', { $: 'data.follow' }],
              ['记忆', { $: 'data.memCount' }],
              ['压缩块', { $: 'data.blocks' }],
              ['会话', { $: 'data.moodHint' }],
            ],
          },
          { type: 'actions', items: [{ label: '刷新', action: 'refresh', icon: 'refresh' }] },
        ],
      }),
      data: (scope, emit) => {
        const push = () => { try { emit(snapshotFor(scope && scope.sessionId)) } catch {} }
        push()
        const timer = setInterval(push, 15000)
        return () => clearInterval(timer)
      },
      actions: { refresh: () => ({ refresh: true }) },
    })

    go.strip('moodstrip', (scope, emit) => {
      const push = () => {
        try {
          const s = snapshotFor(scope && scope.sessionId)
          emit({ text: s.mood + ' · ' + s.pressureText, icon: 'heart' })
        } catch {}
      }
      push()
      const timer = setInterval(push, 30000)
      return () => clearInterval(timer)
    })
  })
}

/* ---------------- 小工具 ---------------- */
// 只有真正的用户输入才算「主人说的话」：DSH 里用户消息的 source.kind 是 'user'，
// 定时任务发送时是 'schedule'。插件注入的 user 角色消息（plugin:*、runtime-context、
// 工具结果、mnemon 的 delegated review 等）一律不算——否则脏文本会把心情和心声带偏。
const USER_TEXT_KINDS = new Set(['user', 'schedule'])

function extractUserMessage(messages) {
  if (!Array.isArray(messages)) return null
  for (const m of messages) {
    if (!m || m.role !== 'user') continue
    const kind = m.source && m.source.kind
    if (!USER_TEXT_KINDS.has(kind)) continue
    const content = m.content
    let text = ''
    if (typeof content === 'string') text = content.trim()
    else if (Array.isArray(content)) text = content.filter((b) => b && b.type === 'text').map((b) => b.text).join(' ').trim()
    if (!text) continue
    // 没有 id 时用内容当去重键（同一条消息的重复前缀仍能认出来）
    return { id: m.id || 'text:' + text.slice(0, 60), text }
  }
  return null
}

function notify(ctx, title, text) {
  try {
    if (ctx.logger && typeof ctx.logger.warn === 'function') ctx.logger.warn('[companion-one] ' + title + ' — ' + text)
  } catch {}
}

function log(ctx, msg, err) {
  try {
    if (ctx.logger && typeof ctx.logger.warn === 'function') ctx.logger.warn('[companion-one] ' + msg + ': ' + String(err && err.message || err))
  } catch {}
}
