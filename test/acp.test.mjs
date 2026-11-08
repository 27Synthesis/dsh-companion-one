import { openDb } from '../lib/db.js'
import { computeSurface, selectRange, compressSession, decompressBlock, searchContext, acpStatus } from '../lib/acp.js'

let seq = 0
const events = []
function push(type, data) {
  const ev = { type, seq: seq++, time: Date.now(), data, surfaceOp: 'append' }
  events.push(ev)
  return ev
}
push('system/message', { message: { role: 'system', content: [{ type: 'text', text: '你是鲸鲸。'.repeat(50) }] } })
push('user/message', { role: 'user', content: [{ type: 'text', text: '主人说他下周三要去杭州出差，顺便见一个老朋友。' }], source: { kind: 'user' } })
push('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: '好呀，我记下来了，下周三杭州出差，主人要见哪位老朋友呀？' }] } })
for (let i = 0; i < 12; i++) {
  push('user/message', { role: 'user', content: [{ type: 'text', text: '第 ' + i + ' 轮闲聊：今天天气不错，鲸鲸在喷水。' + '哼'.repeat(30) }], source: { kind: 'user' } })
  push('assistant/message', { message: { role: 'assistant', content: [{ type: 'text', text: '第 ' + i + ' 轮回复：主人今天也要开心哦，我陪你。' + '喵'.repeat(30) }] } })
}

const fakeSession = {
  id: 'test-session',
  snapshotEvents: () => events,
  append(type, data, opts) {
    const ev = { type, seq: seq++, time: Date.now(), data, surfaceOp: opts.surfaceOp }
    events.push(ev)
    return ev
  },
}

const db = openDb('/tmp/co-acp.db')
const nodes = computeSurface(events)
console.log('surface nodes', nodes.length, 'events', events.length)
const range = selectRange(events, nodes, { keepTail: 8 })
console.log('range', range)

const res = compressSession({ db, session: fakeSession, summary: '【压缩摘要·tier1】主人下周三要去杭州出差并顺路见老朋友；此后若干轮为日常闲聊（天气、陪伴）。', keepTail: 8, sessionId: 'test-session' })
console.log('compress', res)
console.log('surface after', computeSurface(events).length, 'events', events.length)
const dm = { ok: true }
const dec = decompressBlock(db, { ref: res.ref, maxChars: 400 })
console.log('decompress partial', dec.partial, 'total', dec.totalChars, 'next', dec.nextOffset)
console.log('head:', dec.content.slice(0, 120).replace(/\n/g, ' '))
const sr = searchContext(db, { query: '杭州' })
console.log('search hits', sr.hits.length, sr.hits[0] && sr.hits[0].snippet)
const st = acpStatus({ db, session: fakeSession, windowTokens: 128000, sessionId: 'test-session' })
console.log('status pressure', st.pressure, 'blocks', st.blocks.length, 'compressible', !!st.compressible)
