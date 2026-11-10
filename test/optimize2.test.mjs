/**
 * optimize2 测试：本轮七条优化的验收
 * ①惦记可按 3/7 天重提 ②tier1 攒多了合并成 tier2 ③重要记忆排前面
 * ④别名检索 ⑤注入明细可见 ⑥长文不拉偏风格 ⑦WAL/vacuum 不报错
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const dir = mkdtempSync(join(tmpdir(), 'co-opt2-'))
const dbFile = join(dir, 'o2.db')

const { openDb, listMemory, now } = await import('../lib/db.js')
const { remember, searchMemory, bumpHit } = await import('../lib/memory.js')
const { addFollowUp, pickDueFollowUp, markAsked, reaskGap } = await import('../lib/companion.js')
const { consolidateBlocks, listBlocks } = await import('../lib/acp.js')
const { learnFromUserText, listStyle } = await import('../lib/style.js')
const { apply } = await import('../index.js')
const { runOp } = await import('../lib/api.js')

const db = openDb(dbFile)
const DAY = 86400000

// ① 惦记：能重提，但最多 3 次
const fid = addFollowUp(db, { scope: 'peer:a', content: '妈妈的复查结果', dueAt: Date.now() - DAY, size: 'small' })
const first = pickDueFollowUp(db, 'peer:a', { userText: '今天有点忙' })
assert.ok(first && first.id === fid, 'due follow-up should be picked')
markAsked(db, fid)
assert.equal(pickDueFollowUp(db, 'peer:a', { userText: '今天有点忙' }), null, 'same day should not re-ask')
db.prepare('update follow_ups set asked_at = ? where id = ?').run(Date.now() - 4 * DAY, fid)
const second = pickDueFollowUp(db, 'peer:a', { userText: '在吗' })
assert.ok(second, 'after 3 days it should re-ask')
markAsked(db, fid)
db.prepare('update follow_ups set asked_at = ? where id = ?').run(Date.now() - 8 * DAY, fid)
assert.ok(pickDueFollowUp(db, 'peer:a', { userText: '在吗' }), 'after 7 days re-ask again')
markAsked(db, fid)
db.prepare('update follow_ups set asked_at = ? where id = ?').run(Date.now() - 30 * DAY, fid)
assert.equal(pickDueFollowUp(db, 'peer:a', { userText: '在吗' }), null, 'max 3 asks')
assert.equal(reaskGap({ ask_count: 1 }), 3 * DAY)
console.log('① 惦记重提 ok')

// ② tier1 攒多了合并成 tier2
const mkBlock = (id, ts) => db.prepare('insert into compressed_blocks (id, session_id, tier, child_refs, start_seq, end_seq, summary, summary_tokens, source_tokens, tokens_saved, message_count, status, created_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?)')
  .run(id, 'sess-x', 1, '[]', 1, 2, '摘要' + id, 10, 100, 90, 3, 'committed', ts)
for (let i = 0; i < 8; i++) mkBlock('b' + (100 + i), now() - (8 - i) * 1000)
const made = consolidateBlocks(db, { sessionId: 'sess-x', threshold: 6, keep: 2 })
assert.equal(made.length, 1, 'should merge into one tier2')
const folded = db.prepare("select count(*) c from compressed_blocks where status='folded'").get().c
assert.ok(folded >= 6, 'children folded')
const listed = listBlocks(db, 'sess-x', 50)
assert.ok(listed.every((b) => b.status !== 'folded'), 'folded blocks hidden')
assert.ok(listed.some((b) => b.tier === 2), 'tier2 visible')
console.log('② 分层折叠 ok:', made[0].ref, 'children', made[0].children.length)

// ③ 重要度排序：置顶 / 命中过的排前面
const a1 = remember(db, 'fact', { content: '对芒果过敏', scope: 'peer:b' })
remember(db, 'fact', { content: '上周去了趟西湖', scope: 'peer:b' })
const rowsBefore = listMemory(db, 'fact', { scope: 'peer:b', limit: 5, order: 'importance' })
bumpHit(db, [{ layer: 'fact', id: a1.id }])
db.prepare('update memory_fact set pinned = 1 where id = ?').run(a1.id)
const rowsAfter = listMemory(db, 'fact', { scope: 'peer:b', limit: 5, order: 'importance' })
assert.equal(rowsAfter[0].id, a1.id, 'pinned + hit fact should come first')
assert.ok(rowsBefore.length >= 2)
console.log('③ 重要度排序 ok')

// ④ 别名检索：问「住址」能找到「住在杭州」
remember(db, 'fact', { content: '住在杭州西湖区', scope: 'peer:c' })
const hits = searchMemory(db, '住址', { scope: 'peer:c', limit: 5 })
assert.ok(hits.some((r) => r.content.includes('杭州')), 'alias search should find home fact')
console.log('④ 别名检索 ok:', hits.length, 'hits')

// ⑥ 长文不拉偏句长
for (let i = 0; i < 6; i++) learnFromUserText(db, '这是一段很长的话'.repeat(30))
const style = Object.fromEntries(listStyle(db).map((r) => [r.key, Number(r.value)]))
assert.ok(!('句长' in style) || style['句长'] < 0.9, 'long text must not push 句长 to max: ' + style['句长'])
learnFromUserText(db, '嗯，好的呀，那就这样')
const style2 = Object.fromEntries(listStyle(db).map((r) => [r.key, Number(r.value)]))
assert.ok(!('句长' in style2) || style2['句长'] < 0.5, 'short text keeps 句长 low: ' + style2['句长'])
console.log('⑥ 长文不拉偏 ok')

// ⑤⑦ 注入明细 + 健康检查
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
const session = { id: 'sess-diag', header: {}, snapshotEvents: () => events, append(t, d) { const e = { type: t, seq: seq++, data: d }; events.push(e); return e } }
const message = { id: 'm1', role: 'user', content: [{ type: 'text', text: '你好呀' }], source: { kind: 'user' } }
const payload = { agent: { session }, messages: [message], signal: { aborted: false }, step: 1 }
for (const cb of handlers.get('agent/pre-step') || []) await cb(payload, async () => ({ kind: 'enter', messages: [message] }))
const diag = runOp(db, 'diag', { sessionId: 'sess-diag' })
assert.ok(diag.inject && diag.inject.total > 0, 'inject detail should exist')
assert.ok(Array.isArray(diag.inject.parts) && diag.inject.parts.length > 0)
assert.ok(typeof diag.fails === 'number')
assert.ok(diag.dbSize > 0, 'db size readable')
console.log('⑤ 注入明细 ok:', diag.inject.total, 'token /', diag.inject.parts.length, '段; fails', diag.fails, '; db', Math.round(diag.dbSize / 1024), 'KB')

console.log('OPTIMIZE2 TESTS PASSED')
