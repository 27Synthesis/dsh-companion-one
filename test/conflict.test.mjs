/**
 * conflict 测试：模拟宿主里已经有别的 ACP 提供方（billion-context），
 * 验证 companion-one 让位：不注册 compress/decompress/search_context/acp_status，
 * 只留记忆/陪伴/人格工具；以及注册抛 "already registered" 时的兜底不炸。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const dir = mkdtempSync(join(tmpdir(), 'co-conflict-'))

async function boot(existing, opts = {}) {
  const url = new URL('../index.js', import.meta.url).href + '?boot=' + Math.random()
  const { apply } = await import(url)
  const registered = new Map()
  const ctx = {
    logger: { warn: () => {}, info: () => {} },
    effect: (fn) => { const d = fn(); return () => { if (typeof d === 'function') d() } },
    on: () => () => {},
    inject: (names, cb) => cb(ctx),
    tools: {
      get: (n) => (existing.includes(n) ? { name: n } : undefined),
      register: (t) => {
        if (registered.has(t.name)) throw new Error('tool "' + t.name + '" is already registered')
        registered.set(t.name, t)
      },
    },
    systemPrompt: { section: () => () => {} },
    get: () => undefined,
  }
  apply(ctx, { dbPath: join(dir, 'x.db'), ...opts })
  return registered
}

// 1) 有别的 ACP：四件套让位
const withAcp = await boot(['compress', 'decompress', 'search_context', 'acp_status', 'acp_cache'])
const names = [...withAcp.keys()]
console.log('with foreign ACP ->', names.join(','))
for (const n of ['compress', 'decompress', 'search_context', 'acp_status']) {
  assert.ok(!names.includes(n), 'should yield ' + n)
}
assert.ok(names.includes('memory_add') && names.includes('persona') && names.includes('followup'))
assert.equal(names.length, 9)

// 2) force 覆盖：仍然注册（用于单独使用 companion-one 的压缩）
const forced = await boot(['compress'], { compression: 'force' })
console.log('forced ->', [...forced.keys()].join(','))
assert.ok([...forced.keys()].includes('co_compress'), 'forced mode registers with co_ prefix')

// 3) 没有冲突：12 个工具全注册
const clean = await boot([])
console.log('clean ->', clean.size, 'tools')
assert.equal(clean.size, 13)

console.log('CONFLICT TESTS PASSED')
