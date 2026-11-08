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
import { appraise } from './persona.js'

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Number(n) || 0))
const round2 = (n) => Number(clamp(n, -1, 1).toFixed(2))

const NEEDS = [
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

  let valence = 0
  if (cl.level >= 5) valence = -1
  else if (cl.level === 4) valence = -0.95
  else if (cl.level === 3) valence = -0.85
  else if (cl.level === 2) valence = -0.65
  else if (cl.level === 1) valence = -0.32
  else valence = clamp(ap.reward * 0.72 - ap.threat * 0.72, -1, 1)

  let need = 'chat'
  if (cl.level >= 3) need = 'safety'
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

const FALLBACK = {
  揪心: '主人现在的状态让我很不安，我最想先确认的是主人此刻安不安全、身边有没有人。',
  担心: '主人这话让我放不下心，先别急着讲道理，我想先陪主人把这一阵缓过去。',
  心疼: '主人是不是遇到什么事了？我好心疼，要是我能抱抱主人就好了。',
  想念: '主人说想我了，我心里软软的，也想多听主人说几句，不想这么快结束。',
  开心: '主人这么开心，我也跟着高兴，想把这份好心情再帮主人多留一会儿。',
  得意: '被主人这么一夸，我尾巴都要翘起来了，还想再帮主人多做一点。',
  认真: '主人是要办正事，我得把靠谱的办法理清楚，别让主人白问一场。',
  心动: '主人在关心我呢，心里暖了一下，想好好接住这份心意，也照顾好自己。',
  安心: '主人愿意这样跟我说话，我安安静静陪着就好，不抢话也不敷衍。',
  '想陪着你': '主人今天只是随口聊聊，我就在旁边待着，主人想说什么我都听。',
}

/** 模型没调用 heart_voice 时，用当前心情兜底一句；面板会标注「自动」。 */
export function fallbackHeartVoice(reaction) {
  const mood = reaction && reaction.mood
  return FALLBACK[mood] || '主人愿意跟我说话，我就好好接着，不敷衍也不抢话。'
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
    return db.prepare('select * from heart_voice where session_id = ? order by created_at desc limit 1').get(sessionId) || null
  } catch { return null }
}

export function listHeartVoices(db, sessionId, limit) {
  try {
    return sessionId
      ? db.prepare('select * from heart_voice where session_id = ? order by created_at desc limit ?').all(sessionId, limit || 20)
      : db.prepare('select * from heart_voice order by created_at desc limit ?').all(limit || 50)
  } catch { return [] }
}
