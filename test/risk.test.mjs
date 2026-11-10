/**
 * risk 测试：五条风险的修复验收
 * ①惦记额度按对话对象算 ②危机否定式不误判 ③二级块自动展开子摘要
 * ④检索兜底节流（不破坏召回）⑤面板路由拒绝跨站
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const dir = mkdtempSync(join(tmpdir(), 'co-risk-'))
const dbFile = join(dir, 'r.db')

const { openDb, now } = await import('../lib/db.js')
const { addFollowUp, pickDueFollowUp, markAsked, classify } = await import('../lib/companion.js')
const { decompressBlock } = await import('../lib/acp.js')
const { remember, searchMemory } = await import('../lib/memory.js')
const { apply } = await import('../index.js')

const db = openDb(dbFile)
const DAY = 86400000

// ① 额度按 scope：A 今天问过了，B 的额度不受影响
addFollowUp(db, { scope: 'peer:a', content: 'A 的事', dueAt: Date.now() - DAY })
addFollowUp(db, { scope: 'peer:b', content: 'B 的事', dueAt: Date.now() - DAY })
const firstA = pickDueFollowUp(db, 'peer:a', { userText: '在吗' })
assert.ok(firstA && firstA.content === 'A 的事')
markAsked(db, firstA.id)
assert.equal(pickDueFollowUp(db, 'peer:a', { userText: '在吗' }), null, 'A 今天额度用完了')
const firstB = pickDueFollowUp(db, 'peer:b', { userText: '在吗' })
assert.ok(firstB && firstB.content === 'B 的事', 'B 不该被 A 挤掉')
console.log('① 惦记额度按对象 ok')

// ② 危机：否定式与夸张说法不误判
assert.equal(classify('我不会想死的，别担心').level, 0)
assert.equal(classify('没想过自残').level, 0)
assert.equal(classify('想死的心都有了').level, 0, '夸张说法不按 4 级')
assert.ok(classify('我真的想死').level >= 4, '真表达要抓到')
assert.ok(classify('最近很焦虑，快撑不下去').level >= 2, '常见说法要能到 2 级')
console.log('② 危机否定式 ok')

// ③ 二级块：decompress 自动列出子摘要
const ins = db.prepare('insert into compressed_blocks (id, session_id, tier, child_refs, start_seq, end_seq, summary, summary_tokens, source_tokens, tokens_saved, message_count, status, created_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?)')
ins.run('c1', 's-risk', 1, '[]', 1, 2, '子块一：主人在杭州出差', 8, 50, 42, 2, 'committed', now() - 2000)
ins.run('c2', 's-risk', 1, '[]', 3, 4, '子块二：下周三见老朋友', 8, 50, 42, 2, 'committed', now() - 1000)
ins.run('t2', 's-risk', 2, JSON.stringify(['c1', 'c2']), 1, 4, '合并摘要', 10, 100, 90, 4, 'committed', now())
const d = decompressBlock(db, { ref: 't2' })
assert.equal(d.ok, true)
assert.ok(d.content.includes('主人在杭州出差') && d.content.includes('见老朋友'), 'should expand children summaries')
assert.ok(d.hint && d.hint.includes('children'), 'should tell how to get originals')
console.log('③ 二级块展开 ok')

// ④ 检索兜底：别名与关键词仍然召回
for (let i = 0; i < 30; i++) remember(db, 'fact', { content: '琐事' + i + '：今天吃了饭', scope: 'peer:z' })
remember(db, 'fact', { content: '住在杭州西湖区', scope: 'peer:z' })
const hits = searchMemory(db, '住址', { scope: 'peer:z', limit: 5 })
assert.ok(hits.some((r) => r.content.includes('杭州')), 'alias recall must survive throttling')
console.log('④ 检索节流后召回 ok:', hits.length, 'hits')

// ⑤ 面板路由：跨站请求被拒
const routes = []
const fakeCtx = {
  logger: { warn() {}, info() {} },
  effect: (fn) => { const off = fn(); return () => { if (typeof off === 'function') off() } },
  on: () => () => {},
  inject: (n, cb) => cb(fakeCtx),
  tools: { register: () => {} },
  systemPrompt: { section: () => () => {} },
  get: (k) => (k === 'webServer' ? { register: (r) => { routes.push(r); return () => {} } } : undefined),
  webServer: { register: (r) => { routes.push(r); return () => {} } },
}
apply(fakeCtx, { dbPath: dbFile })
const route = routes.find((r) => r.path === '/companion-one/api')
assert.ok(route, 'route registered')

function call(headers) {
  return new Promise((resolve) => {
    const res = { code: 0, body: '', writeHead(c) { this.code = c }, end(b) { this.body = String(b || ''); resolve(this) } }
    route.handler({ method: 'GET', url: '/companion-one/api?op=settings', headers }, res)
  })
}
const bad = await call({ host: '127.0.0.1:3080', origin: 'https://evil.example' })
assert.equal(bad.code, 403, 'cross-origin must be rejected')
const cross = await call({ host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' })
assert.equal(cross.code, 403)
const okRes = await call({ host: '127.0.0.1:3080' })
assert.equal(okRes.code, 200, 'same-origin must pass')
console.log('⑤ 同源校验 ok')

console.log('RISK TESTS PASSED')
