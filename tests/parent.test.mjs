/**
 * parent.test.mjs — selectParentAgent 离线单测（node --test，跑 lib 产物）。
 *
 * 含**尸体测试**：用 2026-09-11 的真实事故样本（配置锚点 session-5a785c96… 已不在场）
 * 验证解析器会回退到当前活跃根 agent，而不是像旧实现那样抛「找不到主会话 agent」把主线打死。
 * 运行：node --test tests/
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectParentAgent, rootDepthOf } from '../lib/parent.js'

/** 造一个最小 agent 形状（只带解析需要的字段）。 */
const agentOf = (id, depth) => ({ id, session: { header: depth === undefined ? {} : { delegationDepth: depth } } })

test('尸体样本：配置锚点已腐化（不在场）→ 回退到当前活跃根 agent，而不是抛错', () => {
  // 现场：patch 里写死 session-5a785c96（已不在场），实际在场的是 session-89516696
  const live = agentOf('session-89516696', 0)
  const picked = selectParentAgent('session-5a785c96-d682-4290-9641-ca8213abba8f', undefined, [live])
  assert.ok(!('error' in picked), '必须回退成功，不得报错（旧实现即死于此）')
  assert.equal(picked.agent.id, 'session-89516696')
})

test('配置锚点在场地 → 优先用锚点（向后兼容，不改变既有语义）', () => {
  const pinned = agentOf('session-pinned', 0)
  const other = agentOf('session-other', 0)
  const picked = selectParentAgent('session-pinned', pinned, [other, pinned])
  assert.ok(!('error' in picked))
  assert.equal(picked.agent.id, 'session-pinned')
})

test('无任何活跃 agent → 响亮错误（含 agents=0 与配置锚点回显，便于定位）', () => {
  const picked = selectParentAgent('session-stale', undefined, [])
  assert.ok('error' in picked, '必须显式失败——静默 fallback 会让主线再次静默失效')
  assert.match(picked.error, /找不到主会话 agent/)
  assert.match(picked.error, /agents=0/)
  assert.match(picked.error, /session-stale/)
})

test('只有子代理在场（delegationDepth>0）→ 报错，不得把子代理当父', () => {
  const sub = agentOf('sub-1', 1)
  const picked = selectParentAgent('', undefined, [sub])
  assert.ok('error' in picked)
  assert.match(picked.error, /agents=1/)
})

test('多个根 agent → 取最新激活的一个（列表末尾）', () => {
  const a = agentOf('session-a', 0)
  const b = agentOf('session-b', 0)
  const picked = selectParentAgent('', undefined, [a, b])
  assert.ok(!('error' in picked))
  assert.equal(picked.agent.id, 'session-b')
})

test('delegationDepth 缺省视为根 agent（主会话的常见形态）', () => {
  assert.equal(rootDepthOf(agentOf('x', undefined)), 0)
  assert.equal(rootDepthOf(agentOf('y', 0)), 0)
  assert.equal(rootDepthOf(agentOf('z', 2)), 2)
  assert.equal(rootDepthOf(null), 0)
  const picked = selectParentAgent('', undefined, [agentOf('no-depth', undefined)])
  assert.ok(!('error' in picked))
  assert.equal(picked.agent.id, 'no-depth')
})
