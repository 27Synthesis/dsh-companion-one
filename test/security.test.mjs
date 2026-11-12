/**
 * security 测试：本轮安全自审的修复验收
 * ①DNS rebinding（Host 不是回环/字面 IP 一律拒）
 * ②记忆层名白名单（getMemory 不能拼标识符）
 * ③面板参数 limit 夹取（负数不能让 SQLite 变成不限制）
 * ④setScope 限长、拒控制字符
 * ⑤import 文档相对路径不许逃出 documents 根目录
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const dir = mkdtempSync(join(tmpdir(), 'co-sec-'))
const dbFile = join(dir, 's.db')

const { openDb, getMemory } = await import('../lib/db.js')
const { runOp } = await import('../lib/api.js')
const { apply } = await import('../index.js')

const db = openDb(dbFile)

// ① Host 校验：DNS rebinding 特征（Origin 与 Host 一致但不是 IP）
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
const rebind = await call({ host: 'evil.example:3080', origin: 'http://evil.example:3080' })
assert.equal(rebind.code, 403, 'rebinding host must be rejected')
assert.ok(rebind.body.includes('bad_host'), 'reason should say bad_host')
const loop = await call({ host: '127.0.0.1:3080' })
assert.equal(loop.code, 200, 'loopback host ok')
const lan = await call({ host: '192.168.1.5:3080' })
assert.equal(lan.code, 200, 'literal ip host ok')
const localhost = await call({ host: 'localhost:3080' })
assert.equal(localhost.code, 200, 'localhost ok')
console.log('① Host 校验 ok')

// ② 层名白名单
assert.throws(() => getMemory(db, 'fact where 1=1 --', 'x'), /unknown memory layer/)
assert.throws(() => runOp(db, 'memoryDelete', { layer: 'fact; drop table memory_fact', id: 'x' }), /unknown memory layer/)
assert.equal(getMemory(db, 'fact', 'nope'), null)
console.log('② 层名白名单 ok')

// ③ limit 夹取
assert.ok(Array.isArray(runOp(db, 'blocks', { limit: '-1' }).blocks), 'negative limit still returns a list')
assert.ok(Array.isArray(runOp(db, 'blocks', { limit: '99999' }).blocks))
assert.ok(Array.isArray(runOp(db, 'memories', { layer: 'fact', limit: '-5' }).rows))
console.log('③ limit 夹取 ok')

// ④ setScope 限长
assert.throws(() => runOp(db, 'setScope', { sessionId: 's1', scope: 'x'.repeat(300) }), /too long/)
assert.throws(() => runOp(db, 'setScope', { sessionId: 'y'.repeat(300), scope: 'peer:a' }), /too long/)
assert.throws(() => runOp(db, 'setScope', { sessionId: 's1', scope: 'peer:a' + String.fromCharCode(0) + 'b' }), /bad scope/)
assert.equal(runOp(db, 'setScope', { sessionId: 's-sec', scope: 'peer:测试' }).ok, true)
console.log('④ setScope ok')

// ⑤ import 路径逃逸：index.json 指向 documents 外的文件，正文不许被带进来
const mhome = join(dir, 'mnemon')
mkdirSync(join(mhome, 'documents', 'active'), { recursive: true })
writeFileSync(join(dir, 'secret.txt'), 'LEAKED_SECRET_令牌内容')
writeFileSync(join(mhome, 'documents', 'index.json'), JSON.stringify({
  documents: [
    { title: '正常文档', relativePath: 'active/ok.md', status: 'active' },
    { title: '逃逸文档', relativePath: '../secret.txt', status: 'active' },
  ],
}))
writeFileSync(join(mhome, 'documents', 'active', 'ok.md'), '# 标题\n正常正文内容')
process.env.MNEMON_HOME = mhome
process.env.DSH_HOME = join(dir, 'dsh-empty')
const { scanOtherMemories } = await import('../lib/import.js')
const scanned = scanOtherMemories()
assert.ok(!JSON.stringify(scanned).includes('LEAKED_SECRET'), 'must not leak content outside documents root')
console.log('⑤ import 路径包含 ok')

console.log('SECURITY TESTS PASSED')
