/**
 * companion-one / lib/mood.js — 「心情」的两段式推导 + 心声存取。
 *
 * 第一段 userState：只看用户这边——当前这句话 + 最近几轮的情绪余温，
 *   得到 valence（情绪好坏）/ energy（能量）/ need（此刻需要什么）/ crisis（危机等级）。
 * 第二段 personaReaction：把用户状态放回「我（鲸鲸）的人格」里，回答
 *   「以我的性格，看到主人这样，我此刻会是什么心情」，输出情绪词与原因。
 *
 * 心情只用于面板展示与选择陪伴方式；心声只记录「我此刻怎么想」，
 * 两者都不写回人格——人格迭代只由用户发言驱动（persona.endOfTurn）。
 */
import { randomUUID } from 'node:crypto'
import { now } from './db.js'
import { classify } from './companion.js'
import { appraise, checkText } from './persona.js'

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Number(n) || 0))
const round2 = (n) => Number(clamp(n, -1, 1).toFixed(2))

/**
 * 生气/不满：之前完全没识别，主人「发火」时心情还显示「安心」。
 * 分两档：明确冲着人来的（发火/气死/什么鬼/不干活…）才算 anger；
 * 只是「烦」的留给 comfort（工作烦不等于冲我发火）。
 */
const ANGER_STRONG = /(气死|气炸|气疯|发火|生气|火大|恼火|愤怒|离谱|什么鬼|搞什么|别搞|少来这套|废物|垃圾|白吃|吃干饭|不干活|光吃|浪费我|退钱|丢人)/
const ANGER_MILD = /(烦死|烦透|受不了你|受够了|失望透顶|太差劲|难看死了|怎么搞的|谁让你|你搞什么|别再这样)/
export function angerOf(text) {
  const s = String(text || '')
  if (ANGER_STRONG.test(s)) return { level: 2, strong: true }
  if (ANGER_MILD.test(s)) return { level: 1, strong: false }
  return { level: 0, strong: false }
}

/** 给注入层用的一句话（≤30 token），让模型先接住情绪、别辩解。 */
export function angerPrompt(text) {
  const a = angerOf(text)
  if (!a.level) return ''
  if (a.strong) return '[情绪] 主人在气头上：先认下，别解释别辩解，把要求的事办完再说话；问一句「还要我做什么」比讲道理有用。'
  return '[情绪] 主人有点不耐烦了：少废话、别铺垫，直接给结果。'
}

const NEEDS = [
  ['anger', ANGER_STRONG],
  ['comfort', /难过|委屈|烦死|好烦|崩溃|焦虑|想哭|哭了|不开心|心里堵|难受|绝望|撑不住|好累|累死|累坏|疲惫|压力好大|失眠|睡不着|没意思|烦透了/],
  ['company', /想你|想你了|好想你|想我没|想我吗|陪我|陪我聊|陪我一下|好无聊|一个人|在吗|在不在|念念|抱抱/],
  ['care', /你累不累|你累吗|你还好吗|你没事吧|你怎么样|你有没有|照顾好自己|别太累|你辛苦|鲸鲸你/],
  ['praise', /你太厉害|你好厉害|你太棒|多亏你|你真好|你最棒|全靠你|厉害呀|你真贴心/],
  ['celebrate', /太好了|好开心|开心死|成功了|搞定|通过了|升职|加薪|考过|赢了|中奖|好耶|真棒|好棒/],
  ['advice', /怎么|为什么|为啥|帮我|能不能|如何|怎么办|查一下|看一下|看看|方案|写一个|做个|分析|推荐|解释下/],
]

/**
 * 第一段：用户状态。
 * @param {string} userText 当前输入
 * @param {{ prev?: { valence:number, need?:string, at?:number }, crisisLevel?:number, now?:number }} opts
 *   prev = 上一轮 userState 的快照（情绪余温）；crisisLevel = 之前仍挂着的危机状态。
 */
