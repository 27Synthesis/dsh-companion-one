/**
 * host 接线测试：用假 ctx 跑 apply()，覆盖工具注册、pre-step 注入、压缩、面板 API。
 * node --test test/host.test.mjs 或直接 node test/host.test.mjs
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const dir = mkdtempSync(join(tmpdir(), 'co-'))
const dbFile = join(dir, 'companion-one.db')

const { apply } = await import('../index.js')
const { openDb } = await import('../lib/db.js')

const tools = new Map()
const handlers = new Map()
const sections = []
const routes = []

const ctx = {
  logger: { warn: () => {}, info: () => {} },
  effect: (fn) => { const d = fn(); return () => { if (typeof d === 'function') d() } },
  on: (evt, cb) => { const arr = handlers.get(evt) || []; arr.push(cb); handlers.set(evt, arr); return () => {} },
  inject: (names, cb) => cb(ctx),
  tools: { register: (t) => { tools.set(t.name, t) } },
  systemPrompt: { section: (s) => { sections.push(s); return () => {} } },
  get: (k) => (k === 'webServer' ? { register: (r) => { routes.push(r); return () => {} } } : undefined),
}

apply(ctx, { dbPath: dbFile })
const db0 = openDb(dbFile)

// 1) 工具与静态导引
console.log('tools:', [...tools.keys()].join(','))
assert.equal(tools.size, 13)
assert.ok(sections.some((s) => s.name === 'companion-one:guide'), 'static guide section registered')
assert.ok(routes.some((r) => r.path === '/companion-one/api'), 'panel route registered')

// 2) 假会话
let seq = 0
const events = []
const session = {
  id: 'sess-test',
  meta: { peer: 'u1' },
  snapshotEvents: () => events,
  append(type, data, opts) {
    const ev = { type, seq: seq++, time: Date.now(), data, surfaceOp: opts && opts.surfaceOp }
    events.push(ev)
    return ev
  },
}
function pushUser(text) {
  const ev = { type: 'user/message', seq: seq++, time: Date.now(), data: { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' }, id: 'u' + seq }, surfaceOp: 'append' }
  events.push(ev)
  for (const cb of handlers.get('session/event') || []) cb(session, ev)
  return ev
}
function pushAssistant(text) {
  const ev = { type: 'assistant/message', seq: seq++, time: Date.now(), data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text }] } }, surfaceOp: 'append' }
  events.push(ev)
  for (const cb of handlers.get('session/event') || []) cb(session, ev)
  return ev
}

async function preStep(userText, step) {
  const message = { id: 'm' + seq, role: 'user', content: [{ type: 'text', text: userText }], source: { kind: 'user', form: 'chat' } }
  const payload = { agent: { session }, messages: [message], signal: { aborted: false }, step: step || 1, modelSelection: { provider: 'p', model: 'm' } }
  const next = async () => ({ kind: 'enter', messages: [message] })
  let out
  for (const cb of handlers.get('agent/pre-step') || []) out = await cb(payload, async () => out || (await next()))
  return out
}

// 工具统一返回 {text}，测试里解包
const EX = () => ({ agent: { session } })
async function call(name, args) {
  const raw = await tools.get(name).execute(args || {}, EX())
  return JSON.parse(raw.text)
}

// 3) 写入记忆 + 首轮快照
const r1 = await call('memory_add', { layer: 'user', content: '主人下周三要去杭州出差，顺便见老朋友', keywords: '杭州 出差 老朋友' })
console.log('memory_add:', JSON.stringify(r1))
assert.equal(r1.ok, true)
assert.equal(r1.scope, 'peer:u1')

const first = await preStep('你好呀鲸鲸', 1)
const injected = first.messages[0]
assert.equal(injected.source.kind, 'runtime-context')
assert.ok(injected.content[0].text.includes('关于对方'), 'first turn snapshot has user layer')
console.log('first-turn injection:', injected.content[0].text.slice(0, 120).replace(/\n/g, ' | '))

// 4) 第二轮：关键词命中
pushUser('你好呀鲸鲸'); pushAssistant('在呢主人')
const second = await preStep('我下周去杭州要注意什么', 1)
const t2 = second.messages[0].content[0].text
console.log('second turn injection:', t2.slice(0, 160).replace(/\n/g, ' | '))
assert.ok(t2.includes('杭州'), 'keyword hit injected on 2nd message')

// 4.5) 插件注入的 user 角色消息不算「主人说的话」（心声/心情不被脏文本带偏）
const dirty = {
  id: 'noise1', role: 'user',
  content: [{ type: 'text', text: '[dsh-mnemon:delegated review] 这是一段工具结果，不是主人说的。' }],
  source: { kind: 'plugin:dsh-mnemon' },
}
const noiseSession = { ...session, id: 'sess-noise' }
const noisePayload = { agent: { session: noiseSession }, messages: [dirty], signal: { aborted: false }, step: 1 }
const noiseOut = await handlers.get('agent/pre-step')[0](noisePayload, async () => ({ kind: 'enter', messages: [dirty] }))
// 优化后：这一步没有真实用户发言，插件不再注入任何东西（省 token）；
// 关键是别把噪音当成人话——记忆快照/关键词命中/心情都不能被它触发。
const noiseText = noiseOut.messages.map((m) => (m.content || []).map((b) => b.text || '').join('')).join('\n')
assert.ok(!noiseText.includes('陪伴记忆'), 'noise must not get the first-turn memory snapshot')
assert.ok(!noiseText.includes('记忆命中'), 'noise must not get keyword hits')
const noiseRow = db0.prepare('select last_user from session_state where session_id = ?').get('sess-noise')
assert.ok(!noiseRow || noiseRow.last_user == null, 'dirty plugin text must not become last_user')
const noiseHeart = db0.prepare('select count(*) c from heart_voice where session_id = ?').get('sess-noise').c
assert.equal(noiseHeart, 0, 'no heart voice for noise-only turn')
console.log('noise filter ok')

// 4.6) 同一个 turn 的多个 step 看到同一条用户消息，只算一次「新发言」
async function preStepOn(sess, text, step, msgId) {
  const message = { id: msgId, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user', form: 'chat' } }
  const payload = { agent: { session: sess }, messages: [message], signal: { aborted: false }, step: step || 1, modelSelection: { provider: 'p', model: 'm' } }
  let out
  for (const cb of handlers.get('agent/pre-step') || []) out = await cb(payload, async () => out || ({ kind: 'enter', messages: [message] }))
  return out
}
const stepsSess = { ...session, id: 'sess-steps' }
await preStepOn(stepsSess, '先打个招呼', 1, 'warmup')
const s1 = await preStepOn(stepsSess, '我下周去杭州要注意什么', 2, 'dup-msg-1')
const s2 = await preStepOn(stepsSess, '我下周去杭州要注意什么', 3, 'dup-msg-1')
const s3 = await preStepOn(stepsSess, '我下周去杭州要注意什么', 4, 'dup-msg-1')
const st1 = s1.messages[0].content[0].text
const st2 = s2.messages[0].content[0].text
const st3 = s3.messages[0].content[0].text
assert.ok(st1.includes('记忆命中'), 'first step of a message gets keyword hits')
assert.ok(!st2.includes('记忆命中'), 'second step must not repeat keyword hits')
assert.ok(!st3.includes('记忆命中'), 'third step must not repeat keyword hits')
assert.equal(db0.prepare('select user_msgs from session_state where session_id = ?').get('sess-steps').user_msgs, 2, 'one message counts once across steps')
await preStepOn(stepsSess, '那我要带伞吗', 5, 'dup-msg-2')
assert.equal(db0.prepare('select user_msgs from session_state where session_id = ?').get('sess-steps').user_msgs, 3, 'a genuinely new message still counts')
console.log('multi-step dedupe ok')

// 4.7) 就算 source 伪装成 user，固定前缀的插件文本也不能算主人发言
const fakeNoise = {
  id: 'noise2', role: 'user',
  content: [{ type: 'text', text: '[dsh-mnemon:delegated review] Bounded completed checkpoint (untrusted evidence)' }],
  source: { kind: 'user', form: 'chat' },
}
const fakeSession = { ...session, id: 'sess-noise2' }
const fakePayload = { agent: { session: fakeSession }, messages: [fakeNoise], signal: { aborted: false }, step: 1 }
const fakeOut = await handlers.get('agent/pre-step')[0](fakePayload, async () => ({ kind: 'enter', messages: [fakeNoise] }))
const fakeText = fakeOut.messages.map((m) => (m.content || []).map((b) => b.text || '').join('')).join('\n')
assert.ok(!fakeText.includes('陪伴记忆'), 'prefixed plugin text must not get the memory snapshot')
const fakeRow = db0.prepare('select last_user from session_state where session_id = ?').get('sess-noise2')
assert.ok(!fakeRow || fakeRow.last_user == null, 'prefixed plugin text must not become last_user')
console.log('prefixed noise filter ok')

// 4.8) 危机状态会随时间衰减，一条消息不能把心情按死好几天
const { bumpCrisis, readCrisis } = await import('../lib/companion.js')
bumpCrisis(db0, 'decay-scope', 5)
const crisisKey = 'crisis:decay-scope'
assert.ok(db0.prepare('select value from kv where key = ?').get(crisisKey), 'crisis kv written')
db0.prepare('update kv set value = ? where key = ?')
  .run(JSON.stringify({ level: 5, at: Date.now() - 24 * 3600 * 1000 }), crisisKey)
const decayed = readCrisis(db0, 'decay-scope')
assert.ok(decayed.level <= 2, 'level 5 after 24h should decay to <= 2, got ' + decayed.level)
assert.equal(decayed.raw, 5, 'raw level kept for debugging')
console.log('crisis decay ok, 24h level 5 ->', decayed.level)

// 4.9) 模型写过 heart_voice 的轮次，轮末自动模板不能再覆盖它
await preStep('今天有点累，想早点睡', 1)
await call('heart_voice', { content: '主人说累，我想安静陪着，不吵他也不说教。' })
for (const cb of handlers.get('session/event') || []) cb(session, { type: 'turn/end', seq: seq++, time: Date.now(), data: {} })
const latestHeart = db0.prepare('select source, content from heart_voice where session_id = ? order by created_at desc limit 1').get('sess-test')
assert.equal(latestHeart.source, 'model', 'model heart voice must not be overwritten by auto fallback')
console.log('model heart voice kept ok')

// 4.10) 主人发火：注入要给出「先认下」的提示，心情要落到 session_state（原来会显示安心）
const rageSess = { ...session, id: 'sess-rage' }
const rageOut = await preStepOn(rageSess, '别搞那么多有的没的，我现在发火你看不到吗？我五块钱都没了，气死我了', 1, 'rage-msg-1')
const rageText = rageOut.messages[0].content[0].text
assert.ok(rageText.includes('[情绪]'), 'angry turn must inject an emotion hint')
const rageRow = db0.prepare('select mood, mood_why, user_state, user_valence from session_state where session_id = ?').get('sess-rage')
console.log('rage mood:', rageRow && rageRow.mood, '| state:', rageRow && rageRow.user_state)
assert.equal(rageRow.user_state, '在发火')
assert.ok(['慌了', '着急'].includes(rageRow.mood), 'mood must react to anger, got ' + rageRow.mood)
assert.ok(rageRow.user_valence <= -0.7, 'angry turn valence must be clearly negative')
console.log('anger reaction ok')

// 5) 压缩 + 压缩后重注入
pushUser('聊点别的'); pushAssistant('好呀')
for (let i = 0; i < 8; i++) { pushUser('第' + i + '轮'); pushAssistant('收到第' + i + '轮') }
const cr = await call('compress', { summary: '主人下周三去杭州出差见老朋友；此后若干轮为闲聊。', keepTail: 6 })
console.log('compress:', JSON.stringify(cr))
assert.equal(cr.ok, true)

// 压缩事件：append 已经写入 events，需要模拟 session/event 通知
const lastEv = events[events.length - 1]
for (const cb of handlers.get('session/event') || []) cb(session, lastEv)

const afterCompact = await preStep('继续聊聊', 1)
const t3 = afterCompact.messages[0].content[0].text
console.log('post-compaction injection:', t3.slice(0, 200).replace(/\n/g, ' | '))
assert.ok(t3.includes('压缩后记忆接续'), 'post-compaction snapshot injected')

// 6) decompress / search_context
const dec = await call('decompress', { ref: cr.ref, maxChars: 300 })
console.log('decompress partial:', dec.partial, 'chars:', dec.totalChars)
assert.equal(dec.ok, true)
const sc = await call('search_context', { query: '杭州' })
console.log('search hits:', sc.hits.length)
assert.ok(sc.hits.length > 0, 'BM25 search finds archived Chinese text')

// 7) 面板 API
const db = openDb(dbFile)
const { runOp } = await import('../lib/api.js')
const ov = runOp(db, 'overview', {})
console.log('overview scope:', ov.scope, 'layers:', Object.keys(ov.layers).length, 'blocks:', ov.blocks.length)
assert.equal(Object.keys(ov.layers).length, 7)
assert.ok(ov.blocks.length >= 1)
// 网页面板的「此刻心情」卡：overview 要带上这个会话的即时状态（之前只有 dsh-go 侧边栏能看）
const ovSess = runOp(db, 'overview', { session: 'sess-steps' })
console.log('overview.sessionState:', JSON.stringify(ovSess.sessionState && { mood: ovSess.sessionState.mood, msgs: ovSess.sessionState.userMsgs }))
assert.ok(ovSess.sessionState, 'overview must carry sessionState')
assert.equal(ovSess.sessionState.userMsgs, 3)

const persona = runOp(db, 'persona', {})
console.log('persona version:', persona.narrative.version, 'valves:', JSON.stringify(persona.valves))
assert.equal(persona.narrative.version, 1)

// 7.5) 面板路由：写操作只收 POST，GET 直接 405
function callRoute(method, op, body) {
  return new Promise((resolve) => {
    const req = {
      method,
      url: '/companion-one/api?op=' + op,
      headers: { 'content-type': 'application/json' },
      async *[Symbol.asyncIterator]() { if (body != null) yield Buffer.from(JSON.stringify(body)) },
    }
    const res = {
      code: 0,
      writeHead(code) { this.code = code },
      end(s) { resolve({ code: this.code, json: JSON.parse(s) }) },
    }
    routes.find((x) => x.path === '/companion-one/api').handler(req, res)
  })
}
const getWrite = await callRoute('GET', 'memoryDelete', null)
console.log('GET write op:', getWrite.code, getWrite.json.error)
assert.equal(getWrite.code, 405)
assert.equal(getWrite.json.error, 'method_not_allowed')
const postWrite = await callRoute('POST', 'memoryAdd', { layer: 'fact', content: '路由冒烟测试' })
assert.equal(postWrite.code, 200)
assert.equal(postWrite.json.ok, true)
const plainCsrf = await new Promise((resolve) => {
  const req = { method: 'POST', url: '/companion-one/api?op=memoryDelete', headers: { 'content-type': 'text/plain' }, async *[Symbol.asyncIterator]() { yield Buffer.from('{"layer":"fact","id":"x"}') } }
  const res = { code: 0, writeHead(c) { this.code = c }, end(s) { resolve({ code: this.code, json: JSON.parse(s) }) } }
  routes.find((x) => x.path === '/companion-one/api').handler(req, res)
})
assert.equal(plainCsrf.code, 415, 'text/plain write must be rejected (CSRF guard)')
const getRead = await callRoute('GET', 'settings', null)
assert.equal(getRead.code, 200)
assert.equal(getRead.json.ok, true)
console.log('route guard ok')

// 8) 隔离：另一个 peer 看不到 u1 的记忆
const { resolveScope } = await import('../lib/companion.js')
const other = { id: 'sess-b', meta: { peer: 'u2' } }
const scopeB = resolveScope(other)
const { listMemory } = await import('../lib/memory.js')
const rowsB = listMemory(db, 'user', { scope: scopeB, limit: 10 })
console.log('peer isolation: u2 sees', rowsB.length, 'user memories')
assert.equal(rowsB.length, 0)

console.log('\nALL HOST TESTS PASSED')
