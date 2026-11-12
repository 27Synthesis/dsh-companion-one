/**
 * companion-one / lib/collab.js — 「协作」页：把大肥鱼(dsh-fish) 与鱼记忆(dsh-fish-memory) 收进同一页。
 *
 * 只做三件事：①当前 profile 里装没装、什么版本 ②它们各自积了多少东西
 * ③给出它们自己页面的地址（面板用 iframe 内嵌，写操作仍发生在它们自己的界面里）。
 * 不 import 它们、不写它们的库 —— 那边改名/升级，这里最多显示「待安装」，不会把陪伴层带崩。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { events, home, notes, appts } from './fish.js'
import { stores, memoriesOf } from './fishmem.js'

function baseDir(env) {
  const e = env || process.env
  return (e && e.DSH_HOME) ? String(e.DSH_HOME) : join(homedir(), '.dsh')
}

/** 当前 profile 名：环境里没写就按 web（dsh web 的默认 profile）。 */
export function profileName(env) {
  const e = env || process.env
  const name = String((e && e.DSH_PROFILE) || '').trim()
  if (name) return name
  // 没指定时优先 web；web 不在就取磁盘上唯一一个 profile（别猜错目录）
  const root = join(baseDir(e), 'profiles')
  if (existsSync(join(root, 'web'))) return 'web'
  try {
    const all = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    if (all.length === 1) return all[0]
  } catch {}
  return 'web'
}

export function profileDir(env) {
  return join(baseDir(env), 'profiles', profileName(env))
}

function readPkg(dir) {
  try {
    const raw = readFileSync(join(dir, 'package.json'), 'utf8')
    const j = raw && raw.trim() ? JSON.parse(raw) : null
    return j && typeof j === 'object' ? j : null
  } catch {
    return null
  }
}

/** 一个包在 profile 的 node_modules 里装没装。 */
export function pluginInfo(pkg, env) {
  const dir = join(profileDir(env), 'node_modules', ...String(pkg).split('/'))
  const pj = existsSync(dir) ? readPkg(dir) : null
  return {
    pkg,
    installed: !!pj,
    version: pj ? String(pj.version || '') : '',
    dir,
  }
}

function fishData(env) {
  const h = home({ env })
  return {
    rows: [
      ['便签（未划掉）', notes({ env }).length],
      ['预约（未了结）', appts({ env }).length],
      ['成长记录', events({ limit: 0, env }).length],
      ['首页轮数', h ? h.turns : 0],
    ],
  }
}

function memData(env) {
  const list = stores(env)
  // 条数按库文件逐个读；库多的时候只数前 40 个，够看个量级，不拖慢面板
  let count = 0
  for (const s of list.slice(0, 40)) {
    try { count += memoriesOf('', { env, storeFile: s.file }).length } catch {}
  }
  return {
    rows: [
      ['记忆库文件', list.length],
      ['记忆条数', count],
    ],
  }
}

/**
 * 协作页要的全部信息。installed=false 时 rows 为空，client 显示安装命令。
 * 任何一边读崩都只退化成 0 / 未安装，绝不抛。
 */
export function collabStatus(env) {
  const fishPlug = pluginInfo('@ssamurias/dsh-fish', env)
  const memPlug = pluginInfo('dsh-fish-memory', env)
  let fishRows = []
  let memRows = []
  if (fishPlug.installed) { try { fishRows = fishData(env).rows } catch {} }
  if (memPlug.installed) { try { memRows = memData(env).rows } catch {} }
  return {
    at: Date.now(),
    profile: profileName(env),
    profileDir: profileDir(env),
    sides: [
      {
        key: 'fish',
        name: '大肥鱼',
        ...fishPlug,
        page: '/dsh-fish',
        what: '14 个工具：约事、便签、心声、B 站看看/说话、梦与日记、成长记录；观测台和设置都在它自己的页面里。',
        install: 'dsh plugin --profile ' + profileName(env) + ' add @ssamurias/dsh-fish',
        rows: fishRows,
      },
      {
        key: 'memory',
        name: '鱼记忆',
        ...memPlug,
        page: '/dsh-fish-memory/page',
        what: '两个工具：remember / memory（按会话或工作区存事实、偏好、决定）；列表、合并、回填日期都在它自己的页面里。',
        install: 'dsh plugin --profile ' + profileName(env) + ' add dsh-fish-memory',
        rows: memRows,
      },
    ],
  }
}