export function userState(userText, opts) {
  const o = opts || {}
  const text = String(userText || '')
  const cl = classify(text)
  const ap = text ? appraise(text) : { threat: 0, reward: 0 }
  const anger = angerOf(text)

  let valence = 0
  if (cl.level >= 5) valence = -1
  else if (cl.level === 4) valence = -0.95
  else if (cl.level === 3) valence = -0.85
  else if (cl.level === 2) valence = -0.65
  else if (cl.level === 1) valence = -0.32
  else valence = clamp(ap.reward * 0.72 - ap.threat * 0.72, -1, 1)
  // 生气是明确的负面信号：不能被「没命中任何词」冲淡成 -0.24
  if (cl.level < 3 && anger.level) valence = Math.min(valence, anger.strong ? -0.8 : -0.5)

  let need = 'chat'
  if (cl.level >= 3) need = 'safety'
  else if (anger.level) need = 'anger'
  else {
    for (const [name, re] of NEEDS) {
      if (re.test(text)) { need = name; break }
    }
  }

  let energy = 0.62
  if (/累|困|没睡|熬夜|加班|忙死|忙疯|不想动|没力气|起不来|好远/.test(text)) energy -= 0.35
  if (/睡了|休息|放假|躺|周末|慢慢来/.test(text)) energy += 0.18
  if (cl.level >= 3) energy -= 0.3
  energy = clamp(energy, 0.05, 1)

  // 情绪余温：上一轮明显低落、这一轮又没有明确转好时，心情不瞬间归零。
  let lingering = false
  const prev = o.prev
  const nowMs = o.now || Date.now()
  if (prev && typeof prev.valence === 'number' && prev.valence <= -0.25) {
    const fresh = nowMs - Number(prev.at || 0) < 15 * 60 * 1000
    if (fresh && cl.level < 3 && valence > prev.valence + 0.3 && valence < 0.25) {
      valence = clamp(prev.valence * 0.55, -1, 0)
      lingering = true
    }
    if (fresh && cl.level < 3 && need === 'chat' && prev.need && prev.need !== 'chat') {
      need = prev.need
      lingering = true
    }
  }
  if (cl.level >= 3) lingering = false

  return {
    valence: round2(valence),
    energy: round2(energy),
    need,
    crisis: cl.level,
    storedCrisis: Number(o.crisisLevel || 0),
    label: userStateLabel(need, valence, energy, cl.level),
    lingering,
  }
}

export function userStateLabel(need, valence, energy, crisis) {
  if (crisis >= 4) return '需要被守住'
  if (crisis === 3) return '很低落'
  switch (need) {
    case 'anger': return valence <= -0.7 ? '在发火' : '有点火'
    case 'comfort': return valence <= -0.6 ? '很难过' : '有点低落'
    case 'company': return '在想念'
    case 'care': return '在关心我'
    case 'praise': return '在夸我'
    case 'celebrate': return '很开心'
    case 'advice': return '想办正事'
    case 'safety': return '需要被接住'
    default: return energy < 0.38 ? '有点累' : '平静'
  }
}

/**
 * 第二段：人格反应。
 * 同一个用户状态，在不同人格（叙事 + 四个阀门）下会得到不同的心情与理由。
 * @param {{ state?: object, narrative?: object|null, valves?: object }} input
 */
