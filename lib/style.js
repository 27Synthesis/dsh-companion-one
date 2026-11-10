/**
 * companion-one / lib/style.js — 沟通风格学习（独立于七层记忆与人格）。
 *
 * 2026-11-09 重做：原来的指标有四个硬伤——
 *   1. 直接度是二值信号（有礼貌词 0.2，否则 0.7），滑动平均后永远是 0.7；
 *   2. 置信度 8 条样本就饱和到 0.95，看不出可信度；
 *   3. 显式说「别这么正式」会被下一轮普通消息拉回；
 *   4. 与 ⑤ 区的表达规则重复甚至互相矛盾（一个说「可以展开」，一个说「短句」）。
 * 现在：五项都是连续指标、置信度按样本量算、显式偏好锁定 7 天、统一交给 ⑤ 区渲染。
 */
import { now, kvGet, kvSet } from './db.js'

export const STYLE_KEYS = ['句长', '直接度', 'emoji频率', '术语密度', '标点习惯']
const LOCK_DAYS = 7
const DAY = 86400000

export function styleEnabled(db) {
  return kvGet(db, 'style:enabled', true) !== false
}
export function setStyleEnabled(db, on) {
  kvSet(db, 'style:enabled', !!on)
}

export function listStyle(db) {
  return db.prepare('select * from style_card order by key').all()
}

export function deleteStyle(db, key) {
  db.prepare('delete from style_card where key = ?').run(key)
}

export function clearStyle(db) {
  db.prepare('delete from style_card').run()
}

function put(db, key, value, confidence, samples, locked, lockedUntil) {
  db.prepare('insert into style_card(key, value, confidence, samples, locked, locked_until, updated_at) values (?,?,?,?,?,?,?)' +
    ' on conflict(key) do update set value = excluded.value, confidence = excluded.confidence,' +
    ' samples = excluded.samples, locked = excluded.locked, locked_until = excluded.locked_until, updated_at = excluded.updated_at')
    .run(key, String(Number(Number(value).toFixed(2))), Number(confidence.toFixed(2)), samples,
      locked ? 1 : 0, lockedUntil || null, now())
}

const clamp01 = (n) => Math.min(1, Math.max(0, n))
const isLocked = (row) => !!(row && row.locked && Number(row.locked_until || 0) > Date.now())

/** 置信度：样本越多越可信，30 条到 ~0.66，120 条才 ~0.93，不再 8 条就满格。 */
export function confidenceOf(samples) {
  return Number((0.2 + 0.75 * (1 - Math.exp(-Number(samples || 0) / 30))).toFixed(2))
}

/**
 * 从一句用户原话里抽取五项特征。返回 0–1 的连续分。
 * 长文（>200 字）只学标点与 emoji：一次长回复不该把「句长」拉偏。
 */
export function featuresOf(text) {
  const s = String(text || '').trim()
  const longText = s.length > 200
  const sentences = s.split(/[。！？!?；;\n]+/).map((x) => x.trim()).filter(Boolean)
  const lens = sentences.map((x) => x.replace(/\s/g, '').length).sort((a, b) => a - b)
  const median = lens.length ? lens[Math.floor(lens.length / 2)] : s.replace(/\s/g, '').length
  const emoji = (s.match(/[\p{Extended_Pictographic}]/gu) || []).length
  const latin = (s.match(/[A-Za-z]{2,}/g) || []).length
  const polite = (s.match(/请问|麻烦|谢谢|辛苦|不好意思|拜托/g) || []).length
  const bangs = (s.match(/[！!?？]/g) || []).length
  const imperative = sentences.filter((x) => /^(把|别|快|去|来|帮我|给我|先|直接)/.test(x)).length
  const particles = (s.match(/[啊呀吧呢嘛哦啦哈呗]/g) || []).length
  const chars = Math.max(1, s.replace(/\s/g, '').length)

  return {
    longText,
    句长: clamp01((median - 4) / 36),
    直接度: clamp01(0.55 * (1 - polite / Math.max(1, sentences.length)) +
      0.3 * (imperative / Math.max(1, sentences.length)) +
      0.15 * (1 - Math.min(1, particles / Math.max(1, sentences.length / 2)))),
    emoji频率: clamp01(1 - Math.exp(-(emoji / (chars / 100)) / 2)),
    术语密度: clamp01(1 - Math.exp(-(latin / (chars / 100)) / 3)),
    标点习惯: clamp01(bangs / Math.max(1, sentences.length)),
  }
}

