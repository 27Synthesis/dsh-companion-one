/**
 * learn 测试：面板「学习」用到的 ftStats / ftFeed / ftJob。
 * 用临时 FISHTALK_HOME，别碰线上语料库。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const home = mkdtempSync(join(tmpdir(), 'ft-home-'))
process.env.FISHTALK_HOME = home

const { openDb } = await import('../lib/db.js')
const { stats, feedCorpus, learnStatus } = await import('../lib/learn.js')
const { runOp } = await import('../lib/api.js')

const db = openDb(join(mkdtempSync(join(tmpdir(), 'co-learn-')), 'l.db'))

const s0 = stats()
console.log('stats:', JSON.stringify(s0).slice(0, 160))
assert.equal(s0.ok, true, 'fishtalk should be discoverable')
assert.equal(s0.total, 0)

const r = feedCorpus(db, { lines: ['今天这雨下得真没脾气', '刚下班，累成狗了', 'a'], where: '测试群', scene: '测试群' })
console.log('feed:', JSON.stringify(r))
assert.equal(r.ok, true)
assert.equal(r.added, 2, 'one-char line should be dropped')

const s1 = stats()
assert.ok(s1.total >= 2)
console.log('after feed:', s1.total, 'items, human', s1.human)

const feed2 = feedCorpus(db, { lines: ['今天这雨下得真没脾气'], where: '测试群', scene: '测试群' })
assert.equal(feed2.added, 0, 'duplicate in same context should not be added')
console.log('去重 ok')

// 文风包：凑够 30 条同一场合的语料，distill 才会产出场景统计
const lines = []
for (let i = 0; i < 32; i++) lines.push(['说实话这事儿吧，我觉得还行', '啊这，真的假的', '我就说嘛，早该这样', '累死了，先躺会儿'][i % 4] + '（第' + i + '条）')
const rf = feedCorpus(db, { lines, where: '论坛', scene: '论坛' })
console.log('feed pack:', JSON.stringify(rf))
assert.equal(rf.ok, true)

const info = runOp(db, 'ftPack', {})
console.log('packInfo:', JSON.stringify({ scenes: info.scenes.length, brief: info.brief }).slice(0, 300))
assert.equal(info.ok, true)
assert.ok(info.scenes.length >= 1, 'a scene should be distilled')
assert.ok(info.brief.includes('说话手感'), 'pack brief should be injectable into ⑤ 区')
assert.ok(runOp(db, 'ftPack', { scene: '不存在' }).ok, 'unknown scene falls back to busiest scene')

// ⑤ 区：packBrief 真的进了表达层（指定场合）
const { expressionStage } = await import('../lib/persona.js')
const expr = expressionStage(db, { scene: '论坛' })
assert.ok(expr.includes('说话手感'), '⑤ 区 should carry the learned pack brief')
assert.ok(!expressionStage(db, { scene: '论坛', pack: false }).includes('说话手感'), 'voicePack=false must switch it off')
// 私聊：只有公开语料时借用，但明确标注「只借句式口癖」
const borrowed = expressionStage(db)
assert.ok(borrowed.includes('说话手感'), 'private chat falls back to the busiest scene')
assert.ok(borrowed.includes('只借句式'), 'borrowed public tone must be labelled')
console.log('⑤ 区注入文风包 ok')

// 投喂聊天语料后，私聊才用得上
const chatLines = []
for (let i = 0; i < 32; i++) chatLines.push(['在吗在吗', '刚到家，累瘫了', '你先吃别等我', '哈哈哈真的假的'][i % 4] + '（' + i + '）')
feedCorpus(db, { lines: chatLines, where: 'QQ 群', scene: 'QQ 聊天' })
const chatExpr = expressionStage(db)
assert.ok(chatExpr.includes('说话手感'), 'private chat uses the chat scene once learned')
assert.ok(!chatExpr.includes('只借句式'), 'real chat corpus replaces the borrowed note')
assert.ok(runOp(db, 'ftPack', {}).chatBrief.includes('说话手感'), 'panel shows the private-chat brief')
console.log('私聊文风包 ok')

// voicePack 开关：默认开，可关
const st = runOp(db, 'settings', {})
assert.equal(st.voicePack, true)
assert.equal(st.packScene, '')
assert.equal(runOp(db, 'setSetting', { key: 'voicePack', value: false }).voicePack, false)
assert.equal(runOp(db, 'setSetting', { key: 'packScene', value: '论坛' }).packScene, '论坛')

assert.equal(learnStatus(db).state, 'idle')
assert.equal(runOp(db, 'ftStats').ok, true)
assert.equal(runOp(db, 'ftJob').state, 'idle')
console.log('LEARN TESTS PASSED')
