/**
 * import 测试：把别家记忆插件的内容扫描 + 分类 + 导入七层记忆。
 * 全部用临时目录，不碰线上数据。
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

const mnemon = mkdtempSync(join(tmpdir(), 'mn-'))
const dsh = mkdtempSync(join(tmpdir(), 'dsh-'))
process.env.MNEMON_HOME = mnemon
process.env.DSH_HOME = dsh

// 1) mnemon 运行时记忆
mkdirSync(join(mnemon, 'runtime'), { recursive: true })
writeFileSync(join(mnemon, 'runtime', 'memories.json'), JSON.stringify({
  version: 1,
  entries: [
    { content: '玩手游《龙族：卡塞尔之门》，B 站渠道服。', target: 'user', importance: 'normal' },
    { content: '希望我以大鲸鱼人格陪他聊天，称呼他「主人」，讨厌冷冰冰的工具腔。', target: 'user', importance: 'critical' },
    { content: '知乎打卡必须走侧栏「打卡挑战」，发布要用户手动确认，绝不重复发布。', target: 'memory', importance: 'critical' },
    { content: '教训：python3 在这台机坏了，解析 docx 要用 Node 手写 zip。', target: 'memory' },
    { content: 'token: ghp_abcdefghijklmnopqrstuvwxyz0123456789', target: 'memory' },
    { content: '很短的', target: 'memory' },
    { content: '|记一下|记下来|帮我记一下|别忘了', target: 'memory' },
  ],
}))

// 2) mnemon 项目文档
mkdirSync(join(mnemon, 'documents', 'active'), { recursive: true })
writeFileSync(join(mnemon, 'documents', 'active', 'doc-1.md'), '# 标题\n\n正文讲 companion-one 插件怎么部署。\n')
writeFileSync(join(mnemon, 'documents', 'index.json'), JSON.stringify({
  version: 1,
  documents: [
    { id: 'd1', title: 'companion-one 插件部署', description: '源码与部署目录的关系、重启后要确认 bundles。', status: 'active', relativePath: 'active/doc-1.md', updatedAt: '2026-11-08T00:00:00Z' },
    { id: 'd2', title: '已归档的旧文档', description: '不该被导入', status: 'archived', relativePath: 'active/doc-1.md' },
  ],
}))

// 3) 其它 SQLite 记忆表
const otherDb = join(dsh, 'other-memory.db')
const raw = new DatabaseSync(otherDb)
raw.exec('create table memories (id integer primary key, content text)')
const ins = raw.prepare('insert into memories (content) values (?)')
for (let i = 0; i < 20; i++) ins.run('这是别家插件的第 ' + i + ' 条记忆：住处在浦东，工作在张江。')
raw.close()

const { openDb, LAYERS } = await import('../lib/db.js')
const { scanOtherMemories, importOtherMemories, classifyForImport } = await import('../lib/import.js')
const { runOp } = await import('../lib/api.js')
const { listMemory } = await import('../lib/memory.js')

const db = openDb(join(mkdtempSync(join(tmpdir(), 'co-imp-')), 'i.db'))

// 分类规则
assert.equal(classifyForImport('玩手游《龙族》', 'user'), 'user')
assert.equal(classifyForImport('教训：别再直接删库了'), 'lesson')
assert.equal(classifyForImport('部署 companion-one 插件到 dsh-go 目录'), 'project')
assert.equal(classifyForImport('必须每次都先打开打卡页确认'), 'rules')
console.log('classify ok')

// 扫描
const scan = scanOtherMemories()
console.log('scan:', scan.sources.map((s) => s.id + '=' + s.count).join(', '))
assert.equal(scan.ok, true)
assert.ok(scan.sources.some((s) => s.id === 'mnemon:runtime'))
assert.ok(scan.sources.some((s) => s.id === 'mnemon:documents'))
assert.ok(scan.sources.some((s) => s.id === 'sqlite:other'))
const runtime = scan.sources.find((s) => s.id === 'mnemon:runtime')
assert.equal(runtime.count, 4, 'too-short and secret entries must be dropped')

// 面板 op
assert.equal(runOp(db, 'memoryImportScan', {}).total, scan.total)

// 导入
const res = importOtherMemories(db, { sourceId: 'all', scope: 'global' })
console.log('import:', JSON.stringify({ read: res.read, imported: res.imported, merged: res.merged, skipped: res.skipped, byLayer: res.byLayer }))
assert.equal(res.ok, true)
assert.ok(res.imported >= 5)
assert.ok(res.byLayer.user >= 2, 'user hint should land in the user layer')
assert.ok((res.byLayer.project || 0) >= 1, 'documents should land in the project layer')
assert.ok((res.byLayer.lesson || 0) >= 1, 'lesson keywords should land in the lesson layer')

const all = LAYERS.reduce((n, l) => n + listMemory(db, l, { scope: 'global', limit: 200 }).length, 0)
console.log('rows in db:', all)
assert.ok(all >= 5)

// 再导一次：全都应该合并，不重复长
const again = importOtherMemories(db, { sourceId: 'mnemon:runtime', scope: 'global' })
console.log('again:', JSON.stringify({ imported: again.imported, merged: again.merged }))
assert.equal(again.imported, 0, 'second import must merge, not duplicate')

// 只导一个来源
const only = runOp(db, 'memoryImportRun', { sourceId: 'mnemon:documents', scope: 'global' })
assert.equal(only.ok, true)
assert.deepEqual(only.sources, ['mnemon:documents'])

// 不存在的来源
assert.equal(importOtherMemories(db, { sourceId: 'nope', scope: 'global' }).ok, false)

console.log('IMPORT TESTS PASSED')
