/**
 * 心情两因素 + 心声 的单元测试。
 * 心情 = userState（用户这句话+余温）→ personaReaction（放进人格里反应）；
 * 心声只展示，不参与人格迭代（deriveChains 只看用户发言）。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const { openDb, now } = await import('../lib/db.js')
const { userState, personaReaction, fallbackHeartVoice, addHeartVoice, latestHeartVoice, listHeartVoices } =
  await import('../lib/mood.js')
const { deriveChains, endOfTurn, topChains } = await import('../lib/persona.js')

const db = openDb(join(mkdtempSync(join(tmpdir(), 'co-mood-')), 'x.db'))
const scope = 'peer:a'

// 1) userState：五类输入
const comfort = userState('我真的崩溃了，想哭')
console.log('comfort:', comfort)
assert.equal(comfort.need, 'comfort')
assert.ok(comfort.valence <= -0.55)
assert.equal(comfort.label, '很难过')
assert.equal(comfort.crisis, 2)

const company = userState('好想你，陪我说说话')
assert.equal(company.need, 'company')
assert.equal(company.label, '在想念')

const care = userState('鲸鲸你今天累不累呀')
assert.equal(care.need, 'care')
assert.equal(care.label, '在关心我')

const praise = userState('你太厉害了，多亏你')
assert.equal(praise.need, 'praise')
assert.equal(praise.label, '在夸我')

const celebrate = userState('今天升职了，太好了')
assert.equal(celebrate.need, 'celebrate')
assert.equal(celebrate.label, '很开心')

const advice = userState('帮我看看这个方案怎么改')
assert.equal(advice.need, 'advice')
assert.equal(advice.label, '想办正事')

const neutral = userState('今天天气不错')
assert.equal(neutral.need, 'chat')
assert.equal(neutral.crisis, 0)
assert.ok(Math.abs(neutral.valence - 0.24) < 0.01)
assert.equal(neutral.label, '平静')

// 2) 情绪余温：15 分钟内的低落不会瞬间归零
const prev = { valence: -0.6, need: 'comfort', at: now() - 5 * 60 * 1000 }
const linger = userState('嗯嗯', { prev })
console.log('linger:', linger)
assert.equal(linger.lingering, true)
assert.ok(Math.abs(linger.valence - -0.33) < 0.01)
assert.equal(linger.need, 'comfort', 'need carried over')
assert.equal(linger.label, '有点低落')

const stale = userState('嗯嗯', { prev: { valence: -0.6, need: 'comfort', at: now() - 20 * 60 * 1000 } })
assert.equal(stale.lingering, false)
assert.equal(stale.valence, 0)

const turned = userState('太好了，我升职了', { prev })
assert.equal(turned.lingering, false)
assert.ok(turned.valence > 0.25)

const crisisOverrides = userState('不想活了', { prev })
assert.equal(crisisOverrides.crisis, 3)
assert.equal(crisisOverrides.lingering, false)
assert.equal(crisisOverrides.need, 'safety')

// 3) storedCrisis：之前挂着的危机让这一轮仍放不下心
const calmWithStored = userState('我到家了', { crisisLevel: 3 })
assert.equal(calmWithStored.storedCrisis, 3)
assert.equal(calmWithStored.crisis, 0)
const storedReaction = personaReaction({ state: calmWithStored, valves: {} })
assert.equal(storedReaction.mood, '担心')

// 4) personaReaction：人格阀门与叙事参与
const sad = { valence: -0.8, need: 'comfort', crisis: 0, storedCrisis: 0, label: '很难过' }
const softDefault = personaReaction({ state: sad, valves: {} })
console.log('softDefault:', softDefault)
assert.equal(softDefault.mood, '心疼')
assert.equal(softDefault.intensity, 0.9)
assert.ok(softDefault.why.includes('心疼') || softDefault.why.includes('难过'))

const steady = personaReaction({ state: sad, valves: { emotion: 0.8 } })
assert.equal(steady.mood, '担心', 'high emotion threshold steadies 心疼 into 担心')
assert.ok(steady.intensity <= 0.75)

const mild = { valence: -0.4, need: 'comfort', crisis: 0, storedCrisis: 0, label: '有点低落' }
assert.equal(personaReaction({ state: mild, valves: {} }).mood, '担心')
assert.equal(personaReaction({ state: mild, valves: { emotion: 0.3 } }).mood, '心疼', 'low threshold softens 担心')

const framed = personaReaction({ state: sad, valves: {}, narrative: { summary: '把主人放在第一位，主人优先' } })
assert.ok(Math.abs(framed.intensity - softDefault.intensity - 0.05) < 0.001)

const danger = userState('我想死')
assert.equal(danger.crisis, 4)
assert.equal(personaReaction({ state: danger, valves: {} }).mood, '揪心')
const danger3 = userState('活着好累，感觉没有意义')
assert.equal(danger3.crisis, 3)
assert.equal(personaReaction({ state: danger3, valves: {} }).mood, '担心')

assert.equal(personaReaction({ state: company, valves: {} }).mood, '想念')
assert.equal(personaReaction({ state: care, valves: {} }).mood, '心动')
assert.equal(personaReaction({ state: praise, valves: {} }).mood, '得意')
assert.equal(personaReaction({ state: celebrate, valves: {} }).mood, '开心')
assert.equal(personaReaction({ state: advice, valves: {} }).mood, '认真')
assert.equal(personaReaction({ state: neutral, valves: { attention: 'relation' } }).mood, '想陪着你')
assert.equal(personaReaction({ state: neutral, valves: {} }).mood, '安心')

// 5) 兜底心声：一小句口语（不是作文），按心情给、不引原话
const moods = ['揪心', '担心', '心疼', '想念', '开心', '得意', '认真', '心动', '安心', '想陪着你']
for (const m of moods) {
  const line = fallbackHeartVoice({ mood: m }, { userText: '今天好累啊' })
  assert.ok(line.length >= 4 && line.length <= 30, 'length of ' + m + ': ' + line.length)
  assert.ok(/主人|我|他/.test(line), '第一人称或指向主人: ' + line)
  assert.ok(!line.includes('（刚听主人说'), '别把原话塞进心声: ' + line)
}
assert.ok(fallbackHeartVoice(null).length >= 2, 'unknown mood still returns a line')

// 6) deriveChains 只看用户发言
assert.deepEqual(deriveChains('不对，你错了'), ['遇到纠正先承认再校准，不辩解'])
assert.deepEqual(deriveChains('为什么老是失败'), ['遇到问题先归因方法，再看条件'])
assert.deepEqual(deriveChains('今天天气不错'), [])
assert.deepEqual(deriveChains('先把话说清楚再补细节'), [], 'assistant-style text learns nothing')

const db2 = openDb(join(mkdtempSync(join(tmpdir(), 'co-mood2-')), 'y.db'))
endOfTurn(db2, { sessionId: 's1', seq: 1, userText: '今天天气不错', assistantText: '不对，你错了，应该重新来。' })
assert.equal(topChains(db2, 10).length, 0, 'assistantText does not feed persona chains')
endOfTurn(db2, { sessionId: 's1', seq: 2, userText: '不对，你错了' })
assert.ok(topChains(db2, 10).length >= 1)

// 7) 心声存取 + session_state 同步
db.prepare('insert into session_state (session_id, scope, updated_at) values (?,?,?)').run('sess1', scope, now())
const v1 = addHeartVoice(db, {
  sessionId: 'sess1', scope, content: '  主人今天有点累，我想先陪一会儿，不急着讲道理。  ',
  mood: '心疼', source: 'auto', userText: '我好累', seq: 3,
})
console.log('heart voice:', v1 && v1.content, v1 && v1.source)
assert.ok(v1)
assert.equal(v1.content, '主人今天有点累，我想先陪一会儿，不急着讲道理。')
assert.equal(v1.source, 'auto')
assert.equal(latestHeartVoice(db, 'sess1').id, v1.id)
const ss1 = db.prepare('select heart, heart_at, heart_source, mood, user_state from session_state where session_id = ?').get('sess1')
assert.equal(ss1.heart_source, 'auto')
assert.equal(ss1.heart, v1.content)

const v2 = addHeartVoice(db, {
  sessionId: 'sess1', scope, content: '主人这么开心，我也跟着高兴。', mood: '开心', source: 'model', seq: 4,
})
assert.equal(latestHeartVoice(db, 'sess1').id, v2.id)
assert.equal(db.prepare('select heart_source from session_state where session_id = ?').get('sess1').heart_source, 'model')
assert.equal(listHeartVoices(db, 'sess1', 10).length, 2)
assert.equal(listHeartVoices(db, null, 10).length, 2)
assert.equal(addHeartVoice(db, { sessionId: 'sess1', content: '   ' }), null)

const long = addHeartVoice(db, { sessionId: 'sess1', content: '心'.repeat(300) })
assert.equal(long.content.length, 240)
assert.equal(latestHeartVoice(db, null), null)

console.log('mood tests ok')
