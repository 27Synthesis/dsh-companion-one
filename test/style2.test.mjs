/**
 * style2 测试：2026-11-09 重做后的沟通风格学习。
 * 关注四件事：指标连续可区分、置信度跟样本走、显式偏好锁定、与 ⑤ 区不重复。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const dir = mkdtempSync(join(tmpdir(), 'co-style2-'))
const dbFile = join(dir, 's.db')

const { openDb } = await import('../lib/db.js')
const { learnFromUserText, featuresOf, confidenceOf, listStyle, styleLine, unlockStyle, setStyleValue, stylePrompt } = await import('../lib/style.js')
const { expressionStage } = await import('../lib/persona.js')

const db = openDb(dbFile)
const get = (key) => Number(listStyle(db).find((r) => r.key === key).value)

// ① 三组语体给出不同指标
const chat = '好耶，今天终于搞定了！'
const formal = '根据目前的项目排期，建议在下周三之前完成接口联调，并在周五进行一轮回归测试。'
const emojiHeavy = '太开心啦😄😄😄 今天出去玩！！'
for (let i = 0; i < 20; i++) learnFromUserText(db, chat)
const shortLen = get('句长')
const shortEmoji = get('emoji频率')
for (let i = 0; i < 20; i++) learnFromUserText(db, formal)
const longLen = get('句长')
for (let i = 0; i < 20; i++) learnFromUserText(db, emojiHeavy)
const emojiScore = get('emoji频率')
console.log('句长 短句→长句:', shortLen.toFixed(2), '→', longLen.toFixed(2), '| emoji:', shortEmoji.toFixed(2), '→', emojiScore.toFixed(2))
assert.ok(longLen > shortLen, '长句语料应该把句长推高')
assert.ok(emojiScore > shortEmoji, 'emoji 语料应该把 emoji 频率推高')

// ② 直接度不再是常量
const directA = featuresOf('帮我改一下这个文件，快点').直接度
const directB = featuresOf('麻烦您有空的时候帮我看看这个，谢谢啦').直接度
console.log('直接度 命令 vs 客气:', directA.toFixed(2), 'vs', directB.toFixed(2))
assert.ok(directA > directB, '祈使句应该比客气话更直接')

// ③ 置信度随样本增长
assert.ok(confidenceOf(0) < confidenceOf(10) && confidenceOf(10) < confidenceOf(100))
assert.ok(confidenceOf(100) <= 0.95)
console.log('置信度 0/10/100:', confidenceOf(0), confidenceOf(10), confidenceOf(100))

// ④ 显式偏好锁定 7 天，之后普通消息不会拉回
learnFromUserText(db, '别这么正式，随便点')
const lockedVal = get('直接度')
assert.ok(lockedVal > 0.85, 'explicit preference should lock: ' + lockedVal)
for (let i = 0; i < 10; i++) learnFromUserText(db, formal)
assert.ok(get('直接度') > 0.85, 'locked value must survive 10 normal messages')
const row = listStyle(db).find((r) => r.key === '直接度')
assert.equal(Number(row.locked), 1)
console.log('锁定后 10 轮仍是:', get('直接度').toFixed(2))

// ⑤ 解锁后恢复自动学习
unlockStyle(db, '直接度')
for (let i = 0; i < 10; i++) learnFromUserText(db, formal)
assert.ok(get('直接度') < lockedVal, 'after unlock, learning should move it back')
console.log('解锁后自动学习回到:', get('直接度').toFixed(2))

// ⑥ 与 ⑤ 区合并：不再有两套互相矛盾的句长建议
setStyleValue(db, '句长', 0.2)
const stage = expressionStage(db, { styleText: styleLine(db) })
console.log('⑤ 区输出:', stage.split('\n')[0])
assert.ok(stage.includes('一两句说完'), 'style line should win')
assert.ok(!stage.includes('像真人在微信里打字'), 'generic tone line should be replaced')
assert.ok(!(stage.includes('可以展开') && stage.includes('一两句说完')), 'no contradictory advice')
assert.ok(stylePrompt(db).includes('[表达风格]'))

console.log('STYLE2 TESTS PASSED')
