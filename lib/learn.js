/**
 * companion-one / lib/learn.js — 面板里的「学习」入口。
 *
 * 把 fishtalk（MIT，github.com/Nozzi2455/fishtalk）当可选依赖用：
 * 找到它的安装位置就复用它的 store / distill / sites 模块，找不到就诚实报错，
 * 绝不让 companion-one 因为对方缺席而崩。
 *
 * 两件事：
 *   1) feedCorpus  投喂语料（聊天记录、帖子），一行一条，写进 fishtalk 的语料库并重新蒸馏。
 *   2) startLearn  B 站联网学习：后台跑，状态写 kv，面板轮询进度。
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { now, kvGet, kvSet } from './db.js'

const require = createRequire(import.meta.url)

let cached
function candidates() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const out = []
  if (process.env.DSH_PROFILE_DIR) out.push(join(process.env.DSH_PROFILE_DIR, 'node_modules', 'fishtalk'))
  out.push(join(home, 'profiles', 'web', 'node_modules', 'fishtalk'))
  out.push(join(home, 'dsh-go', 'plugins', 'fishtalk'))
  return out.filter(Boolean)
}

/** 找到 fishtalk 就返回 { root, store, distill, sites }，否则 null。 */
export function fishtalk() {
  if (cached !== undefined) return cached || null
  for (const root of candidates()) {
    try {
      if (!existsSync(join(root, 'lib', 'store.js'))) continue
      const store = require(join(root, 'lib', 'store.js'))
      const distill = require(join(root, 'lib', 'distill.js'))
      cached = { root, store, distill, sites: (s) => require(join(root, 'lib', 'sites', String(s) + '.js')) }
      return cached
    } catch { /* 换下一个候选 */ }
  }
  cached = false
  return null
}

export function stats() {
  const ft = fishtalk()
  if (!ft) return { ok: false, reason: 'fishtalk_missing', hint: '没找到 fishtalk 插件，先在 profile 里装上它' }
  let items = []
  try { items = ft.store.all() } catch {}
  let pack = null
  try { pack = JSON.parse(readFileSync(ft.store.P.pack, 'utf8')) } catch {}
  const scenes = pack && pack.scenes ? Object.keys(pack.scenes) : []
  return {
    ok: true,
    total: items.length,
    human: pack ? pack.counts.human : 0,
    fish: pack ? pack.counts.fish : 0,
    scenes: scenes.length,
    sceneNames: scenes.slice(0, 8),
    home: ft.store.P.home,
    packAt: pack ? (pack.made || pack.at || null) : null,
  }
}

/* ---------------- 文风包：让学到的口气真正进 ⑤ 区 ---------------- */
let packMemo = { at: 0, home: '', data: null }
const PACK_TTL = 60 * 1000
const invalidatePack = () => { packMemo = { at: 0, home: '', data: null } }

/** 读 fishtalk 的文风包（60 秒缓存：注入路径上每一步都会来问一次）。 */
function readPack(ft) {
  const home = String(ft.store.P.home || '')
  if (packMemo.data && Date.now() - packMemo.at < PACK_TTL && packMemo.home === home) return packMemo.data
  let data = null
  try { data = JSON.parse(readFileSync(ft.store.P.pack, 'utf8')) } catch {}
  packMemo = { at: Date.now(), home, data }
  return data
}

const busiest = (pack, names) => names.sort((a, b) => (Number(pack.scenes[b].count) || 0) - (Number(pack.scenes[a].count) || 0))[0]
const PUBLIC_SCENE = /B站|评论|公开|贴吧|微博|知乎|弹幕/
const CHAT_SCENE = /聊天|微信|QQ|私聊|群聊|群/i

/**
 * 挑一个场合，返回 { name, borrowed }：
 * - 指定了名字就按名字匹配（精确 → 子串）；
 * - 公开场合优先找公开语料（B站/评论…），找不到就用最大的一场；
 * - 私聊优先聊天语料（QQ/微信…）；没有聊天语料时借用最大的一场，但标记 borrowed，
 *   让模型只借句式口癖、别把评论区的话题和立场搬进私聊。
 */
