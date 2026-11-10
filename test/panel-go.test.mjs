/**
 * dsh-go 原生面板烟测：用假的 dshGo 跑 apply()，
 * 确认「陪伴速览」面板与状态条真的能取到数据、视图引用都有值、不抛异常。
 * （网页面板有 client/host 测试，这块之前没人测过。）
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const dir = mkdtempSync(join(tmpdir(), 'co-go-'))
const dbFile = join(dir, 'go.db')

const panels = new Map()
const strips = new Map()
const handlers = new Map()

const dshGo = {
  panel: (id, def) => { panels.set(id, def) },
  strip: (id, fn) => { strips.set(id, fn) },
}
const ctx = {
  logger: { warn: () => {}, info: () => {} },
  effect: (fn) => { const d = fn(); return () => { if (typeof d === 'function') d() } },
  on: (evt, cb) => { const arr = handlers.get(evt) || []; arr.push(cb); handlers.set(evt, arr); return () => {} },
  inject: (names, cb) => { if (names.includes('dshGo') && !ctx.dshGo) return; cb(ctx) },
  tools: { register: () => {} },
  systemPrompt: { section: (s) => { void s; return () => {} } },
  get: () => ({ register: () => () => {} }),
  dshGo,
}

const { apply } = await import('../index.js')
const { openDb } = await import('../lib/db.js')
const { addHeartVoice } = await import('../lib/mood.js')
const { addFollowUp } = await import('../lib/companion.js')
apply(ctx, { dbPath: dbFile })
const db = openDb(dbFile)

assert.ok(panels.has('mood'), 'dsh-go panel mood registered')
assert.ok(strips.has('moodstrip'), 'dsh-go strip registered')

// 造一个会话状态 + 心声 + 惦记
db.prepare('insert into session_state (session_id, scope, mood, mood_level, mood_why, user_state, user_valence, pressure, user_msgs, last_user, updated_at) values (?,?,?,?,?,?,?,?,?,?,?)')
  .run('sess-go', 'global', '着急', 0, '主人是真生气了，先把事做完', '在发火', -0.8, 62.5, 7, '自检', Date.now())
addHeartVoice(db, { sessionId: 'sess-go', scope: 'global', content: '主人急，我不辩解，先把事办完。', mood: '着急', source: 'model' })
addFollowUp(db, { scope: 'global', content: '主人的插件要自检完', dueAt: Date.now() + 3600000, size: 'big' })

// 视图结构：引用的每个 data.xxx 都要有值
const def = panels.get('mood')
assert.equal(typeof def.view, 'function')
const view = def.view()
assert.equal(view.type, 'stack')
const refs = new Set()
const walk = (node) => {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) return node.forEach(walk)
  if (typeof node.$ === 'string' && node.$.startsWith('data.')) refs.add(node.$.slice(5))
  for (const v of Object.values(node)) walk(v)
}
walk(view)

let data = null
const stop = def.data({ sessionId: 'sess-go' }, (d) => { data = d })
if (typeof stop === 'function') stop()
console.log('panel data:', JSON.stringify(data))
assert.ok(data, 'panel data emitted')
assert.equal(data.mood, '着急')
assert.equal(data.userState, '在发火')
assert.equal(data.pressure, 63)
for (const key of refs) {
  assert.ok(data[key] !== undefined && data[key] !== null, 'view refs missing data key: ' + key)
}

// 状态条：一句心情 + 百分比
let stripData = null
const stopStrip = strips.get('moodstrip')({ sessionId: 'sess-go' }, (d) => { stripData = d })
if (typeof stopStrip === 'function') stopStrip()
console.log('strip:', JSON.stringify(stripData))
assert.ok(stripData && stripData.text.includes('着急'))
assert.ok(stripData.text.includes('63%'))

// 没有会话记录时也不能崩
let fallbackData = null
const stop2 = def.data({}, (d) => { fallbackData = d })
if (typeof stop2 === 'function') stop2()
assert.ok(fallbackData && fallbackData.mood, 'panel works without session state')
console.log('fallback mood:', fallbackData.mood)

console.log('PANEL-GO TESTS PASSED')
