/**
 * 孤儿 run 判据单测（t-a19d7800）
 *
 * 现场（非构造）：
 * - 存量 6 条孤儿：gen2 / gen4×2 / gen8 / gen9 / gen10（全部停在 `pending`）。
 * - gen10 child `c704e8bf-…`：512 事件 / 74 步，末三事件
 *   `step/start → assistant/attempt(stream:[]) → step/end`，**无 `turn/end`**；其后 8 小时无 boot。
 * - 真因另有条目：归档 `_tmp_review` 时把**活跃工作区 modeltest 一起搬走** ⇒ 配置指向的目录不存在。
 *
 * 运行：`node --test tests/*.test.mjs`（先 `npm run build` 产出 lib/）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_EXPECTED_MS,
  DEFAULT_GRACE_FACTOR,
  TRUNCATED_CAVEAT,
  describeOrphan,
  findOrphans,
  isTerminal,
  reapNote,
  scanSessionOutcome,
  workspaceMissingMessage,
  workspaceStatus,
} from '../lib/orphans.js'

const NOW = Date.parse('2026-09-22T19:00:00+08:00')
const ago = (minutes) => new Date(NOW - minutes * 60_000).toISOString()

const run = (over) => ({ runId: 'gen10-x', gen: 10, status: 'pending', at: ago(10), ...over })

// ── ① 超期判据 ─────────────────────────────────────────────────────────────

test('★ 尸体样本（gen10 形状）：派发 2 小时仍 pending ⇒ 判为孤儿，且带超期量', () => {
  const out = findOrphans([run({ at: ago(120) })], NOW)
  assert.equal(out.length, 1, '2 小时 > 30 分钟 × 3 ⇒ 必须入选')
  assert.equal(out[0].runId, 'gen10-x')
  assert.equal(out[0].expectedMs, DEFAULT_EXPECTED_MS)
  // 120min - 30min×3 = 30min 超期
  assert.equal(Math.round(out[0].overdueByMs / 60_000), 30, '超期量必须可读出（不是布尔）')
})

test('对照组：刚派发 10 分钟 ⇒ **不得**判孤儿（正在跑，不是孤儿）', () => {
  assert.deepEqual(findOrphans([run({ at: ago(10) })], NOW), [], '误报会让人去 reap 一个其实在跑的轮')
})

test('对照组：很久以前的 **done** ⇒ 永不入选（终态不需要收尸）', () => {
  assert.deepEqual(findOrphans([run({ at: ago(10_000), status: 'done' })], NOW), [])
  assert.deepEqual(findOrphans([run({ at: ago(10_000), status: 'failed' })], NOW), [])
  assert.equal(isTerminal('done'), true)
  assert.equal(isTerminal('pending'), false)
})

test('running 也会变孤儿（不只是 pending）——失败落在「跑了但没收尾」上同样无人知', () => {
  const out = findOrphans([run({ at: ago(200), status: 'running' })], NOW)
  assert.equal(out.length, 1)
  assert.equal(out[0].status, 'running')
})

test('期望时长可逐轮覆盖（run 自带 expectedMs 优先于缺省）', () => {
  const short = run({ at: ago(10), expectedMs: 60_000 })   // 期望 1 分钟 ⇒ 10 分钟已超 3×
  assert.equal(findOrphans([short], NOW).length, 1)
  const long = run({ at: ago(120), expectedMs: 6 * 3_600_000 })  // 期望 6 小时 ⇒ 2 小时不算超
  assert.equal(findOrphans([long], NOW).length, 0)
})

test('★ 时刻不可解析 ⇒ **不判孤儿**（宁可漏报，不误报——误报会诱发错误的 reap）', () => {
  assert.deepEqual(findOrphans([run({ at: 'not-a-date' })], NOW), [])
})

test('排序：超期最久的排最前（收尸优先级）', () => {
  const out = findOrphans([run({ runId: 'a', at: ago(100) }), run({ runId: 'b', at: ago(500) })], NOW)
  assert.deepEqual(out.map((o) => o.runId), ['b', 'a'])
})

test('宽限倍数可调；默认常量与「30 分钟 × 3」的语义被钉住', () => {
  assert.equal(DEFAULT_GRACE_FACTOR, 3)
  assert.equal(DEFAULT_EXPECTED_MS, 30 * 60_000)
  assert.equal(findOrphans([run({ at: ago(95) })], NOW, 1).length, 1, '宽限 1× ⇒ 95 分钟（>30）入选')
  assert.equal(findOrphans([run({ at: ago(25) })], NOW, 1).length, 0, '宽限 1× ⇒ 25 分钟（<30）不入选')
})

test('describeOrphan 是人读文本：含 runId / gen / 状态 / 小时数', () => {
  const s = describeOrphan(findOrphans([run({ at: ago(120) })], NOW)[0])
  assert.ok(s.includes('gen10-x') && s.includes('gen10') && s.includes('pending'), s)
  assert.ok(s.includes('2.0h'), '派发时长以小时呈现：' + s)
})

// ── ② 截断判定（会话尾部有没有闭合的 turn/end）──────────────────────────────

const reader = (types) => (seq) => (seq < types.length ? { type: types[seq] } : undefined)

test('★ 尸体样本（gen10 现场形状）：尾部 turn/start → step/start → assistant/attempt → step/end ⇒ 判截断', () => {
  const types = [
    'turn/start', 'turn/end',                    // 上一轮：完整
    'turn/start', 'step/start', 'assistant/attempt', 'step/end',   // 本轮：无 turn/end
  ]
  const r = scanSessionOutcome(reader(types), types.length - 1)
  assert.equal(r.truncated, true, '末轮无 turn/end ⇒ 截断（其读数不可当完整轮比较）')
  assert.ok(r.lastTypes.includes('step/end'), '尾部事件类型要能读出（诊断用）')
})

test('对照组：末轮以 turn/end 收尾 ⇒ **不得**判截断', () => {
  const types = ['turn/start', 'step/start', 'step/end', 'turn/end']
  assert.equal(scanSessionOutcome(reader(types), types.length - 1).truncated, false)
})

test('空会话（无任何事件）⇒ 判截断（连 end 都没有比「末轮未闭合」更可疑）', () => {
  assert.equal(scanSessionOutcome(reader([]), 0).truncated, true)
})

test('回溯窗口：只看尾部 lookback 个事件（长会话不可 O(n) 每次重扫）', () => {
  // 真正闭合的 end 落在窗口之外 ⇒ 窗口内只见 turn/start ⇒ 判截断（有界回溯的已知代价，显式承认）
  const types = ['turn/start', 'turn/end', ...Array(500).fill('step/start')]
  assert.equal(scanSessionOutcome(reader(types), types.length - 1, 10).truncated, true)
})

test('截断与收尸都有**固定措辞**（防未来把截断读数误读成能力回归）', () => {
  assert.ok(TRUNCATED_CAVEAT.includes('截断提交') && TRUNCATED_CAVEAT.includes('不可与完整轮直接比较'))
  assert.equal(reapNote('超期'), 'reaped：超期')
})

// ── ③ 派发前的工作区体检（件 1：治未乱）────────────────────────────────────

const fakeJoin = (...p) => p.join('/')

test('★ 尸体样本（09-13 真因形状）：配置指向的工作区不在盘上 ⇒ 判缺失（调用方据此拒绝派发）', () => {
  const r = workspaceStatus('E:/alice/_tmp_review/modeltest', () => false, fakeJoin)
  assert.equal(r.missing, true)
  assert.equal(r.project, 'E:/alice/_tmp_review/modeltest/workspace/project2_task')
  const msg = workspaceMissingMessage(r.project, 'E:/alice/_tmp_review/modeltest')
  assert.ok(msg.includes('未派发') && msg.includes('2026-09-13'),
    '错误文本要把**已知真因**写进去（否则下次还得考古）：' + msg)
})

test('对照组：工作区在盘上 ⇒ 不判缺失（不得误拦正常派发）', () => {
  assert.equal(workspaceStatus('/x', () => true, fakeJoin).missing, false)
})

test('真 IO 交叉验证：真 existsSync + 真 join 下，合成的不存在路径确实被判缺失', () => {
  // 防止「注入探针」把判据架空——这一条用的是真文件系统
  assert.equal(workspaceStatus('/nonexistent-root-for-test-only', existsSync, join).missing, true)
})
