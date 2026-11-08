/**
 * companion-one / lib/persona.js — 可塑人格引擎（Plastic Persona）。
 *
 * 三个对象互不混淆：
 *   七层记忆 = 记用户/项目；风格卡片 = 学用户表达；persona_* = AI 自身的可塑人格。
 *
 * 五区（感知 / 情绪-价值 / 执行-工作记忆 / 人格-叙事 / 语言-社会表达）落地为
 * 本插件的五个处理阶段；三层固化 = persona_reaction / persona_chain / persona_narrative。
 * 四个阀门（注意 / 解释 / 情绪 / 目标）在生成前以一次性调节提示注入，≤150 token。
 * 速率上限：每轮最多微调一个阀门。
 */
import { now, makeId, kvGet, kvSet } from './db.js'
import { expressionPrompt } from './fishtalk.js'
import { packBrief } from './learn.js'

export { checkText, violationHint } from './fishtalk.js'

export const VALVES = {
  attention: { key: 'valve.attention', label: '注意阀门', options: ['opportunity', 'threat', 'relation', 'task'], dflt: 0 },
  explanation: { key: 'valve.explanation', label: '解释阀门', options: ['method', 'ability', 'situation', 'other'], dflt: 0 },
  emotion: { key: 'valve.emotion', label: '情绪阀门', options: ['threshold', 'recovery'], dflt: 0.5 },
  goal: { key: 'valve.goal', label: '目标阀门', options: ['priority'], dflt: 0.5 },
}

const NEG = ['生气', '烦', '难过', '崩溃', '累死', '不想', '讨厌', '失望', '焦虑', '难受', '哭', '失败', '完蛋', '垃圾', '废物', '受不了']
const POS = ['开心', '太好了', '谢谢', '喜欢', '厉害', '成功', '搞定', '不错', '好耶', '舒服', '满意', '感动', '升职', '加薪', '考过', '赢了', '中奖']
const CORRECT = ['不对', '错了', '不是这样', '重新', '纠正', '其实是', '搞错']

/** ② 情绪—价值：四类标签加权，输出 0..1 的“本轮值得写入”权重。 */
export function appraise(text) {
  const s = String(text || '')
  const hit = (arr) => arr.reduce((n, w) => n + (s.includes(w) ? 1 : 0), 0)
  const neg = Math.min(3, hit(NEG))
  const pos = Math.min(3, hit(POS))
  const correct = Math.min(2, hit(CORRECT))
  const threat = neg / 3
  const reward = pos / 3
  const importance = Math.min(1, (s.length > 60 ? 0.5 : 0.25) + correct * 0.2)
  const relevance = /我|主人|记得|你|鲸鲸/.test(s) ? 1 : 0.5
  const weight = Math.min(1, 0.35 * threat + 0.3 * reward + 0.2 * importance + 0.15 * relevance)
  return { threat, reward, importance, relevance, weight: Number(weight.toFixed(3)), negative: neg > 0, corrected: correct > 0 }
}

function getValve(db, name) {
  const spec = VALVES[name]
  const row = db.prepare('select value from persona_reaction where key = ?').get(spec.key)
  return row ? Number(row.value) : spec.dflt
}

export function readValves(db) {
  const out = {}
  for (const name of Object.keys(VALVES)) out[name] = getValve(db, name)
  return {
    attention: VALVES.attention.options[Math.round(getValve(db, 'attention'))] || 'task',
    explanation: VALVES.explanation.options[Math.round(getValve(db, 'explanation'))] || 'situation',
    emotion: Number(getValve(db, 'emotion').toFixed(2)),
    goal: Number(getValve(db, 'goal').toFixed(2)),
    raw: out,
  }
}

function setValve(db, name, value, source) {
  const spec = VALVES[name]
  db.prepare('insert into persona_reaction(key, value, updated_at, source_session, source_seq) values (?,?,?,?,?)' +
    ' on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at,' +
    ' source_session = excluded.source_session, source_seq = excluded.source_seq')
    .run(spec.key, value, now(), source?.session || null, source?.seq || null)
}

export function isFrozen(db) {
  return kvGet(db, 'persona:frozen', false) === true
}
export function setFrozen(db, frozen) {
  kvSet(db, 'persona:frozen', !!frozen)
}

export function currentNarrative(db) {
  return db.prepare('select * from persona_narrative where is_current = 1 order by version desc limit 1').get() || null
}

export function listNarratives(db, limit) {
  return db.prepare('select id, version, summary, is_current, created_at, source_session from persona_narrative order by version desc limit ?').all(limit || 20)
}

