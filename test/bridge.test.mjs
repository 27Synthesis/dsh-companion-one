/**
 * 跨插件桥接（大肥鱼那边）烟测：只读解析、缺文件、相关性挑选、注入开关。
 * 全部用临时目录，绝不碰真的 ~/.dsh-fish 与 ~/.dsh/fish-memory。
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const dir = mkdtempSync(join(tmpdir(), 'co-bridge-'))
const fishHome = join(dir, 'fish')
const dshHome = join(dir, 'dsh')
mkdirSync(fishHome, { recursive: true })
mkdirSync(join(dshHome, 'fish-memory'), { recursive: true })

const day = (offset) => {
  const d = new Date(Date.now() + offset * 86400000)
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}

writeFileSync(join(fishHome, 'home.json'), JSON.stringify({ title: '跟大肥鱼说话', turns: 6, hearAt: 6, sessionId: 'fish-sess' }))
writeFileSync(join(fishHome, 'events.jsonl'), [
  JSON.stringify({ id: 'ev_1', ts: '2026-11-10T06:00:00.000Z', type: 'utterance', text: '我叫白舒，先记着。', refs: [], verdict: null, confidence: 0.5, flags: [] }),
  JSON.stringify({ id: 'ev_2', ts: '2026-11-10T06:01:00.000Z', type: 'meta', text: 'seen:x' }),
  'not json at all',
  JSON.stringify({ id: 'ev_3', ts: '2026-11-10T06:02:00.000Z', type: 'heard', text: '鱼粮还有吗', refs: [], verdict: null, confidence: 0.5, flags: [] }),
].join('\n'))
writeFileSync(join(fishHome, 'notes.json'), JSON.stringify([
  { id: 'note-1', text: '记得买鱼粮', due: day(1), created: '2026-11-10T06:00:00.000Z', status: 'open' },
  { id: 'note-2', text: '已经做完的事', due: '', created: '2026-11-09T06:00:00.000Z', status: 'done' },
  { id: 'note-3', text: '下个月再买滤芯', due: day(30), created: '2026-11-09T06:00:00.000Z', status: 'open' },
]))
writeFileSync(join(fishHome, 'appointments.json'), JSON.stringify([
  { id: 'ap-1', due: day(0), what: '一起看鱼缸', created: '2026-11-09T06:00:00.000Z', status: 'open' },
]))
writeFileSync(join(fishHome, 'talk-recent.json'), JSON.stringify({
  version: 2,
  buckets: { home: [{ at: '2026-11-10T06:48:05.853Z', me: '你叫什么名字？', her: '我没有名字，想出来了第一个告诉你。' }] },
}))
writeFileSync(join(dshHome, 'fish-memory', 'sess-bridge.json'), JSON.stringify({
  version: 2, purgeEpoch: '', policy: null, traces: [],
  deleted: [{ id: 'm-dead' }],
  memories: [
    { id: 'm-1', text: '主人怕吵，晚上放小声', at: '2026-11-10T06:00:00.000Z', category: 'stable_profile', importance: 1, tags: [] },
    { id: 'm-dead', text: '这条已经删了', at: '2026-11-10T05:00:00.000Z', category: 'event', importance: 0.5, tags: [] },
  ],
}))

const { fishRoot, home, events, notes, appts, recentTalk } = await import('../lib/fish.js')
const { memDir, memoriesOf, memMode } = await import('../lib/fishmem.js')
const { fishBlock, fishStatus, daysUntil } = await import('../lib/bridge.js')

const env = { DSH_FISH_HOME: fishHome, DSH_HOME: dshHome }
assert.equal(fishRoot(env), fishHome)
assert.equal(memDir(env), join(dshHome, 'fish-memory'))
assert.equal(memMode(env), 'session')

assert.equal(home({ env }).turns, 6)
// JSONL：坏行跳过、meta 过滤掉
const evs = events({ env })
assert.deepEqual(evs.map((e) => e.id), ['ev_1', 'ev_3'])
assert.equal(notes({ env }).length, 2, 'done 的便签不出现')
assert.equal(appts({ env }).length, 1)
assert.equal(recentTalk({ env })[0].her.startsWith('我没有名字'), true)

// 缺文件一律当空
const empty = join(dir, 'nope')
assert.deepEqual(notes({ env: { DSH_FISH_HOME: empty } }), [])
assert.deepEqual(events({ env: { DSH_FISH_HOME: empty } }), [])
assert.equal(home({ env: { DSH_FISH_HOME: empty } }), null)

// 记忆库：deleted 里的 id 当没这条
const mems = memoriesOf('sess-bridge', { env })
assert.equal(mems.length, 1)
assert.equal(mems[0].text, '主人怕吵，晚上放小声')
assert.deepEqual(memoriesOf('没有这个会话', { env }), [])

// 日期换算
assert.equal(daysUntil(day(0)), 0)
assert.equal(daysUntil(day(1)), 1)
assert.equal(daysUntil('不是日期'), null)

// 相关性：说鱼粮 → 便签；说看鱼缸 → 约；说怕吵 → 她的记忆
const b1 = fishBlock({ session: { id: 'sess-bridge' }, query: '鱼粮还有吗', env })
assert.ok(b1.includes('记得买鱼粮'), '相关便签要带上：' + b1)
assert.ok(b1.includes('只读'), '要交代这是另一边的记录')
const b2 = fishBlock({ session: { id: 'sess-bridge' }, query: '晚上好吵', env })
assert.ok(b2.includes('怕吵'), '相关记忆要带上：' + b2)
// 快到期的便签/今天该做的事：跟这句话不相关也要提一句（这就是桥接的意义）
const b3 = fishBlock({ session: { id: 'sess-bridge' }, query: '嗯', env })
assert.ok(b3.includes('记得买鱼粮'), '快到期的事要提：' + b3)
assert.ok(!b3.includes('滤芯'), '隔太远又无关的别塞进来：' + b3)
// 那边什么都没有：一个字都不占
assert.equal(fishBlock({ session: { id: 'sess-bridge' }, query: '鱼粮', env: { DSH_FISH_HOME: empty, DSH_HOME: dshHome } }), '')
// 预算真的生效
const tight = fishBlock({ session: { id: 'sess-bridge' }, query: '鱼粮 怕吵 鱼缸', budget: 8, env })
assert.ok(tight.length < b1.length + b2.length)

const st = fishStatus({ session: { id: 'sess-bridge' }, env })
assert.equal(st.on, true)
assert.equal(st.notes, 2)
assert.equal(st.appts, 1)
assert.equal(st.mems, 1)
assert.ok(st.line.includes('便签 2'))

/* ---------- 接进插件：注入与开关 ---------- */
process.env.DSH_FISH_HOME = fishHome
process.env.DSH_HOME = dshHome

