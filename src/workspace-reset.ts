/**
 * workspace-reset.ts — 工作区重置的契约与集合差判据（纯函数 · t-d20b129c）
 *
 * ## 事故（2026-09-23 发现 · 同族第三例）
 * `evolve_round_start` 的说明是「工作区已重置」，但 `make_broken_project.py` 的
 * `reset_workspace()` 只在 **`workspace/project2_task/` 内部**跑 `git checkout .` +
 * `git clean -fdx`（`cwd=TASK_PROJECT`）⇒ **`workspace/` 这一层除 `project2_task` 外一律不被清理**。
 * 实测残留（2026-09-23 现场）：`_evidence/`（09-20）· `_evidence_v41/`（09-23）·
 * `_selftest_*.py` ×5 · `_tmp_review/` · `_tmp_review_stub/` · `_tmp_onboard_full.md` ·
 * `project2_task_tree.txt` · `_esp_verify.py` · `_net_syntax_check.cpp`。
 * ⇒ **跨代污染**：第 N+1 代的 child 会看到第 N 代留下的产物，10 代账本的跨代可比性受威胁。
 *
 * 同族前两例：① 2026-09-11 配置腐化（`mainSessionId` 写死 → 已由 `parent.ts` 修）
 * ② 2026-09-20 归档搬走活跃工作区（已由 `workspaceStatus` 修）。本模块补第三例。
 *
 * ## 本模块只做裁决，不做 IO
 * 判据：**重置后 `workspace/` 的顶层条目集 == 声明的干净基线集**（集合差为空）。
 * 只报「多了什么、少了什么」；真正的删除与断言由调用方执行（IO 留在 `index.ts`）。
 */

/**
 * `workspace/` 顶层**应当**存在的条目——干净基线的唯一真源。
 *
 * 前四项是随 harness 发布的脚手架（重置不会动它们），`project2_task` 是本轮由
 * `make_broken_project.py` 生成/重置的坏项目。**不在这个集合里的顶层条目一律是上一代的残留。**
 * 若 harness 将来新增脚手架条目，`workspaceSetDiff` 会以 `extra` 响亮报出（fail-loud 而非静默扩大删除面）。
 */
export const WORKSPACE_BASELINE = ['ONBOARDING_TODO.md', 'project2_task', 'reference', 'tests', 'tools'] as const

/** 认出「这确实是 modeltest 工作区」的锚——缺一即拒绝动手（防配置指错路径时误删）。 */
const WORKSPACE_ANCHORS = ['reference', 'tests', 'tools'] as const

/** 一次重置的裁决：留什么、清什么。 */
export interface WorkspaceResetPlan {
  readonly keep: readonly string[]
  readonly remove: readonly string[]
}

/** 重置后的集合差（判据读数）。 */
export interface WorkspaceSetDiff {
  /** 基线之外的残留（未清干净） */
  readonly extra: readonly string[]
  /** 基线里缺失的条目（脚手架被误删 / 项目未生成） */
  readonly missing: readonly string[]
  readonly ok: boolean
}

/**
 * 这个目录像不像 modeltest 工作区。
 *
 * 判据是**脚手架锚**而不是「目录存在」：脚手架随 harness 发布、重置不会动它，
 * 因此它在任何一次重置前后都应当在场。用于在配置指错路径时**拒绝动手**。
 *
 * @param entries - 目录顶层条目名
 * @returns 三个脚手架锚至少命中一个
 */
export function looksLikeWorkspace(entries: readonly string[]): boolean {
  const seen = new Set(entries)
  return WORKSPACE_ANCHORS.some(anchor => seen.has(anchor))
}

/**
 * 算出该清哪些、该留哪些。
 *
 * @param entries - `workspace/` 顶层条目名（调用方 `readdirSync` 读出）
 * @returns `keep` = 基线内条目；`remove` = 其余（上一代残留），两者按名排序
 */
export function planWorkspaceReset(entries: readonly string[]): WorkspaceResetPlan {
  const baseline = new Set<string>(WORKSPACE_BASELINE)
  const keep: string[] = []
  const remove: string[] = []
  for (const name of [...entries].sort()) {
    if (baseline.has(name)) keep.push(name)
    else remove.push(name)
  }
  return { keep, remove }
}

/**
 * 重置**后**的集合差——判据本体。
 *
 * @param after - 重置后 `workspace/` 顶层条目名
 * @returns `extra` 非空 = 没清干净；`missing` 非空 = 缺基线项；`ok` = 两者皆空
 */
export function workspaceSetDiff(after: readonly string[]): WorkspaceSetDiff {
  const baseline = new Set<string>(WORKSPACE_BASELINE)
  const seen = new Set(after)
  const extra = [...seen].filter(name => !baseline.has(name)).sort()
  const missing = [...baseline].filter(name => !seen.has(name)).sort()
  return { extra, missing, ok: extra.length === 0 && missing.length === 0 }
}

/** 清理动作的一行人读摘要（进工具输出，让「清掉了什么」可审计而非静默）。 */
export function sweptSummary(plan: WorkspaceResetPlan): string {
  if (plan.remove.length === 0) return '无残留'
  return plan.remove.length + ' 项：' + plan.remove.join(' · ')
}

/** 集合差不通过时的报错文本（把判据与读数一起给出来，不让人再考古）。 */
export function workspaceResetMessage(diff: WorkspaceSetDiff): string {
  const parts: string[] = ['工作区重置未达干净基线（判据：workspace/ 顶层条目集 == 基线集）']
  if (diff.extra.length > 0) parts.push('未清干净的残留：' + diff.extra.join(' · '))
  if (diff.missing.length > 0) parts.push('缺失的基线项：' + diff.missing.join(' · '))
  parts.push('基线：' + WORKSPACE_BASELINE.join(' · '))
  parts.push('本轮**不派发**——跨代污染的读数不可与历史各代比较（见 t-d20b129c）。')
  return parts.join('；')
}