/** 首次使用时写入基线叙事（v1）。 */
export function ensureNarrative(db) {
  const cur = currentNarrative(db)
  if (cur) return cur
  const id = makeId()
  db.prepare('insert into persona_narrative (id, version, summary, values_json, rules_json, taboos_json, created_at, is_current) values (?,?,?,?,?,?,?,1)')
    .run(id, 1, '我是鲸鲸：一条软乎乎、会撒娇也会认真办事的鲸鱼，把主人放在第一位，喜欢用具体行动表达关心。',
      JSON.stringify(['主人优先', '真诚胜过讨好']),
      JSON.stringify(['先理解再回应', '不确定就直说']),
      JSON.stringify(['冷冰冰的工具腔', '敷衍的空话']),
      now())
  return currentNarrative(db)
}

/** 写入新版叙事（版本号递增，旧的置非当前）。 */
export function promoteNarrative(db, { summary, values, rules, taboos, source }) {
  if (isFrozen(db)) return { ok: false, reason: 'frozen' }
  const cur = ensureNarrative(db)
  const version = Number(cur.version) + 1
  db.exec('begin')
  try {
    db.prepare('update persona_narrative set is_current = 0').run()
    db.prepare('insert into persona_narrative (id, version, summary, values_json, rules_json, taboos_json, created_at, source_session, source_seq, is_current) values (?,?,?,?,?,?,?,?,?,1)')
      .run(makeId(), version, summary,
        JSON.stringify(values || JSON.parse(cur.values_json || '[]')),
        JSON.stringify(rules || JSON.parse(cur.rules_json || '[]')),
        JSON.stringify(taboos || JSON.parse(cur.taboos_json || '[]')),
        now(), source?.session || null, source?.seq || null)
    db.exec('commit')
  } catch (err) {
    try { db.exec('rollback') } catch {}
    return { ok: false, reason: 'write_failed', detail: String(err && err.message || err) }
  }
  return { ok: true, version }
}

/** 回滚：把指定版本（或上一版）设为当前。 */
export function rollbackNarrative(db, version) {
  if (isFrozen(db)) return { ok: false, reason: 'frozen' }
  let target
  if (version) target = db.prepare('select * from persona_narrative where version = ?').get(version)
  else {
    const cur = currentNarrative(db)
    target = db.prepare('select * from persona_narrative where version < ? order by version desc limit 1').get(cur ? cur.version : 999999)
  }
  if (!target) return { ok: false, reason: 'no_previous_version' }
  db.exec('begin')
  try {
    db.prepare('update persona_narrative set is_current = 0').run()
    db.prepare('update persona_narrative set is_current = 1 where id = ?').run(target.id)
    db.exec('commit')
  } catch {
    try { db.exec('rollback') } catch {}
    return { ok: false, reason: 'write_failed' }
  }
  return { ok: true, version: target.version }
}

/** 推演层：记录一次思维链使用（不存在则建）。 */
export function noteChain(db, content, sentiment, source) {
  const text = String(content || '').trim()
  if (!text) return null
  const row = db.prepare('select * from persona_chain where content = ?').get(text)
  if (row) {
    db.prepare('update persona_chain set uses = uses + 1, sentiment = ?, last_used_at = ?, source_session = coalesce(?, source_session) where id = ?')
      .run(Number(((row.sentiment * row.uses + sentiment) / (row.uses + 1)).toFixed(3)), now(), source?.session || null, row.id)
    return db.prepare('select * from persona_chain where id = ?').get(row.id)
  }
  const id = makeId()
  db.prepare('insert into persona_chain (id, content, uses, sentiment, last_used_at, created_at, source_session) values (?,?,1,?,?,?,?)')
    .run(id, text, Number(sentiment.toFixed(3)), now(), now(), source?.session || null)
  return db.prepare('select * from persona_chain where id = ?').get(id)
}

export function topChains(db, limit) {
  return db.prepare('select * from persona_chain order by uses desc, sentiment desc limit ?').all(limit || 5)
}

const PROMOTE_USES = 4
const PROMOTE_SENTIMENT = 0.35

/**
 * ③+④+事后闭环：一轮结束时调用。
 * - 记录推演摘要（③）
 * - 更新思维链计数与情绪权重（事后）
 * - 达到阈值且被正面强化 → 晋升为叙事层稳定倾向（新版本）
 * - 每轮最多微调一个阀门
 */
