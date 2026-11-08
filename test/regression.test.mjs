/**
 * regression 测试：本轮修补的四处缺口
 * ①pending 压缩块在进程崩溃后要标成 orphan ②会话级隔离键映射 ③事实键失效先于合并 ④面板压力回退
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { openDb, kvSet, now } from '../lib/db.js'
import { remember } from '../lib/memory.js'
import { resolveScope } from '../lib/companion.js'
import { acpStatus } from '../lib/acp.js'

const dir = mkdtempSync(join(tmpdir(), 'co-reg-'))
const path = join(dir, 'r.db')
const db = openDb(path)

// ① pending 块在下次打开时标成 orphan
db.prepare('insert into compressed_blocks (id, session_id, tier, child_refs, start_seq, end_seq, summary, created_at, status) values (?,?,?,?,?,?,?,?,?)')
  .run('bX', 's1', 1, '[]', 1, 2, '摘要', now() - 120000, 'pending')
const db2 = openDb(path)
assert.equal(db2.prepare("select status from compressed_blocks where id = 'bX'").get().status, 'orphan')
console.log('① orphan 标记 ok')

// ② 会话 → 隔离键映射
kvSet(db2, 'scope:session:sess-7', 'peer:alice')
assert.equal(resolveScope({ id: 'sess-7' }, null, { db: db2 }), 'peer:alice')
assert.equal(resolveScope({ id: 'nope' }, null, { db: db2 }), 'global')
assert.equal(resolveScope({ id: 'sess-7', header: { peer: 'bob' } }, null, { db: db2 }), 'peer:bob')
console.log('② 隔离键 ok')

// ③ 事实键：新值让旧值失效（先失效，再考虑合并）
const a = remember(db2, 'fact', { content: '我住在北京朝阳', scope: 'peer:alice' })
const b = remember(db2, 'fact', { content: '我搬到杭州西湖区了', scope: 'peer:alice' })
assert.equal(b.superseded.length, 1, 'old home fact should be superseded')
assert.equal(b.superseded[0], a.id)
const old = db2.prepare('select * from memory_fact where id = ?').get(a.id)
assert.ok(old.invalid_at, 'old fact marked invalid')
assert.equal(old.superseded_by, b.id)
console.log('③ 事实失效链 ok')

// ④ 面板拿不到 live session 时，压力回退到 session_state
db2.prepare('insert into session_state (session_id, scope, mood, mood_level, pressure, user_msgs, last_user, updated_at) values (?,?,?,?,?,?,?,?)')
  .run('sess-7', 'peer:alice', '平稳', 0, 42.5, 3, '你好', now())
const status = acpStatus({ db: db2, session: null, windowTokens: 100000, sessionId: 'sess-7' })
assert.equal(status.pressure, 42.5)
assert.equal(status.source, 'session_state')
console.log('④ 压力回退 ok', status.historyTokens, 'tokens')

console.log('REGRESSION TESTS PASSED')
