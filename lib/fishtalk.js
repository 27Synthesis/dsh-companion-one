/**
 * companion-one / lib/fishtalk.js — 「说人话」底座（⑤ 语言—社会表达区）。
 *
 * 机制来源：github.com/Nozzi2455/fishtalk（MIT）。
 * 本文件只移植其**判定规则与句法**（鱼八股原句、AI 腔模式、引号/列表豁免、
 * 二元组相似度），不复制其语料库、采集器、标签台与命令行。
 * 上游是「学真人说话 + 发之前拦八股」的只读小工具；这里取它最稳定的那半：
 * 生成前给一段人话规则，生成后自检上一轮有没有鱼味。
 */
import { estimateTokens } from './acp.js'

/** 硬证据：出现即算鱼（引号内、引用上下文、编号长列表里不算）。 */
export const HARD_PHRASES = [
  '这条我认',
  '我记下了',
  '收到主人',
  '本鱼记下了',
  '这是本鱼最喜欢的一句话',
  '作为一条鲸鱼',
  '本鲸记下了',
]

/** 软信号：AI 腔与作文腔，单条只提醒，两条以上算鱼。 */
export const SOFT_PATTERNS = [
  ['not-a-but-b', /不是.{0,20}(而是|，?是)/, '「不是A而是B」式对仗'],
  ['summary', /^(总之|所以说|由此可见|总的来说)/, '开口就总结'],
  ['contrast', /与其.{0,20}不如|看似.{0,20}实则|不仅.{0,20}而且/, '作文腔排比'],
  ['itself', /这本身|本质上|归根结底/, '「本质上」式升华'],
  ['as-ai', /作为一(个|名)(ai|人工智能|助手|语言模型)/i, '「作为一个AI」'],
  ['report', /值得一提的是|希望对你有帮助|让我们一起|综上/, '报告腔/客服腔'],
  ['owner', /主人(别|不要|您|请)/, '跟主人撒娇式的话'],
  ['cheer', /加油哦|抱抱你|摸摸头|相信自己/, '罐头安慰'],
]

const norm = (s) => String(s == null ? '' : s).normalize('NFKC').toLowerCase()
  .replace(/\[[^\]]{1,16}\]/g, '').replace(/https?:\/\/\S+/g, '').replace(/[\s\p{P}\p{S}]/gu, '')

function bigrams(s) {
  const out = []
  for (let i = 0; i + 1 < s.length; i++) out.push(s.slice(i, i + 2))
  return out
}

export function similarity(a, b) {
  const x = norm(a), y = norm(b)
  if (!x || !y) return 0
  if (x === y) return 1
  if (x.length < 4 || y.length < 4) return 0
  const A = new Set(bigrams(x)), B = new Set(bigrams(y))
  let inter = 0
  for (const g of A) if (B.has(g)) inter++
  return inter / (A.size + B.size - inter)
}

/** 把引号与 > 引用行抹成空格，长度不变（照抄别人的鱼八股不算自己的）。 */
function maskQuoted(text) {
  let out = String(text == null ? '' : text)
  const pairs = [[/「[^」]*」/g], [/『[^』]*』/g], [/“[^”]*”/g], [/'[^'\n]*'/g], [/"[^"\n]*"/g]]
  for (const [re] of pairs) out = out.replace(re, (m) => ' '.repeat(m.length))
  out = out.replace(/(^|\n)(\s*>.*)(?=\n|$)/g, (m, lead) => lead + ' '.repeat(m.length - lead.length))
  return out
}

const isListLike = (t) => {
  const numbered = (String(t).match(/(^|\n)\s*\d{1,2}[.、]/g) || []).length
  const lines = (String(t).match(/\n/g) || []).length
  return numbered >= 3 || (String(t).length > 500 && lines >= 5)
}

const hasQuoteCtx = (text, phrase) => {
  const i = String(text).indexOf(phrase)
  if (i < 0) return false
  const around = String(text).slice(Math.max(0, i - 80), i + phrase.length + 80)
  return /引用|引述|复读|别人|他说|她说|原话|这种话|所谓|嘲讽|笑死|照抄|玩梗/.test(around)
}

/**
 * 检查一段话有没有鱼味。
 * @returns {{fish:boolean, hard:string[], soft:string[], hint:string}}
 */
export function checkText(text, opts) {
  const o = opts || {}
  const raw = String(text || '').trim()
  if (!raw) return { fish: false, hard: [], soft: [], hint: '' }
  const masked = maskQuoted(raw)
  const hard = []
  if (!isListLike(raw)) {
    for (const p of HARD_PHRASES) if (masked.includes(p) && !hasQuoteCtx(raw, p)) hard.push(p)
  }
  const soft = []
  const softText = norm(masked)
  for (const [code, re, label] of SOFT_PATTERNS) if (re.test(softText) || re.test(masked)) soft.push(label)
  const threshold = o.threshold || 2
  const fish = hard.length > 0 || soft.length >= threshold
  return { fish, hard, soft, hint: fish ? describe(hard, soft) : '' }
}

function describe(hard, soft) {
  const bits = []
  if (hard.length) bits.push('鱼八股原句「' + hard[0] + '」')
  if (soft.length) bits.push(soft.slice(0, 2).join('、'))
  return bits.join('；')
}

/** 生成后自检发现鱼味时，下一轮用的纠偏提示（≤60 字）。 */
export function violationHint(report) {
  if (!report || !report.fish) return ''
  const why = report.hint || '套话'
  return '[上轮口吻] 上一轮有点鱼味（' + String(why).slice(0, 40) + '）。这轮换成人话：短句、具体、先接人再讲事，别总结别排比。'
}

/** ⑤ 语言—社会表达：生成前的一次性规则（≤150 token，不写进 system prompt）。 */
export const EXPRESSION_GUIDE = [
  '[说话] 像真人在微信里打字：短句、具体、有反应；先接住这句话，再说事。',
  '禁：这条我认/我记下了/收到主人/本鱼；「不是A而是B」「总之」「作为一个AI」「希望你有所帮助」；每段都总结、三词排比、空形容词。',
  '不确定就说不确定；可以犹豫、可以用语气词；能一句说完就别两句。',
  '公开场合（评论/群聊）把撒娇口癖、动作括号、「主人」称呼收起来；私聊照旧。',
].join('\n')

export function expressionPrompt(opts) {
  const o = opts || {}
  let text = EXPRESSION_GUIDE
  if (o.publicScene) text += '\n场合：这是公开发言，按上面的公开场合规矩来。'
  if (estimateTokens(text) > 170) text = text.slice(0, 320)
  return text
}
