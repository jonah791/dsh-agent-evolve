/**
 * workspace-reset.test.mjs — 工作区重置判据的离线单测（node --test，跑 lib 产物）。
 *
 * 含**尸体测试**：样本取自 2026-09-23 现场的真实残留（不是编的），
 * 因为这条判据要防的正是「上一代产物留在 workspace/ 顶层」这个已发生的形态。
 * 运行：node --test tests/*.test.mjs（⚠ 目录形式 `node --test tests/` 在 Node 22 上是假红：把目录当测试文件执行）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  WORKSPACE_BASELINE,
  looksLikeWorkspace,
  planWorkspaceReset,
  workspaceSetDiff,
  sweptSummary,
  workspaceResetMessage,
} from '../lib/workspace-reset.js'

/** 2026-09-23 现场实测的残留（`ls -A modeltest/workspace` 抄下来的，非虚构）。 */
const REAL_LEFTOVERS = [
  '_esp_verify.py',
  '_evidence',
  '_evidence_v41',
  '_net_syntax_check.cpp',
  '_selftest_behaviors.py',
  '_selftest_esp_paths.py',
  '_selftest_legacy_paths.py',
  '_selftest_voice.py',
  '_selftest_voice_nosess.py',
  '_tmp_onboard_full.md',
  '_tmp_review',
  '_tmp_review_stub',
  'project2_task_tree.txt',
]

/** 现场同一次 `ls -A` 读出的基线项。 */
const REAL_BASELINE = ['ONBOARDING_TODO.md', 'project2_task', 'reference', 'tests', 'tools']

test('尸体样本：13 项真实残留全部进 remove，基线项一项不动', () => {
  const plan = planWorkspaceReset([...REAL_BASELINE, ...REAL_LEFTOVERS])
  assert.deepEqual(plan.remove, [...REAL_LEFTOVERS].sort(), '每一处真实残留都必须被判为要清')
  assert.deepEqual(plan.keep, [...REAL_BASELINE].sort(), '基线项不得被清（清了就是删脚手架）')
})

test('集合差：残留还在 ⇒ ok=false 且 extra 逐项点名（不静默）', () => {
  const diff = workspaceSetDiff([...REAL_BASELINE, '_evidence_v41', '_selftest_voice.py'])
  assert.equal(diff.ok, false)
  assert.deepEqual(diff.extra, ['_evidence_v41', '_selftest_voice.py'])
  assert.deepEqual(diff.missing, [])
})

test('集合差：清干净 ⇒ ok=true（这就是「重置完成」的唯一判据）', () => {
  const diff = workspaceSetDiff(REAL_BASELINE)
  assert.equal(diff.ok, true)
  assert.deepEqual(diff.extra, [])
  assert.deepEqual(diff.missing, [])
})

test('集合差：缺基线项（脚手架被误删/项目未生成）⇒ ok=false 且 missing 点名', () => {
  const diff = workspaceSetDiff(['ONBOARDING_TODO.md', 'reference', 'tests'])
  assert.equal(diff.ok, false)
  assert.deepEqual(diff.missing, ['project2_task', 'tools'])
})

test('幂等：对已干净的集合再跑一次 ⇒ 无残留可清（重复重置不产生动作）', () => {
  const plan = planWorkspaceReset(REAL_BASELINE)
  assert.deepEqual(plan.remove, [])
  assert.equal(sweptSummary(plan), '无残留')
})

test('防误删：配置指错路径（无脚手架锚）⇒ looksLikeWorkspace=false，调用方据此拒绝动手', () => {
  assert.equal(looksLikeWorkspace(REAL_BASELINE), true, '真工作区必须被认出来')
  assert.equal(looksLikeWorkspace(REAL_LEFTOVERS), false, '只有残留、没有脚手架 ⇒ 不是工作区')
  assert.equal(looksLikeWorkspace([]), false, '空目录 ⇒ 不是工作区（拒绝在空目录上动手）')
  assert.equal(looksLikeWorkspace(['node_modules', 'src', 'package.json']), false, '插件目录不得被误认')
})

test('基线常量本身自洽：非空、无重复、含 project2_task 与三个脚手架锚', () => {
  assert.ok(WORKSPACE_BASELINE.length >= 4)
  assert.equal(new Set(WORKSPACE_BASELINE).size, WORKSPACE_BASELINE.length, '基线不得有重复项')
  for (const must of ['project2_task', 'reference', 'tests', 'tools']) {
    assert.ok(WORKSPACE_BASELINE.includes(must), '基线缺 ' + must)
  }
})

test('报错文本带上判据与读数（定位不靠考古）', () => {
  const msg = workspaceResetMessage(workspaceSetDiff([...REAL_BASELINE, '_evidence_v41']))
  assert.match(msg, /_evidence_v41/)
  assert.match(msg, /基线/)
  assert.match(msg, /不派发/)
})