/** 从用户原话增量学习；显式偏好直接锁定 7 天。返回便于调试的摘要。 */
export function learnFromUserText(db, text) {
  if (!styleEnabled(db)) return null
  const s = String(text || '').trim()
  if (s.length < 4) return null
  const f = featuresOf(s)
  const prev = Object.fromEntries(listStyle(db).map((r) => [r.key, r]))
  const changed = []

  for (const key of STYLE_KEYS) {
    if (key === '句长' && f.longText) continue
    if (key === '术语密度' && f.longText) continue
    const old = prev[key]
    if (isLocked(old)) continue
    const samples = Number((old && old.samples) || 0) + 1
    const oldVal = old ? Number(old.value) : null
    // 句长与标点用指数滑动平均；其余同样，但 α 稍大，跟得上语体变化
    const alpha = key === '标点习惯' ? 0.2 : 0.25
    const next = oldVal === null || Number.isNaN(oldVal) ? f[key] : oldVal * (1 - alpha) + f[key] * alpha
    put(db, key, next, confidenceOf(samples), samples, false, null)
    if (oldVal === null || Math.abs(next - oldVal) > 0.02) changed.push(key + ' ' + Number(next.toFixed(2)))
  }

  // 显式偏好：写死并锁定 7 天，期间自动学习不覆盖
  const lock = (key, value) => {
    put(db, key, value, 0.95, 99, true, Date.now() + LOCK_DAYS * DAY)
    changed.push(key + '（手动锁定）')
  }
  if (/别这么正式|不用这么正式|随便点|口语化/.test(s)) lock('直接度', 0.9)
  if (/简短点|说短点|简洁/.test(s)) lock('句长', 0.2)
  if (/别用表情|不要 emoji|别发图/.test(s)) lock('emoji频率', 0.05)
  if (/别用术语|说人话/.test(s)) lock('术语密度', 0.1)
  return { ok: true, changed }
}

/** 手动改一项并锁定（面板滑块用）。 */
export function setStyleValue(db, key, value) {
  if (!STYLE_KEYS.includes(key)) throw new Error('unknown style key: ' + key)
  const v = clamp01(Number(value))
  put(db, key, v, 0.95, 99, true, Date.now() + LOCK_DAYS * DAY)
  return listStyle(db)
}

/** 解锁一项：恢复自动学习，并把样本数降到 10（保留当前值）。 */
export function unlockStyle(db, key) {
  const row = db.prepare('select * from style_card where key = ?').get(key)
  if (!row) return listStyle(db)
  put(db, key, Number(row.value), confidenceOf(10), 10, false, null)
  return listStyle(db)
}

/** 重新学习：清空样本数但保留当前值。 */
export function restartStyle(db) {
  for (const row of listStyle(db)) put(db, row.key, Number(row.value), confidenceOf(0), 0, false, null)
  return listStyle(db)
}

function band(v, low, mid) {
  if (v < low) return '偏低'
  if (v < mid) return '中等'
  return '偏高'
}

/** 结构化风格，交给 ⑤ 区统一渲染，避免两段话各说各的。 */
export function styleData(db) {
  if (!styleEnabled(db)) return null
  const rows = listStyle(db)
  if (!rows.length) return null
  const out = {}
  for (const r of rows) {
    out[r.key] = {
      value: Number(r.value),
      confidence: Number(r.confidence),
      samples: Number(r.samples || 0),
      locked: isLocked(r),
    }
  }
  return out
}

/** 一行风格描述（≤60 token）。与 ⑤ 区合并后，这里只给事实，不给矛盾的建议。 */
export function styleLine(db) {
  const d = styleData(db)
  if (!d) return ''
  const parts = []
  if (d['句长']) {
    const v = d['句长'].value
    parts.push('句长' + band(v, 0.35, 0.62) + (v < 0.35 ? '，一两句说完' : v < 0.62 ? '' : '，可以展开'))
  }
  if (d['直接度']) parts.push(d['直接度'].value > 0.55 ? '说话直接' : '说话委婉')
  if (d['emoji频率']) parts.push(d['emoji频率'].value > 0.45 ? '可以带一点 emoji' : '少用 emoji')
  if (d['术语密度']) parts.push(d['术语密度'].value > 0.45 ? '可以带术语' : '少用术语')
  if (d['标点习惯']) parts.push(d['标点习惯'].value > 0.45 ? '可以感叹' : '少感叹')
  return parts.join('；')
}

/** 兼容旧调用：单独的风格提示（面板预览用）。 */
export function stylePrompt(db) {
  if (!styleEnabled(db)) return ''
  const line = styleLine(db)
  return line ? '[表达风格] ' + line + '。只调语气，不改事实与结论。' : ''
}

/**
 * 心声的长度预算：跟着学到的句长走，别让心声比对话还长。
 * 主人说话越短，心声越短；没学到风格时给中间的默认值。
 */
export function heartBudget(db) {
  const d = styleData(db)
  const v = d && d['句长'] ? Number(d['句长'].value) : 0.5
  const max = Math.min(45, Math.round(20 + v * 50)) // 0.2→30, 0.5→45，再长也封顶 45：心声不该比对话长
  return { min: 6, max }
}

/** 心声的口吻口径（≤30 字），与风格卡同一套事实，别再各说各的。 */
export function heartStyleHint(db) {
  const d = styleData(db)
  if (!d) return ''
  const bits = []
  if (d['句长']) {
    const v = Number(d['句长'].value)
    bits.push(v < 0.35 ? '像嘟囔，半句就够' : v < 0.62 ? '一两句' : '可以说到两句')
  }
  if (d['emoji频率'] && Number(d['emoji频率'].value) <= 0.45) bits.push('不带 emoji')
  if (d['标点习惯'] && Number(d['标点习惯'].value) <= 0.45) bits.push('少用感叹号')
  return bits.join('、')
}