function pickScene(pack, opts) {
  const o = opts || {}
  const names = Object.keys(pack.scenes || {})
  if (!names.length) return null
  const want = String(o.scene || '').trim()
  if (want) {
    const hit = names.find((n) => n === want) || names.find((n) => n.includes(want) || want.includes(n))
    if (hit) return { name: hit, borrowed: false }
  }
  if (o.publicScene) {
    const pub = names.filter((n) => PUBLIC_SCENE.test(n))
    return { name: pub.length ? busiest(pack, pub) : busiest(pack, names), borrowed: false }
  }
  const chat = names.filter((n) => CHAT_SCENE.test(n))
  if (chat.length) return { name: busiest(pack, chat), borrowed: false }
  return { name: busiest(pack, names), borrowed: true }
}

/**
 * ⑤ 区用的口气摘要（≤160 字）：只讲形状，不抄原句。
 * 语料太少或没有统计字段时返回 ''（宁可不注入，也不塞空话）。
 */
export function packBrief(opts) {
  const o = opts || {}
  const ft = fishtalk()
  if (!ft) return ''
  const pack = readPack(ft)
  if (!pack || !pack.scenes) return ''
  const pick = pickScene(pack, o)
  if (!pick) return ''
  const name = pick.name
  const sc = pack.scenes[name] || {}
  const len = sc.length || {}
  const bits = []
  if (len.median) bits.push('句长中位 ' + len.median + ' 字')
  if (Number(sc.noEndPunctRatio) >= 0.45) bits.push('多数句尾不点标点')
  const tail = (sc.particles || []).slice(0, 3).map((x) => x[0]).join('')
  if (tail) bits.push('爱带「' + tail + '」')
  const heads = (sc.openings || []).slice(0, 2).map((x) => x[0]).filter(Boolean)
  if (heads.length) bits.push('常以「' + heads.join('」「') + '」起头')
  if (!bits.length) return ''
  const short = name.length > 16 ? name.slice(0, 15) + '…' : name
  let text = '[说话手感] 场合「' + short + '」（' + (sc.count || 0) + ' 条真人）：' + bits.join('；') + '。学这个手感，别照抄原句。'
  if (o.publicScene) text += ' 这是公开发言，收着点。'
  else if (pick.borrowed) text += '（公开语料：只借句式和口癖，别搬话题和立场。）'
  return text.length > 170 ? text.slice(0, 168) + '…' : text
}

/** 面板「学习」页：语料/场合概览 + 当前 ⑤ 区会读到的那句。 */
export function packInfo(opts) {
  const ft = fishtalk()
  if (!ft) return { ok: false, reason: 'fishtalk_missing' }
  const pack = readPack(ft)
  if (!pack || !pack.scenes) return { ok: true, scenes: [], brief: '', counts: { total: 0, human: 0, fish: 0 }, made: null }
  const scenes = Object.keys(pack.scenes)
    .map((n) => ({ name: n, count: Number(pack.scenes[n].count) || 0, median: Number((pack.scenes[n].length || {}).median) || 0 }))
    .sort((a, b) => b.count - a.count)
  return { ok: true, counts: pack.counts || {}, made: pack.made || null, scenes: scenes.slice(0, 12), brief: packBrief({ ...(opts || {}), publicScene: true }), chatBrief: packBrief({ ...(opts || {}), publicScene: false }) }
}