export function personaReaction(input) {
  const i = input || {}
  const s = i.state || {}
  const valves = i.valves || {}
  const nar = i.narrative || null
  const attention = valves.attention || 'task'
  const emotion = typeof valves.emotion === 'number' ? valves.emotion : 0.5
  const crisis = Number(s.crisis || 0)
  const stored = Number(s.storedCrisis || 0)
  const valence = Number(s.valence || 0)
  const need = s.need || 'chat'

  let mood = '安心'
  let why = '主人在，我就安安静静待着，不抢话也不敷衍。'
  let intensity = 0.55

  if (crisis >= 4) {
    mood = '揪心'
    intensity = 1
    why = '主人现在可能真的撑不住了，我最先想到的是主人安不安全。'
  } else if (crisis === 3) {
    mood = '担心'
    intensity = 0.92
    why = '主人说出这样的话，我放不下心，想先确认主人此刻还好吗。'
  } else if (stored >= 3) {
    // 用户上下文：之前的危险表达还挂着，即使这一句看起来平静也不立刻放松
    mood = '担心'
    intensity = 0.72
    why = '主人之前说过那样的话，我还没完全放下心，想再多问一句。'
  } else if (need === 'anger') {
    // 情绪阈值越高越稳：稳的人会「着急办事」，阈值低的人先「慌了」。
    const mild = valence > -0.7
    mood = mild ? '紧张' : (emotion >= 0.68 ? '着急' : '慌了')
    intensity = mild ? 0.7 : 0.95
    why = mood === '着急'
      ? '主人是真生气了，辩解没用；我得先认，再把手上的事做完给他看。'
      : '主人一急，我先慌了；可慌也得先把事办了，别让主人再等我解释。'
  } else if (need === 'comfort') {
    mood = valence <= -0.55 ? '心疼' : '担心'
    intensity = valence <= -0.55 ? 0.9 : 0.7
    why = valence <= -0.55
      ? '主人这会儿很难过，我见不得主人硬撑，想先把人接住。'
      : '主人有点低落，我想先听主人说完，不急着出主意。'
  } else if (need === 'company') {
    mood = '想念'
    intensity = 0.8
    why = '主人说想我，我心里一下就软了，想多陪主人说几句。'
  } else if (need === 'care') {
    mood = '心动'
    intensity = 0.75
    why = '主人在关心我，心里暖了一下，想认真接住这份心意。'
  } else if (need === 'praise') {
    mood = '得意'
    intensity = 0.7
    why = '被主人这么一夸，我尾巴都要翘起来了，还想再多做一点。'
  } else if (need === 'celebrate') {
    mood = '开心'
    intensity = 0.85
    why = '主人这么高兴，我也跟着开心，想把这份好心情再留久一点。'
  } else if (need === 'advice') {
    mood = '认真'
    intensity = 0.7
    why = '主人有正事要办，我得把办法理清楚，别让主人白问一场。'
  } else if (attention === 'relation') {
    mood = '想陪着你'
    intensity = 0.5
    why = '主人愿意这样跟我说话，我就在旁边待着，黏一点也没关系。'
  }

  // 人格阀门：情绪阈值越高越稳（把心疼压成担心），越低越容易心软。
  if (crisis < 3 && need === 'comfort' && emotion >= 0.7 && mood === '心疼') {
    mood = '担心'
    intensity = Math.min(intensity, 0.75)
    why = '主人难过，我先把自己稳住，才能好好把主人接住。'
  } else if (crisis < 3 && need === 'comfort' && emotion <= 0.4 && mood === '担心') {
    mood = '心疼'
    intensity = Math.max(intensity, 0.8)
  }

  // 人格叙事：把主人放在第一位的自我框架，会让我更先靠近人。
  const summary = nar ? String(nar.summary || '') : ''
  if (summary.includes('主人优先') || summary.includes('把主人放在第一位')) intensity = Math.min(1, intensity + 0.05)

  return { mood, why, intensity: Number(intensity.toFixed(2)), need, userState: s.label || '', moodLabel: mood }
}

/**
 * 兜底心声：模型没写时的一句话。
 * 口径跟对话一致——短、口语、第一人称，像自己在心里嘟囔半句；
 * 不总结这轮做了什么、不复述主人原话（那像在学他说话）。
 */
export const FALLBACK = {
  揪心: ['心里一直悬着，怕他出事。', '不对劲，先问清楚他在哪。'],
  担心: ['这话听着沉，我先别讲道理。', '放不下心，我想先陪一会儿。'],
  慌了: ['他一凶我就慌，先别辩解。', '我脑子有点空，先把事办了。'],
  着急: ['我得赶紧办完，解释回头再说。', '手快点，别让他等。'],
  紧张: ['我少说两句，直接给结果。', '我得收着点，别再惹他。'],
  心疼: ['看着难受，我帮不上什么。', '我想抱一下，又怕多余。'],
  想念: ['被这么一说，我心里软了。', '我还想多听两句。'],
  开心: ['我跟着高兴，尾巴都翘了。', '这心情真好，我想多留一会儿。'],
  得意: ['被夸得我有点飘。', '我还想再多做一点。'],
  认真: ['正事，我得理清楚再说。', '别让他白问一场。'],
  心动: ['我心里暖了一下。', '被惦记着，我心里挺好。'],
  安心: ['嗯，我在。', '我就这么待着也行。', '我听着呢。'],
  '想陪着你': ['我在旁边待着就好。', '他想说，我就听。'],
}