const handlers = new Map()
const panels = new Map()
const dshGo = { panel: (id, def) => { panels.set(id, def) }, strip: () => {} }
const ctx = {
  logger: { warn: () => {}, info: () => {} },
  effect: (fn) => { const d = fn(); return () => { if (typeof d === 'function') d() } },
  on: (evt, cb) => { const arr = handlers.get(evt) || []; arr.push(cb); handlers.set(evt, arr); return () => {} },
  inject: (names, cb) => { if (names.includes('dshGo') && !ctx.dshGo) return; cb(ctx) },
  tools: { register: () => {} },
  systemPrompt: { section: () => () => {} },
  get: () => ({ register: () => () => {} }),
  dshGo,
}

const { apply } = await import('../index.js')
const { openDb, kvSet } = await import('../lib/db.js')
const { setSetting } = await import('../lib/api.js')
const dbFile = join(dir, 'bridge.db')
apply(ctx, { dbPath: dbFile })
const db = openDb(dbFile)

const preStep = async (text) => {
  const fn = handlers.get('agent/pre-step')[0]
  const payload = {
    agent: { session: { id: 'sess-bridge', snapshotEvents: [], append: () => {} } },
    messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }],
    signal: { aborted: false },
    step: 1,
  }
  const decision = await fn(payload, async () => ({ kind: 'enter', messages: payload.messages }))
  return (decision.messages || []).filter((m) => m.source && m.source.kind === 'runtime-context')
    .map((m) => (m.content || []).map((c) => c.text).join('')).join('\n')
}

const injected = await preStep('鱼粮还有吗')
assert.ok(injected.includes('鱼粮'), '插件注入里要带上那边的便签：' + injected.slice(0, 200))

// 开关关掉：整段不出现
setSetting(db, 'bridge', false)
const off = await preStep('鱼粮还有吗')
assert.ok(!off.includes('记得买鱼粮'), '关掉开关就不该带那边的便签')
setSetting(db, 'bridge', true)

// 面板能看到那一行
const def = panels.get('mood')
assert.ok(def, 'panel registered')
let data = null
const stop = def.data({ sessionId: 'sess-bridge' }, (d) => { data = d })
if (typeof stop === 'function') stop()
assert.ok(String(data.fish).includes('便签 2'), 'panel fish line: ' + data.fish)

console.log('PASSED bridge')