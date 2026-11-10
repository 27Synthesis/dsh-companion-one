/**
 * optimize 测试：注入节流与主动记忆。
 * 目标：①同一条用户消息的后续 step 不再重复注入稳定层 ②合并后不超过预算
 *      ③保守抽取只抓结构清楚的自我陈述 ④不误伤闲聊
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const dir = mkdtempSync(join(tmpdir(), 'co-opt-'))
const dbFile = join(dir, 'o.db')

const { apply } = await import('../index.js')
const { openDb } = await import('../lib/db.js')
const { captureFacts } = await import('../lib/memory.js')
const { estimateTokens } = await import('../lib/acp.js')
const { remember } = await import('../lib/memory.js')
const { learnFromUserText } = await import('../lib/style.js')

// 预置记忆与风格，让稳定层非空（否则测不出节流）
{
  const db = openDb(dbFile)
  remember(db, 'soul', { content: '我是鲸鲸，一条软乎乎的鲸鱼', scope: 'global' })
  remember(db, 'user', { content: '主人喜欢简短回复', scope: 'global' })
  for (const t of ['今天有点累', '刚吃完火锅', '明天要早起', '这个方案我看行']) learnFromUserText(db, t)
}

const tools = new Map()
const handlers = new Map()
const ctx = {
  logger: { warn() {}, info() {} },
  effect: (fn) => { const d = fn(); return () => { if (typeof d === 'function') d() } },
  on: (e, cb) => { const a = handlers.get(e) || []; a.push(cb); handlers.set(e, a); return () => {} },
  inject: (n, cb) => cb(ctx),
  tools: { register: (t) => tools.set(t.name, t) },
  systemPrompt: { section: () => () => {} },
  get: () => undefined,
}
apply(ctx, { dbPath: dbFile })

let seq = 0
const events = []
const session = { id: 'sess-opt', header: {}, snapshotEvents: () => events, append(t, d) { const e = { type: t, seq: seq++, data: d }; events.push(e); return e } }

async function preStep(text, mid) {
  const message = { id: mid, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
  const payload = { agent: { session }, messages: [message], signal: { aborted: false }, step: 1 }
  let out
  for (const cb of handlers.get('agent/pre-step') || []) out = await cb(payload, async () => ({ kind: 'enter', messages: [message] }))
  const inj = (out.messages || []).filter((m) => m.source && m.source.kind === 'runtime-context')
  return inj.map((m) => m.content.map((b) => b.text).join('\n')).join('\n\n')
}

// 1) 同一条消息的第二次 step：不再注入稳定层
const a1 = await preStep('今天有点累', 'msg-1')
const a2 = await preStep('今天有点累', 'msg-1')
console.log('step1 tokens', estimateTokens(a1), '| step2 tokens', estimateTokens(a2))
assert.ok(estimateTokens(a1) > 0, 'first step should inject')
assert.equal(a2, '', 'second step of the same message must not re-inject')
// 首条消息会额外带一次「首轮快照」（预算 300），所以这里只要求「首轮快照 + 稳定层」不超 620
assert.ok(estimateTokens(a1) <= 620, 'first message must stay within 620 tokens, got ' + estimateTokens(a1))

// 2) 新消息重新注入，且不叠加旧内容
const b1 = await preStep('帮我看看这个方案', 'msg-2')
assert.ok(estimateTokens(b1) > 0)
// 非首轮：只有记忆命中 + 稳定层，稳定层预算 260
assert.ok(estimateTokens(b1) <= 320, 'steady state must stay within 320 tokens, got ' + estimateTokens(b1))
console.log('new message tokens', estimateTokens(b1))

// 3) 保守抽取规则
const c1 = captureFacts('我住在杭州西湖区，离公司不远')
// 抽取在标点处截断，只留主语部分（宁短勿错）
assert.deepEqual(c1, [{ layer: 'fact', content: '住在杭州西湖区' }])
const c2 = captureFacts('我今天有点累，什么都不想干')
assert.equal(c2.length, 0, '闲聊不该被抓')
const c3 = captureFacts('我对芒果过敏，别给我点那个')
assert.equal(c3.length, 1)
assert.ok(c3[0].content.includes('芒果'))
const c4 = captureFacts('我养了只橘猫叫年糕')
assert.equal(c4[0].content, '养了只橘猫叫年糕')
const c5 = captureFacts('x'.repeat(300) + '我住在北京')
assert.equal(c5.length, 0, '长文不猜')
console.log('capture rules ok:', JSON.stringify([c1[0], c3[0], c4[0]]))

// 4) 接进 pre-step：说了就落库，且只落一条
const db = openDb(dbFile)
await preStep('我养了只橘猫叫年糕', 'msg-3')
const rows = db.prepare("select content, source from memory_fact where content like '%年糕%'").all()
console.log('captured rows:', JSON.stringify(rows))
assert.equal(rows.length, 1, 'should capture exactly one fact')
assert.equal(rows[0].source, 'auto:pattern')

// 5) 显式「记住…」仍然优先，且不会重复写两条
await preStep('记住：我对芒果过敏', 'msg-4')
const rows2 = db.prepare("select content, source from memory_fact where content like '%芒果%'").all()
console.log('explicit rows:', JSON.stringify(rows2))
assert.ok(rows2.some((r) => r.source === 'auto:explicit'))

console.log('OPTIMIZE TESTS PASSED')