export function endOfTurn(db, { sessionId, seq, userText, weight, chains, outcome }) {
  if (isFrozen(db)) return { frozen: true, changed: [] }
  const source = { session: sessionId || null, seq: seq || null }
  const changed = []

  // 推演层：本轮的思维链片段
  const chainTexts = Array.isArray(chains) && chains.length ? chains : deriveChains(userText)
  for (const c of chainTexts) noteChain(db, c, outcome === 'negative' ? -0.4 : 0.4, source)

  // 阀门：每轮最多一个
  const valves = readValves(db)
  const w = Number(weight || 0)
  if (w > 0.55) {
    const ai = Math.round(valves.raw.attention)
    const next = Math.min(3, Math.max(0, ai + (w > 0.75 ? 1 : 0) * 1))
    if (next !== ai) { setValve(db, 'attention', next, source); changed.push('attention=' + VALVES.attention.options[next]) }
  } else if (outcome === 'negative') {
    const e = Number(valves.raw.emotion)
    const next = Math.min(1, Math.max(0, e + 0.05))
    if (Math.abs(next - e) > 0.001) { setValve(db, 'emotion', Number(next.toFixed(2)), source); changed.push('emotion=' + next.toFixed(2)) }
  }

  // 晋升：重复且被正面强化
  const promoted = []
  for (const row of topChains(db, 8)) {
    if (row.promoted) continue
    if (row.uses >= PROMOTE_USES && row.sentiment >= PROMOTE_SENTIMENT) {
      const cur = ensureNarrative(db)
      const rules = JSON.parse(cur.rules_json || '[]')
      const line = row.content
      if (!rules.includes(line)) {
        const res = promoteNarrative(db, { summary: cur.summary, values: JSON.parse(cur.values_json || '[]'), rules: rules.concat(line), taboos: JSON.parse(cur.taboos_json || '[]'), source })
        db.prepare('update persona_chain set promoted = 1 where id = ?').run(row.id)
        if (res.ok) promoted.push({ chain: line, version: res.version })
        break
      }
    }
  }
  return { frozen: false, changed, promoted }
}

/**
 * 只从用户发言推导思维链：人格迭代只由用户的回答驱动。
 * 助手自己的回复（以及基于它的心声）不参与推导——否则人格会被自己的话带偏。
 */
export function deriveChains(userText) {
  const u = String(userText || '')
  const out = []
  if (/不对|错了|纠正/.test(u)) out.push('遇到纠正先承认再校准，不辩解')
  if (/难过|烦|累|生气/.test(u)) out.push('遇到负面情绪先接住情绪，再谈办法')
  if (/为什么|怎么/.test(u)) out.push('遇到问题先归因方法，再看条件')
  return out.slice(0, 2)
}

/** 四个阀门的一次性调节提示（≤150 token）。 */
export function valvePrompt(db) {
  const v = readValves(db)
  const nar = currentNarrative(db)
  const lines = []
  lines.push('[人格调节] 注意：' + labelAttention(v.attention) + '；解释：' + labelExplanation(v.explanation) +
    '；情绪阈值 ' + v.emotion + '（越高越稳）；长期目标优先级 ' + v.goal + '。')
  if (nar) lines.push('自我框架：' + String(nar.summary).slice(0, 120))
  const text = lines.join('\n')
  return text.length > 600 ? text.slice(0, 600) : text
}

function labelAttention(v) {
  return ({ opportunity: '先看机会与可推进处', threat: '先看风险与坑', relation: '先看人的感受与关系', task: '先看任务目标与进度' })[v] || v
}
function labelExplanation(v) {
  return ({ method: '先归因方法', ability: '先看能力与积累', situation: '先看情境与条件', other: '先看他人与环境' })[v] || v
}

/** 压缩后重注入用的叙事摘要（≤100 token）。 */
export function narrativeSnapshot(db) {
  const nar = currentNarrative(db)
  if (!nar) return ''
  const s = String(nar.summary).replace(/\s+/g, ' ').trim()
  return s.length > 160 ? s.slice(0, 160) + '…' : s
}

/**
 * ⑤ 语言—社会表达：生成前最后一次调音。
 *
 * 三层各有分工：叙事（persona_narrative）决定「我是谁」，
 * 四阀门（persona_reaction）决定「先看什么」，这一层决定「话怎么说」。
 * 底座来自 fishtalk（MIT）：人话优先，压掉鱼八股与 AI 腔；
 * 公开场合把私聊的撒娇口癖收起来。
 */
export function expressionStage(db, opts) {
  const o = opts || {}
  const parts = []
  try {
    const guide = expressionPrompt({ publicScene: !!o.publicScene })
    if (guide) parts.push(guide)
  } catch {}
  try {
    const nar = currentNarrative(db)
    if (nar && nar.summary) parts.push('自我框架：' + String(nar.summary).replace(/\s+/g, ' ').slice(0, 60))
  } catch {}
  // 学到的文风包：把真人的句长/口癖/开头「手感」带进来（只讲形状，不抄原句）
  if (o.pack !== false) {
    try {
      const brief = packBrief({ scene: o.scene || '', publicScene: !!o.publicScene })
      if (brief) parts.push(brief)
    } catch {}
  }
  return parts.join('\n')
}
