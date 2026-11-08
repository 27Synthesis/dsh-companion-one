/**
 * companion-one / lib/style.js — 沟通风格学习（独立于七层记忆与人格）。
 * 参考 dsh-natural-dialogue 的「表达从用户原话学习」思路，存储与注入自行实现。
 * 默认开启；面板可一键关闭或逐条删除。注入单轮 ≤ 200 token。
 */
import { now, kvGet, kvSet } from './db.js'

export const STYLE_KEYS = ['句长', '直接度', 'emoji频率', '术语密度', '标点习惯']

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

function put(db, key, value, conf, samples) {
  db.prepare('insert into style_card(key, value, confidence, samples, updated_at) values (?,?,?,?,?)' +
    ' on conflict(key) do update set value = excluded.value, confidence = excluded.confidence,' +
    ' samples = excluded.samples, updated_at = excluded.updated_at')
    .run(key, value, conf, samples, now())
}

/** 从用户原话增量提取风格特征（只统计真实用户消息）。 */
export function learnFromUserText(db, text) {
  if (!styleEnabled(db)) return null
  const s = String(text || '').trim()
  if (s.length < 4) return null
  const sentences = s.split(/[。！？!?；;\n]+/).filter((x) => x.trim())
  const avgLen = sentences.length ? s.replace(/\s/g, '').length / sentences.length : s.length
  const emoji = (s.match(/[\p{Extended_Pictographic}]/gu) || []).length
  const latin = (s.match(/[A-Za-z]{2,}/g) || []).length
  const politeness = (s.match(/请问|麻烦|谢谢|辛苦|不好意思/g) || []).length
  const bangs = (s.match(/[！!]/g) || []).length
  const emojiRate = emoji / Math.max(1, s.length / 30)

  const prev = Object.fromEntries(listStyle(db).map((r) => [r.key, r]))
  const bump = (key, value) => {
    const old = prev[key]
    const samples = (old ? old.samples : 0) + 1
    const conf = Math.min(0.95, 0.3 + samples * 0.08)
    // 滑动平均，避免一句带偏
    const oldNum = old ? Number(old.value) : null
    const next = oldNum === null || Number.isNaN(oldNum) ? value : oldNum * 0.7 + value * 0.3
    put(db, key, String(Number(next.toFixed(2))), Number(conf.toFixed(2)), samples)
  }
  bump('句长', Math.min(1, avgLen / 40))
  bump('直接度', Math.min(1, politeness ? 0.2 : 0.7))
  bump('emoji频率', Math.min(1, emojiRate))
  bump('术语密度', Math.min(1, latin / Math.max(1, s.length / 20)))
  bump('标点习惯', Math.min(1, bangs / Math.max(1, sentences.length)))

  // 显式指令：“别这么正式/随便点/简短点”
  if (/别这么正式|不用这么正式|随便点|口语化/.test(s)) put(db, '直接度', '0.9', 0.9, 99)
  if (/简短点|说短点|简洁/.test(s)) put(db, '句长', '0.25', 0.9, 99)
  if (/别用表情|不要 emoji|别发图/.test(s)) put(db, 'emoji频率', '0.05', 0.9, 99)
  return { ok: true }
}

function band(v, low, mid) {
  if (v < low) return '偏低'
  if (v < mid) return '中等'
  return '偏高'
}

/** 一次性后处理提示：≤200 token，不写入主 system prompt。 */
export function stylePrompt(db) {
  if (!styleEnabled(db)) return ''
  const rows = listStyle(db)
  if (!rows.length) return ''
  const m = Object.fromEntries(rows.map((r) => [r.key, Number(r.value)]))
  const parts = []
  if ('句长' in m) parts.push('句长' + band(m['句长'], 0.35, 0.65) + '（' + (m['句长'] < 0.35 ? '一两句说完' : m['句长'] < 0.65 ? '中等' : '可以展开') + '）')
  if ('直接度' in m) parts.push(m['直接度'] > 0.6 ? '说话直接' : '说话委婉')
  if ('emoji频率' in m) parts.push(m['emoji频率'] > 0.5 ? '可少量用 emoji' : '少用 emoji')
  if ('术语密度' in m) parts.push(m['术语密度'] > 0.5 ? '可以带术语' : '少用术语')
  if ('标点习惯' in m) parts.push(m['标点习惯'] > 0.5 ? '感叹多' : '少感叹')
  return '[表达风格] ' + parts.join('；') + '。只调语气，不改事实与结论。'
}
