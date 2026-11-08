/**
 * fishtalk 底座测试：鱼八股判定、引号豁免、表达层提示、以及接进 pre-step 后的注入。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const dir = mkdtempSync(join(tmpdir(), 'co-ft-'))
const dbFile = join(dir, 'f.db')

const { checkText, violationHint, expressionPrompt } = await import('../lib/fishtalk.js')
const { openDb } = await import('../lib/db.js')
const { expressionStage } = await import('../lib/persona.js')

// 1) 硬证据
const a = checkText('这条我认，确实是我做得不够好')
assert.equal(a.fish, true)
assert.ok(a.hard.includes('这条我认'))
console.log('硬证据 →', a.hint)

// 2) 引号里的原句不算
const b = checkText('你说「这条我认」的时候，我其实没听懂')
assert.equal(b.fish, false)
console.log('引号豁免 ok')

// 3) 正常人话不判鱼
const c = checkText('刚下楼买了杯冰美式，回来路上被晒得有点晕')
assert.equal(c.fish, false)
console.log('正常话不判鱼 ok')

// 4) 两条软信号才算鱼
const d1 = checkText('不是我不想帮你，而是今天真的没空')
assert.equal(d1.fish, false)
const d2 = checkText('总之，作为一个AI，希望对你有帮助')
assert.equal(d2.fish, true)
console.log('软信号阈值 ok →', d2.hint)

// 5) 纠偏提示
const h = violationHint(d2)
assert.ok(h.includes('鱼味') && h.length <= 80)
console.log('纠偏提示 →', h)

// 6) 表达层规则长度
const guide = expressionPrompt({})
assert.ok(guide.includes('禁：'))
assert.ok(guide.length <= 320, 'guide too long: ' + guide.length)
const db = openDb(dbFile)
const stage = expressionStage(db, {})
assert.ok(stage.includes('说话'))
console.log('表达层 ok, chars', stage.length)

// 7) 接进 pre-step：注入里应出现 [说话]，且上轮鱼味会在下一轮被纠正
const { apply } = await import('../index.js')
const tools = new Map(), handlers = new Map()
const ctx = {
  logger: { warn: () => {}, info: () => {} },
  effect: (fn) => { const off = fn(); return () => { if (typeof off === 'function') off() } },
  on: (evt, cb) => { const arr = handlers.get(evt) || []; arr.push(cb); handlers.set(evt, arr); return () => {} },
  inject: (n, cb) => cb(ctx),
  tools: { register: (t) => { tools.set(t.name, t) } },
  systemPrompt: { section: () => () => {} },
  get: () => undefined,
}
apply(ctx, { dbPath: join(dir, 'p.db'), publicScene: false })

let seq = 0
const events = []
const session = { id: 'sess-ft', header: {}, snapshotEvents: () => events, append(t, d) { const e = { type: t, seq: seq++, data: d }; events.push(e); return e } }
const emit = (type, data) => { const ev = { type, seq: seq++, data }; events.push(ev); for (const cb of handlers.get('session/event') || []) cb(session, ev); return ev }

async function preStep(text) {
  const message = { id: 'm' + seq, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
  const payload = { agent: { session }, messages: [message], signal: { aborted: false }, step: 1 }
  for (const cb of handlers.get('agent/pre-step') || []) return await cb(payload, async () => ({ kind: 'enter', messages: [message] }))
  throw new Error('no pre-step')
}

const r1 = await preStep('今天有点累')
const t1 = r1.messages[0].content[0].text
assert.ok(t1.includes('[说话]'), 'expression guide should be injected')
console.log('pre-step 注入 [说话] ok')

// 造一轮鱼味回复 → turn/end → 下一轮应带纠偏
emit('user/message', { message: { role: 'user', content: [{ type: 'text', text: '今天有点累' }], source: { kind: 'user' } } })
emit('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: '总之，作为一个AI，希望对你有帮助。这条我认。' }] } })
emit('turn/end', { turn: 1, reason: { kind: 'completed' } })
const r2 = await preStep('嗯')
const t2 = r2.messages[0].content[0].text
assert.ok(t2.includes('上一轮有点鱼味'), 'fish violation should be corrected next turn')
console.log('鱼味纠偏 ok')

console.log('FISHTALK TESTS PASSED')