/** 投喂语料：一行一条。返回读入/新增条数与蒸馏结果。 */
export function feedCorpus(db, { lines, where, source, scene }) {
  const ft = fishtalk()
  if (!ft) return { ok: false, reason: 'fishtalk_missing' }
  const list = (Array.isArray(lines) ? lines : String(lines || '').split(/\n+/))
    .map((s) => String(s || '').trim())
    .filter((s) => s.length >= 2)
  if (!list.length) return { ok: false, reason: 'empty', hint: '至少贴一行真人说的话' }
  const day = new Date().toISOString().slice(0, 10)
  const items = list.map((text) => ({
    text, source: source || 'text', where: where || '面板投喂', kind: 'line', day,
    ...(scene ? { scene: String(scene) } : {}),
  }))
  let added = 0
  try { added = ft.store.add(items) } catch (err) { return { ok: false, reason: 'store_failed', detail: String(err && err.message || err) } }
  let pack = null
  if (added) {
    try { pack = ft.distill.run() } catch (err) { return { ok: false, reason: 'distill_failed', detail: String(err && err.message || err), added } }
    invalidatePack()
  }
  const out = { ok: true, read: items.length, added, human: pack ? pack.counts.human : 0, fish: pack ? pack.counts.fish : 0 }
  kvSet(db, 'ft:lastFeed', { at: now(), ...out })
  return out
}

export function learnStatus(db) {
  return kvGet(db, 'ft:job', { state: 'idle' })
}

/** 当前进程里正在跑的任务。取消必须改到「同一个对象」，否则循环看不到 cancelled。 */
let activeJob = null
let activeDb = null

/** 启动 B 站学习（后台跑）。limit 收 1..10，默认 3。 */
export function startLearn(db, { site, target, limit }) {
  const ft = fishtalk()
  if (!ft) return { ok: false, reason: 'fishtalk_missing' }
  const cur = learnStatus(db)
  // 引擎重启会让「running」卡住：超过 30 分钟就当僵尸任务，允许重新开始
  if (cur && cur.state === 'running' && Date.now() - Number(cur.startedAt || 0) < 30 * 60 * 1000) {
    return { ok: false, reason: 'busy', job: cur }
  }
  const s = site === 'tieba' ? 'tieba' : 'bili'
  const t = String(target || '').trim()
  if (!t) return { ok: false, reason: 'target_required', hint: '填分区名（如 知识区）或 搜:关键词' }
  const n = Math.min(10, Math.max(1, Number(limit) || 3))
  const job = { state: 'running', site: s, target: t, limit: n, startedAt: now(), found: 0, read: 0, added: 0, log: [] }
  activeJob = job
  activeDb = db
  kvSet(db, 'ft:job', job)
  const save = () => { try { kvSet(db, 'ft:job', job) } catch {} }
  ;(async () => {
    try {
      const mod = ft.sites(s)
      const links = await mod.discover(t, { limit: n })
      job.found = links.length
      save()
      for (const link of links) {
        if (job.state !== 'running') break
        try {
          const items = await mod.fetch(link, {})
          job.read += items.length
          job.added += ft.store.add(items)
        } catch (err) {
          job.log.push(String(link).slice(0, 60) + '：' + String(err && err.message || err).slice(0, 60))
          if (job.log.length > 8) job.log.shift()
        }
        save()
      }
      if (job.added && job.state === 'running') {
        const pack = ft.distill.run()
        invalidatePack()
        job.human = pack.counts.human
        job.fish = pack.counts.fish
      }
      // 被取消时不要覆盖成 done，否则面板上取消会「自己复活」
      if (job.state === 'running') { job.state = 'done'; job.finishedAt = now() }
      save()
    } catch (err) {
      job.state = 'error'
      job.error = String(err && err.message || err).slice(0, 200)
      job.finishedAt = now()
      save()
    }
  })()
  return { ok: true, job }
}

export function cancelLearn(db) {
  if (activeJob && activeJob.state === 'running') {
    // 改内存里的同一个对象，后台循环下一轮才看得到
    activeJob.state = 'cancelled'
    activeJob.finishedAt = now()
    try { if (activeDb) kvSet(activeDb, 'ft:job', activeJob) } catch {}
  } else {
    const cur = learnStatus(db)
    if (cur && cur.state === 'running') { cur.state = 'cancelled'; cur.finishedAt = now(); kvSet(db, 'ft:job', cur) }
  }
  return { ok: true, job: learnStatus(db) }
}
