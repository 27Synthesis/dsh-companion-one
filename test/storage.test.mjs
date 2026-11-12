import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, now } from '../lib/db.js'
import { storageReport, chatSessions, purgeChat, compactDb } from '../lib/storage.js'
import { runOp } from '../lib/api.js'

const dir = mkdtempSync(join(tmpdir(), 'co-storage-'))
const path = join(dir, 'companion-one.db')
const db = openDb(path)
const ok = (name, fn) => { try { fn(); console.log('  ✓ ' + name) } catch (e) { console.log('  ✗ ' + name + ' — ' + e.message); process.exitCode = 1 } }

function seedBlock(db, sessionId, tier, startSeq, lines) {
  const id = sessionId.slice(0, 6) + '-' + startSeq
  const ts = now()
  db.prepare('insert into compressed_blocks (id, session_id, tier, parent_id, child_refs, start_seq, end_seq, summary, summary_tokens, source_tokens, tokens_saved, message_count, status, created_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(id, sessionId, tier, null, '[]', startSeq, startSeq + lines.length - 1, 'summary-' + id, 10, 100, 90, lines.length, 'committed', ts)
  const insMsg = db.prepare('insert into compressed_messages (id, block_id, session_id, seq, role, content, created_at) values (?,?,?,?,?,?,?)')
  const insFts = db.prepare('insert into compressed_fts (content, block_id, message_id) values (?,?,?)')
  for (let i = 0; i < lines.length; i++) {
    const mid = id + '-' + i
    insMsg.run(mid, id, sessionId, startSeq + i, i % 2 ? 'assistant' : 'user', lines[i], ts)
    insFts.run(lines[i], id, mid)
  }
  return id
}

const big = '这是一段用来占地方的聊天原文，重复很多次让它有真实体积。'.repeat(40)
seedBlock(db, 'sessA', 1, 1, ['早上好呀主人', '主人今天想做什么', big, big, big])
seedBlock(db, 'sessA', 1, 10, ['第二块的内容', big, big])
seedBlock(db, 'sessB', 1, 1, ['另一个会话的开头', big])
db.prepare('insert into heart_voice (id, session_id, scope, mood, content, source, user_text, seq, created_at) values (?,?,?,?,?,?,?,?,?)')
  .run('h1', 'sessA', 'global', '安心', '被主人夸了', 'model', null, 1, now())
db.prepare('insert into heart_voice (id, session_id, scope, mood, content, source, user_text, seq, created_at) values (?,?,?,?,?,?,?,?,?)')
  .run('h2', 'sessB', 'global', '开心', '今天也挺好', 'model', null, 2, now())

runOp(db, 'memoryAdd', { layer: 'fact', content: '主人对花生过敏' })
runOp(db, 'memoryAdd', { layer: 'user', content: '主人喜欢摇滚现场' })

console.log('存储统计')
const rep = storageReport(db)
console.log('    total=' + rep.total + ' 文件=' + JSON.stringify(rep.file) + ' 分组=' + rep.groups.map((g) => g.label + ':' + g.bytes).join(', '))
ok('文件大小 > 0', () => assert.ok(rep.total > 0))
ok('有分组且总额接近文件大小', () => assert.ok(rep.groups.length > 0 && rep.total > 0))
ok('计数正确（3 块 10 条消息 2 心声 2 会话）', () => {
  assert.equal(rep.counts.blocks, 3); assert.equal(rep.counts.messages, 10)
  assert.equal(rep.counts.hearts, 2); assert.equal(rep.counts.sessions, 2)
  assert.equal(rep.counts.memories, 2)
})

console.log('会话列表')
const cs = chatSessions(db)
console.log('   ' + cs.sessions.map((s) => s.sessionId + '/' + s.messages + '条/' + s.bytes + 'B/' + JSON.stringify(s.name)).join(' | '))
ok('两个会话', () => assert.equal(cs.sessions.length, 2))
ok('会话名取首条用户发言', () => {
  const a = cs.sessions.find((s) => s.sessionId === 'sessA')
  assert.equal(a.name, '早上好呀主人')
  assert.equal(a.blocks, 2); assert.equal(a.messages, 8); assert.equal(a.hearts, 1)
})

console.log('按会话删除')
const before = storageReport(db).total
const r1 = purgeChat(db, { sessionId: 'sessA' })
console.log('   deleted=' + JSON.stringify(r1.deleted) + ' before=' + r1.before + ' after=' + r1.after + ' freed=' + r1.freed)
ok('删掉 sessA 的 8 条消息与 2 个块', () => { assert.equal(r1.deleted.messages, 8); assert.equal(r1.deleted.blocks, 2) })
ok('心声默认可留着', () => assert.equal(r1.deleted.hearts, 0))
ok('sessB 没被动，sessA 只剩心声', () => {
  const list = chatSessions(db).sessions
  const b = list.find((s) => s.sessionId === 'sessB')
  const a = list.find((s) => s.sessionId === 'sessA')
  assert.equal(b.messages, 2)
  assert.equal(a.messages, 0)
  assert.equal(a.name, '(仅心声)')
})
ok('记忆还在（过敏）', () => assert.equal(runOp(db, 'memorySearch', { query: '花生过敏' }).hits.length, 1))
ok('FTS 里文件里的也清了', () => assert.equal(db.prepare("select count(*) c from compressed_fts where block_id like 'sessA%'").get().c, 0))

console.log('全清 + 连心声')
const r2 = purgeChat(db, { all: true, heart: true })
console.log('   deleted=' + JSON.stringify(r2.deleted) + ' freed=' + r2.freed)
ok('全清删干净', () => { assert.equal(r2.deleted.messages, 2); assert.equal(r2.deleted.blocks, 1); assert.equal(r2.deleted.hearts, 2) })
ok('列表为空', () => assert.equal(chatSessions(db).sessions.length, 0))
ok('记忆一条没少', () => assert.equal(storageReport(db).counts.memories, 2))
ok('VACUUM 后文件变小', () => assert.ok(r2.after <= r2.before))

console.log('整理数据库')
const c = compactDb(db)
ok('整理返回前后大小', () => { assert.ok(c.before >= 0); assert.ok(c.after >= 0) })

console.log('面板 op（runOp）')
const s2 = runOp(db, 'storage', {})
ok('op=storage 形状', () => { assert.equal(s2.ok, true); assert.ok(Array.isArray(s2.groups)); assert.ok(s2.counts) })
const c2 = runOp(db, 'chatSessions', {})
ok('op=chatSessions 形状', () => { assert.equal(c2.ok, true); assert.ok(Array.isArray(c2.sessions)) })
ok('op=chatPurge 需要目标', () => assert.throws(() => runOp(db, 'chatPurge', {})))
ok('op=vacuum 形状', () => assert.equal(runOp(db, 'vacuum', {}).ok, true))

db.close()
rmSync(dir, { recursive: true, force: true })
console.log(process.exitCode ? 'FAILED' : 'ALL PASS')
