/**
 * panel-live 测试：面板上几处「看起来不动」的功能，验证它们真的会变
 * ①人格每轮小幅迭代并留下记录 ②心声兜底每轮不同 ③概览心声能回落到别的会话 ④明细能回落
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const dir = mkdtempSync(join(tmpdir(), 'co-live-'))
const dbFile = join(dir, 'p.db')

const { openDb, kvSet, kvGet } = await import('../lib/db.js')
const { endOfTurn, readValves } = await import('../lib/persona.js')
const { fallbackHeartVoice, addHeartVoice } = await import('../lib/mood.js')
const { overview, runOp } = await import('../lib/api.js')

const db = openDb(dbFile)

// ① 人格：连续三轮，每轮都要留下记录，阀门要动
const before = readValves(db)
const turns = ['今天被骂了，好烦', '帮我看看这个方案怎么改', '谢谢你，今天多亏你了']
const changes = []
for (const t of turns) {
  const r = endOfTurn(db, { sessionId: 's1', seq: 1, userText: t, weight: 0.6, outcome: t.includes('烦') ? 'negative' : 'positive' })
  changes.push(r.changed)
}
const after = readValves(db)
const last = kvGet(db, 'persona:last', null)
console.log('阀门 before:', JSON.stringify({ attention: before.attention, emotion: before.emotion }))
console.log('阀门 after :', JSON.stringify({ attention: after.attention, emotion: after.emotion }))
console.log('每轮变化:', JSON.stringify(changes))
assert.ok(last && last.at, 'persona:last 应该有记录')
assert.ok(changes.some((c) => c.length > 0), '至少一轮发生调整')
assert.ok(Math.abs(Number(after.emotion) - Number(before.emotion)) > 0.001 || after.attention !== before.attention, '阀门必须真的变')

// ② 心声兜底：不同话要给出不同句子
const a = fallbackHeartVoice({ mood: '心疼' }, { userText: '今天好累啊' })
const b = fallbackHeartVoice({ mood: '心疼' }, { userText: '项目又延期了' })
console.log('心声 A:', a)
console.log('心声 B:', b)
assert.notEqual(a, b, '不同输入不该给同一句')

// ③ 概览心声：本会话没有时回落到全局最近一条
addHeartVoice(db, { sessionId: 'other', scope: 'global', content: '别的会话里的心声', mood: '安心', source: 'auto' })
const ov = overview(db, { id: 'no-such-session' })
console.log('概览心声:', ov.heartVoice && ov.heartVoice.content)
assert.ok(ov.heartVoice && ov.heartVoice.content === '别的会话里的心声', '应该回落到全局最近一条')
assert.equal(ov.heartVoiceOfSession, false)

// ④ 明细：找不到本会话时回落到全局最近一次注入
kvSet(db, 'inject:last:sess-abc', { at: Date.now(), total: 123, parts: [{ label: '[说话]', tokens: 123 }] })
const diag = runOp(db, 'diag', { sessionId: 'nothing-here' })
console.log('明细回落:', diag.usedSession, '| total', diag.inject && diag.inject.total, '| note', diag.note)
assert.equal(diag.usedSession, 'sess-abc')
assert.equal(diag.inject.total, 123)
assert.ok('note' in diag)

console.log('PANEL-LIVE TESTS PASSED')
