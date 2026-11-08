/**
 * 陪伴行为层 / 风格 / 人格的行为测试。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const { openDb } = await import('../lib/db.js')
const { remember, listMemory } = await import('../lib/memory.js')
const { activeFacts, addFollowUp, pickDueFollowUp, markAsked, classify, bumpCrisis, readCrisis } = await import('../lib/companion.js')
const { learnFromUserText, stylePrompt, styleEnabled, setStyleEnabled, listStyle } = await import('../lib/style.js')
const { endOfTurn, currentNarrative, promoteNarrative, rollbackNarrative, setFrozen, isFrozen, readValves, noteChain } = await import('../lib/persona.js')

const db = openDb(join(mkdtempSync(join(tmpdir(), 'co2-')), 'x.db'))
const scope = 'peer:a'

// 1) 事实键失效
const f1 = remember(db, 'fact', { content: '主人住在杭州西湖区', scope })
const f2 = remember(db, 'fact', { content: '主人搬到上海了，住在浦东', scope })
console.log('fact supersede:', f1.id, '->', f2.id, 'superseded:', f2.superseded.length)
assert.equal(f2.superseded.length, 1)
const act = activeFacts(db, scope, 10)
console.log('active facts:', act.map((r) => r.content))
assert.equal(act.length, 1)
assert.ok(act[0].content.includes('上海'))
// 旧条仍可回溯
const all = listMemory(db, 'fact', { scope, includeInvalid: true, limit: 10 })
assert.equal(all.length, 2)

// 2) 惦记的事：每天一件、大事优先、负面情绪不打扰
const smallId = addFollowUp(db, { scope, content: '问问主人项目答辩结果', dueAt: Date.now() - 3600_000, size: 'small' })
const bigId = addFollowUp(db, { scope, content: '主人妈妈的手术复查', dueAt: Date.now() - 7200_000, size: 'big' })
const pick1 = pickDueFollowUp(db, scope, { userText: '今天天气不错' })
console.log('picked:', pick1 && pick1.content)
assert.ok(pick1 && pick1.id === bigId, 'big one first')
markAsked(db, bigId)
const pick2 = pickDueFollowUp(db, scope, { userText: '今天天气不错' })
assert.equal(pick2, null, 'at most one per day')

const db2 = openDb(join(mkdtempSync(join(tmpdir(), 'co3-')), 'y.db'))
addFollowUp(db2, { scope, content: '体检报告', dueAt: Date.now() - 1000, size: 'small' })
assert.equal(pickDueFollowUp(db2, scope, { userText: '我好难过，今天特别崩溃' }), null, 'silent while negative')

// 3) 危机分级
console.log('levels:', [0, 1, 2, 3, 4, 5].map((n) => {
  const samples = ['今天挺平常的', '有点累', '最近很难过，撑不住', '觉得活着没意思', '想死，想结束自己', '已经准备好了，现在就结束']
  return classify(samples[n]).level
}).join(','))
assert.equal(classify('想死，想结束自己').level, 4)
assert.equal(classify('今天挺平常的').level, 0)
const c = bumpCrisis(db, scope, 4)
assert.equal(readCrisis(db, scope).level, 4)
assert.equal(bumpCrisis(db, scope, 1).level, 4, 'crisis state does not decay')

// 4) 风格：学到特征、关闭后不再注入
learnFromUserText(db, '鲸鲸你好呀！今天好累啊，不过还行吧～')
learnFromUserText(db, '帮我看看这个报错：TypeError: undefined is not a function')
learnFromUserText(db, '别这么正式，随便点说～')
const sp = stylePrompt(db)
console.log('style prompt:', sp)
assert.ok(sp.length > 0)
assert.ok(listStyle(db).length >= 3)
setStyleEnabled(db, false)
assert.equal(stylePrompt(db), '', 'no injection while off')
setStyleEnabled(db, true)

// 5) 人格：重复思维链晋升为叙事新版本
const chain = '遇到纠正先承认再校准，不辩解'
for (let i = 0; i < 5; i++) {
  endOfTurn(db, { sessionId: 's1', seq: 100 + i, userText: '不对，你搞错了', assistantText: '好，我重新看一下', weight: 0.6, chains: [chain], outcome: 'positive' })
}
const nar = currentNarrative(db)
console.log('narrative version:', nar.version, 'rules:', nar.rules_json)
assert.ok(nar.version >= 2, 'promoted to new version')
assert.ok(nar.rules_json.includes('纠正'))

const rb = rollbackNarrative(db)
console.log('rollback:', JSON.stringify(rb))
assert.equal(rb.ok, true)
assert.equal(currentNarrative(db).version, 1)

// 6) 冻结后只读
setFrozen(db, true)
const before = currentNarrative(db).version
const res = promoteNarrative(db, { summary: '我变成另一个样子' })
console.log('frozen promote:', JSON.stringify(res))
assert.equal(res.ok, false)
assert.equal(currentNarrative(db).version, before)
const e = endOfTurn(db, { sessionId: 's1', seq: 999, userText: '你好', chains: [chain], weight: 0.9, outcome: 'positive' })
assert.equal(e.frozen, true)
setFrozen(db, false)

// 7) 阀门速率上限：一轮最多一个变化
const v1 = readValves(db)
endOfTurn(db, { sessionId: 's2', seq: 1, userText: '太好了，谢谢你', chains: ['先把话说清楚，再补细节'], weight: 0.9, outcome: 'positive' })
const v2 = readValves(db)
const diffs = ['attention', 'emotion', 'goal'].filter((k) => v1[k] !== v2[k]).length +
  (v1.explanation !== v2.explanation ? 1 : 0)
console.log('valve changes this turn:', diffs, JSON.stringify(v2))
assert.ok(diffs <= 1, 'at most one valve per turn')

console.log('\nALL BEHAVIOUR TESTS PASSED')
