/**
 * 心声（heart_voice）测试：长度预算跟风格卡走、AI 腔要打回、兜底句要短且不引原话。
 * 目的：让心声和回复是同一个人的口气，不再出现「对话一个风格、心声另一个人」。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const { openDb } = await import('../lib/db.js')
const { heartBudget, heartStyleHint, setStyleValue } = await import('../lib/style.js')
const { reviewHeart, fallbackHeartVoice, FALLBACK } = await import('../lib/mood.js')

const db = openDb(join(mkdtempSync(join(tmpdir(), 'co-heart-')), 'x.db'))

/* ---------------- 1. 长度预算 ---------------- */
{
  const d = heartBudget(db)
  assert.equal(d.min, 6)
  assert.ok(d.max >= 30 && d.max <= 65, '没学风格时给中间值，实际 ' + d.max)
}
{
  setStyleValue(db, '句长', 0.2)
  const short = heartBudget(db)
  assert.equal(short.max, 30, '说话短 → 心声 30 字')
  assert.match(heartStyleHint(db), /嘟囔/, '短句口径像嘟囔')
}
{
  setStyleValue(db, '句长', 0.9)
  const long = heartBudget(db)
  assert.equal(long.max, 45, '说话长也只放宽到 45 字封顶')
  assert.match(heartStyleHint(db), /两句/, '长句口径说到两句')
}
{
  setStyleValue(db, '句长', 0.5)
  setStyleValue(db, 'emoji频率', 0.1)
  assert.match(heartStyleHint(db), /不带 emoji/)
}

/* ---------------- 2. 自检：长短与 AI 腔 ---------------- */
{
  const ok = reviewHeart('我心里软了一下。', { max: 45 })
  assert.equal(ok.ok, true, '短、口语，放行')
}
{
  const long = reviewHeart('今天主人说的这些话我都听进去了，我想先安安静静陪着，不急着讲道理也不抢话，等他缓过来再慢慢说。', { max: 45 })
  assert.equal(long.ok, false)
  assert.equal(long.tooLong, true)
  assert.match(long.hint, /口语/)
}
{
  const fish = reviewHeart('综上所述，我们需要进一步优化整体方案。', { max: 45 })
  assert.equal(fish.ok, false, '总结腔要打回')
  assert.equal(fish.fish, true)
}
{
  const soft = reviewHeart('主人别急，我先办。', { max: 45 })
  assert.equal(soft.ok, true, '私密心声里「主人别急」不算撒娇')
}
{
  const shortBudget = reviewHeart('这句稍微长了一点点啦。', { max: 12 })
  assert.ok(shortBudget.length <= 12 || shortBudget.tooLong === true)
}

/* ---------------- 3. 兜底句：短、有第一人称、不引原话 ---------------- */
{
  const moods = Object.keys(FALLBACK)
  assert.ok(moods.length >= 10, '心情覆盖够用')
  for (const m of moods) {
    for (const line of FALLBACK[m]) {
      assert.ok(line.length >= 4 && line.length <= 30, m + ' 的兜底句长度越界：' + line)
      assert.match(line, /主人|我|他/, m + ' 的兜底句缺人称：' + line)
      assert.ok(!line.includes('（刚听主人说'), '不再拼原话模板')
    }
  }
}
{
  const a = fallbackHeartVoice({ mood: '心疼' }, { userText: '今天好累' })
  const b = fallbackHeartVoice({ mood: '心疼' }, { userText: '我又被骂了' })
  assert.ok(typeof a === 'string' && a.length > 0)
  assert.ok(typeof b === 'string' && b.length > 0)
  assert.ok(fallbackHeartVoice(null).length >= 2, '没有心情也有一句')
  assert.ok(fallbackHeartVoice({ mood: '不存在的心情' }).length >= 2, '未知心情兜底')
}
{
  // 同一心情、不同输入，长样本里应当出现不止一种说法
  const seen = new Set()
  for (let i = 0; i < 40; i++) seen.add(fallbackHeartVoice({ mood: '安心' }, { userText: '第' + i + '句话不一样' }))
  assert.ok(seen.size >= 2, '同一心情要换着说，别每次都一句')
}

console.log('heart tests ok')