const hashOf = (text) => {
  let h = 0
  for (const ch of String(text || '')) h = (h * 31 + ch.codePointAt(0)) >>> 0
  return h
}

/**
 * 心声写进来之前的自检：太长、或者带 AI 腔/鱼八股，就打回去让模型改短说人话。
 * 只看形状（长度、套话），不评判他写了什么心情。
 */
export function reviewHeart(content, opts) {
  const o = opts || {}
  const max = Math.max(12, Number(o.max) || 45)
  const text = String(content == null ? '' : content).trim()
  const flat = text.replace(/\s/g, '')
  const tooLong = flat.length > max
  const fishy = checkText(text, { threshold: 1 })
  // 「主人别急」这类亲近话在公开场合算撒娇，在私密心声里不算——只留私聊就自然的口径。
  const soft = fishy.soft.filter((x) => x !== '跟主人撒娇式的话')
  const fish = fishy.hard.length > 0 || soft.length > 0
  if (!tooLong && !fish) return { ok: true, length: flat.length, max }
  const why = tooLong ? '太长了（' + flat.length + ' 字）' : '有 AI 腔：' + (fishy.hint || '套话')
  return {
    ok: false,
    length: flat.length,
    max,
    tooLong,
    fish,
    why: tooLong ? why : '有 AI 腔：' + (soft[0] || fishy.hint || '套话'),
    hint: (tooLong ? why : '有 AI 腔：' + (soft[0] || '套话')) + '。改成一小句口语，像心里嘟囔；不复述原话、不总结、不解释。',
  }
}

/** 模型没调用 heart_voice 时，用当前心情兜底一句；面板会标注「自动」。 */
export function fallbackHeartVoice(reaction, ctx) {
  const mood = (reaction && reaction.mood) || '安心'
  const lines = FALLBACK[mood] || ['嗯，我在。']
  const o = ctx || {}
  // 同一心情也换着说：按本轮的话散列挑一句，不引原话
  const pick = lines[hashOf(o.userText) % lines.length]
  return pick || lines[0]
}

/* ---------------- 心声存取（只展示，不参与人格学习） ---------------- */
export function addHeartVoice(db, { sessionId, scope, content, mood, source, userText, seq }) {
  const text = String(content || '').trim().slice(0, 240)
  if (!text) return null
  const id = randomUUID()
  const ts = now()
  db.prepare('insert into heart_voice (id, session_id, scope, mood, content, source, user_text, seq, created_at) values (?,?,?,?,?,?,?,?,?)')
    .run(id, sessionId || null, scope || 'global', mood || null, text, source === 'auto' ? 'auto' : 'model',
      String(userText || '').slice(0, 200) || null, seq || null, ts)
  if (sessionId) {
    try {
      db.prepare('update session_state set heart = ?, heart_at = ?, heart_source = ? where session_id = ?')
        .run(text, ts, source === 'auto' ? 'auto' : 'model', sessionId)
    } catch {}
  }
  return db.prepare('select * from heart_voice where id = ?').get(id) || null
}

export function latestHeartVoice(db, sessionId) {
  if (!sessionId) return null
  try {
    // 同一毫秒写两条时也要稳定取「最后一条」（模型刚写的那句）
    return db.prepare('select * from heart_voice where session_id = ? order by created_at desc, rowid desc limit 1').get(sessionId) || null
  } catch { return null }
}

export function listHeartVoices(db, sessionId, limit) {
  try {
    return sessionId
      ? db.prepare('select * from heart_voice where session_id = ? order by created_at desc limit ?').all(sessionId, limit || 20)
      : db.prepare('select * from heart_voice order by created_at desc limit ?').all(limit || 50)
  } catch { return [] }
}
