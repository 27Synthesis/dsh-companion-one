/**
 * auto 测试：用户明确说「记住…」时，即使模型没调 memory_add，也要自动落库；
 * 重复说同一件事要走合并而不是堆两条。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const dir = mkdtempSync(join(tmpdir(), 'co-auto-'))
const dbFile = join(dir, 'a.db')

const { apply } = await import('../index.js')
const { openDb } = await import('../lib/db.js')

const tools = new Map()
const handlers = new Map()
const ctx = {
  logger: { warn: () => {}, info: () => {} },
  effect: (fn) => { const d = fn(); return () => { if (typeof d === 'function') d() } },
  on: (evt, cb) => { const arr = handlers.get(evt) || []; arr.push(cb); handlers.set(evt, arr); return () => {} },
  inject: (names, cb) => cb(ctx),
  tools: { register: (t) => { tools.set(t.name, t) } },
  systemPrompt: { section: () => () => {} },
  get: () => undefined,
}
apply(ctx, { dbPath: dbFile })

let seq = 0
const events = []
const session = { id: 'sess-auto', header: {}, meta: {}, snapshotEvents: () => events, append(type, data) { const ev = { type, seq: seq++, data }; events.push(ev); return ev } }

async function preStep(text) {
  const message = { id: 'm1', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
  const payload = { agent: { session }, messages: [message], signal: { aborted: false }, step: 1 }
  for (const cb of handlers.get('agent/pre-step') || []) {
    return await cb(payload, async () => ({ kind: 'enter', messages: [message] }))
  }
  throw new Error('no pre-step handler')
}

await preStep('记住：妈妈的生日是三月初五，要提前一周准备礼物')
const db = openDb(dbFile)
const rows = db.prepare("select * from memory_fact where content like '%生日%'").all()
console.log('after explicit remember ->', rows.map((r) => r.content).join(' | '))
assert.equal(rows.length, 1, 'explicit remember should auto-save one fact')

await preStep('记住：妈妈的生日是三月初五，要提前一周准备礼物')
const rows2 = db.prepare("select * from memory_fact where content like '%生日%'").all()
console.log('after repeat ->', rows2.length, 'row(s), merged ok')
assert.equal(rows2.length, 1, 'repeat should merge, not duplicate')

await preStep('今天天气不错，随便聊聊')
const rows3 = db.prepare('select count(*) c from memory_fact').get().c
assert.equal(rows3, 1, 'ordinary chat must not create memory')
console.log('ordinary chat created nothing ✓')
console.log('AUTO TESTS PASSED')
