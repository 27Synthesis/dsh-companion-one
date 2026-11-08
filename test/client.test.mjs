/**
 * 客户端面板接线测试：用假的 __ModuleLoader__ / slots 验证槽位注册与组件渲染不报错。
 */
import assert from 'node:assert/strict'

const registered = []
const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  useEffect: () => {},
  useCallback: (f) => f,
  useMemo: (f) => f(),
}
globalThis.window = {
  __ModuleLoader__: {
    load: ({ id, factory }) => {
      assert.equal(id, 'companion-one')
      const mod = factory((name) => {
        if (name === 'react') return React
        throw new Error('unexpected require: ' + name)
      })
      globalThis.__mod = mod
    },
  },
}

await import('../client.js')
const mod = globalThis.__mod
assert.equal(typeof mod.apply, 'function')

const slotsApi = {
  inject: (name, cb) => cb(),
  register: (spec, render) => { registered.push({ spec, render }); return () => {} },
}
mod.apply({ get: (k) => (k === 'slots' ? slotsApi : undefined) })

console.log('slots:', registered.map((r) => r.spec.name + ':' + (r.spec.id || r.spec.key)).join(', '))
assert.equal(registered.length, 2)
assert.ok(registered.some((r) => r.spec.name === 'settings.section' && r.spec.id === 'companion-one'))
assert.ok(registered.some((r) => r.spec.name === 'plugins.bundle.config' && r.spec.key === 'companion-one'))

// 渲染一次面板（数据未加载状态），确认不抛
for (const r of registered) {
  const el = r.render()
  assert.ok(el, 'panel renders')
}
console.log('\nCLIENT TEST PASSED')
