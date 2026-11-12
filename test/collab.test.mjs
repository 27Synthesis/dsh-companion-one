/**
 * collab 测试：协作页的探测逻辑 —— 装没装、什么版本、多少东西、内嵌地址。
 * 造一个假 DSH_HOME，两边都不装 / 两边都装 各走一遍；坏文件不该抛。
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

const { collabStatus, profileName, pluginInfo } = await import('../lib/collab.js')

const home = mkdtempSync(join(tmpdir(), 'co-collab-'))
const env = { DSH_HOME: home, DSH_FISH_HOME: join(home, 'fish') }

// ① 什么都没装：两边都该是待安装，并且给出安装命令
const empty = collabStatus(env)
console.log('未装:', empty.sides.map((s) => s.name + ':' + s.installed).join(' '))
assert.equal(empty.sides.length, 2)
assert.equal(empty.sides[0].installed, false)
assert.equal(empty.sides[1].installed, false)
assert.ok(empty.sides[0].install.includes('@ssamurias/dsh-fish'), '大肥鱼的安装命令要能直接抄')
assert.ok(empty.sides[1].install.includes('dsh-fish-memory'), '鱼记忆的安装命令要能直接抄')
assert.equal(empty.sides[0].page, '/dsh-fish')
assert.equal(empty.sides[1].page, '/dsh-fish-memory/page')
assert.equal(empty.profile, 'web')
assert.deepEqual(empty.sides[0].rows, [], '没装就不该有数据行')

// ② 装上：profile 的 node_modules 里放 package.json
const prof = join(home, 'profiles', 'web')
const put = (dir, name, version) => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version }))
}
put(join(prof, 'node_modules', '@ssamurias', 'dsh-fish'), '@ssamurias/dsh-fish', '0.9.6')
put(join(prof, 'node_modules', 'dsh-fish-memory'), 'dsh-fish-memory', '1.6.0')
assert.equal(pluginInfo('@ssamurias/dsh-fish', env).version, '0.9.6')
assert.equal(pluginInfo('@ssamurias/dsh-fish', { DSH_PROFILE: 'web', DSH_HOME: home }).installed, true)

// ③ 造数据：便签 2 条（1 条划掉）、预约 1 条有效 + 1 条已完成、成长记录 2 条 + 1 条坏行、首页 3 轮
const fish = join(home, 'fish')
mkdirSync(fish, { recursive: true })
writeFileSync(join(fish, 'notes.json'), JSON.stringify({ notes: [{ text: '买牛奶', status: 'open' }, { text: '早睡', status: 'done' }] }))
writeFileSync(join(fish, 'appointments.json'), JSON.stringify({ appointments: [{ what: '一起看片', status: 'open' }, { what: '旧事', status: 'done' }] }))
writeFileSync(join(fish, 'events.jsonl'), [
  JSON.stringify({ id: 'ev1', ts: '2026-11-01T10:00:00Z', type: 'utterance', text: '一' }),
  'not json at all',
  JSON.stringify({ id: 'ev2', ts: '2026-11-02T10:00:00Z', type: 'diary', text: '二' }),
  '',
].join('\n'))
writeFileSync(join(fish, 'home.json'), JSON.stringify({ title: '今晚', turns: 3 }))

// 鱼记忆：一个库 3 条，其中 1 条已删
const mem = join(home, 'fish-memory')
mkdirSync(mem, { recursive: true })
writeFileSync(join(mem, 's1.json'), JSON.stringify({
  memories: [{ id: 'm1', text: '甲', at: '2026-11-01T10:00:00Z' }, { id: 'm2', text: '乙', at: '2026-11-02T10:00:00Z' }, { id: 'm3', text: '丙', at: '2026-11-03T10:00:00Z' }],
  deleted: ['m3'],
}))
writeFileSync(join(mem, 'broken.json'), '{ 这不是 json')

const full = collabStatus(env)
const fishSide = full.sides[0]
const memSide = full.sides[1]
console.log('装上:', fishSide.name, fishSide.version, JSON.stringify(fishSide.rows))
console.log('装上:', memSide.name, memSide.version, JSON.stringify(memSide.rows))
assert.equal(fishSide.installed, true)
assert.equal(fishSide.version, '0.9.6')
assert.equal(memSide.installed, true)
assert.equal(memSide.version, '1.6.0')

const rows = Object.fromEntries(fishSide.rows)
assert.equal(rows['便签（未划掉）'], 1, '划掉的不算')
assert.equal(rows['预约（未了结）'], 1, '已完成的不算')
assert.equal(rows['成长记录'], 2, '坏行跳过，只剩两条')
assert.equal(rows['首页轮数'], 3)

const mrows = Object.fromEntries(memSide.rows)
assert.equal(mrows['记忆库文件'], 2, '坏库也算一个文件（只是读不出条目）')
assert.equal(mrows['记忆条数'], 2, 'deleted 里的不算')

// ④ 干净环境也不该崩：DSH_HOME 指向不存在的路径
const ghost = collabStatus({ DSH_HOME: join(home, 'nope'), DSH_FISH_HOME: join(home, 'nope-fish') })
assert.equal(ghost.sides[0].installed, false)
assert.deepEqual(ghost.sides[0].rows, [])

// ⑤ profile 名：DSH_PROFILE 优先
assert.equal(profileName({ DSH_HOME: home, DSH_PROFILE: 'work' }), 'work')
assert.equal(profileName({ DSH_HOME: home }), 'web')

console.log('COLLAB TESTS PASSED')
