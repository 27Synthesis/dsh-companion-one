/**
 * anger 测试：主人生气时心情必须接住（原来会显示「安心」）。
 * ①识别：发火/气死/什么鬼 → need=anger，valence 拉低
 * ②心情：人格反应给出「慌了/着急」，不是「安心」
 * ③注入提示：先认下、别辩解
 * ④兜底心声：不照抄主人的气话
 * ⑤面板：overview 带 sessionState；followup 缺 content 被拒
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const dir = mkdtempSync(join(tmpdir(), 'co-anger-'))
const { openDb } = await import('../lib/db.js')
const { userState, personaReaction, angerPrompt, angerOf, fallbackHeartVoice } = await import('../lib/mood.js')
const { appraise } = await import('../lib/persona.js')
const { overview, runOp } = await import('../lib/api.js')

const rage = '别搞那么多有的没的，我现在发火你看不到吗？我五块钱都没了，气死我了，光吃token不干活是不是？'

// ① 识别
const a = angerOf(rage)
assert.equal(a.strong, true, '显式发火必须算强生气')
const st = userState(rage)
console.log('userState:', JSON.stringify(st))
assert.equal(st.need, 'anger')
assert.equal(st.label, '在发火')
assert.ok(st.valence <= -0.7, '生气的情绪值要明显为负，实际 ' + st.valence)

// 只是工作烦 ≠ 冲我发火
const tired = userState('今天工作好烦，做不完')
assert.notEqual(tired.need, 'anger', '「好烦」不该被当成主人冲我发火')

// 温和的不满也要有反应（不用等到发火），并且不能跟强生气一样重
const mild = userState('你这也太差劲了')
const mildMood = personaReaction({ state: mild, valves: { emotion: 0.55 } })
console.log('mild:', mild.need, mild.valence, '→', mildMood.mood)
assert.equal(mild.need, 'anger')
assert.ok(mild.valence > st.valence, '温和不满要比强生气轻')
assert.equal(mildMood.mood, '紧张')

// ② 心情
const steady = personaReaction({ state: st, valves: { emotion: 0.8, attention: 'threat' } })
const soft = personaReaction({ state: st, valves: { emotion: 0.3, attention: 'relation' } })
console.log('mood(稳):', steady.mood, '|', steady.why)
console.log('mood(软):', soft.mood, '|', soft.why)
assert.equal(steady.mood, '着急')
assert.equal(soft.mood, '慌了')
assert.ok(steady.intensity >= 0.9)

// ③ 注入提示
const prompt = angerPrompt(rage)
console.log('prompt:', prompt)
assert.ok(prompt.includes('先认下'), '提示里要明确先认下别辩解')
assert.equal(angerPrompt('今天工作好烦'), '', '普通抱怨不该注入情绪提示')

// ④ 兜底心声
const heart = fallbackHeartVoice({ mood: '慌了' }, { userText: rage })
console.log('heart:', heart)
assert.ok(!heart.includes('气死'), '兜底心声不要照抄主人的气话')

// ⑤ 面板
const db = openDb(join(dir, 'p.db'))
db.prepare("insert into session_state (session_id, scope, mood, mood_level, mood_why, user_state, user_valence, pressure, user_msgs, last_user, updated_at) values (?,?,?,?,?,?,?,?,?,?,?)")
  .run('s-rage', 'global', '慌了', 0, '主人一急，我先慌了', '在发火', -0.8, 74.4, 3, rage.slice(0, 40), Date.now())
const ov = overview(db, { id: 's-rage' })
console.log('overview.sessionState:', JSON.stringify(ov.sessionState))
assert.ok(ov.sessionState, 'overview 要带会话即时状态')
assert.equal(ov.sessionState.mood, '慌了')
assert.equal(ov.sessionState.userState, '在发火')
assert.ok(ov.sessionState.pressure > 70, '压力要跟着显示出来，不能是 0')

const noContent = runOp(db, 'followupAdd', { scope: 'global' })
console.log('followupAdd(no content):', JSON.stringify(noContent))
assert.equal(noContent.ok, false)

// 情绪词表里要有「发火」这类词，否则四阀门不会切到「先看风险」
assert.ok(appraise(rage).threat >= 0.3, '生气要抬高威胁权重')

console.log('ANGER TESTS PASSED')
