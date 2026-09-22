/**
 * orphans.ts — 孤儿 run 的识别、裁决与「截断提交」判定（纯函数 · t-a19d7800）
 *
 * ## 事故（2026-09-20 21:27 感知圈发现）
 * `spawn → submit` 环会**断**：child 回合被撕裂（**无 `turn/end`**）后，run 永久停在 `pending`
 * ——**没有通知、没有收尸、没有 abandon 原语**。存量 6 条孤儿（gen2 / gen4×2 / gen8 / gen9 / gen10）。
 *
 * 已证真因（本条此前另有条目）：2026-09-13 归档 `_tmp_review` 时把**活跃工作区 modeltest 一起搬走**
 * ⇒ 配置指向的目录不存在 ⇒ 该轮无从下手。**本轮新增证据**：gen10 child `c704e8bf-…`
 * 512 事件 / 74 步，末三事件 `step/start → assistant/attempt(stream:[]) → step/end`，**无 `turn/end`**；
 * 其后 8 小时内无 boot（**非重启致死**）。收集圈被成本约束改期时静默吞掉 ⇒ 9 小时无人发现。
 *
 * ## 本模块只做裁决，不做 IO
 * 判据方向（治未乱优先于事后收尸）：
 * ① **超期**：`pending`/`running` 且「现在 − 派发时刻」超过 `期望时长 × 宽限倍数` ⇒ 孤儿
 * ② **截断**：会话尾部有 `turn/start` 而其后**无** `turn/end` ⇒ 该轮被打断（gen10 形状）
 */

/** 一轮 modeltest 的**期望时长**（缺省 30 分钟）。写进 RunState 后，超期判据就有基准。 */
export const DEFAULT_EXPECTED_MS = 30 * 60_000

/** 宽限倍数：超过「期望时长 × 3」才算孤儿（避免把正常慢轮误判成孤儿）。 */
export const DEFAULT_GRACE_FACTOR = 3

/** 终态（不需要收尸的状态）。 */
export function isTerminal(status: string): boolean {
  return status === 'done' || status === 'failed'
}

/** 一条被判为孤儿的 run（含判据读出的量，便于人核对）。 */
export interface OrphanScan {
  readonly runId: string
  readonly gen: number
  readonly status: string
  /** 派发时刻到 now 的毫秒数（`at` 不可解析 ⇒ -1，且**不因此判孤儿**，见下） */
  readonly ageMs: number
  /** 本轮的期望时长（run 自带优先，缺省用 DEFAULT_EXPECTED_MS） */
  readonly expectedMs: number
  /** 超出宽限线的毫秒数（> 0 即孤儿） */
  readonly overdueByMs: number
}

/**
 * 扫出孤儿。
 *
 * @param runs - 全部 run（`store.listRuns()` 的读出）
 * @param nowMs - 现在（注入以便测）
 * @param graceFactor - 宽限倍数（缺省 3）
 * @returns 孤儿清单（按超期时长降序；**终态 run 永不入选**）
 */
export function findOrphans(
  runs: readonly RunStateLike[],
  nowMs: number,
  graceFactor: number = DEFAULT_GRACE_FACTOR,
): OrphanScan[] {
  const out: OrphanScan[] = []
  for (const r of runs) {
    if (isTerminal(r.status)) continue
    const at = Date.parse(r.at)
    // 时刻不可解析 ⇒ **不判孤儿**（宁可漏报也不误报：误报会让人去 reap 一个其实在跑的轮）
    if (!Number.isFinite(at)) continue
    const expectedMs = typeof r.expectedMs === 'number' && r.expectedMs > 0 ? r.expectedMs : DEFAULT_EXPECTED_MS
    const ageMs = nowMs - at
    const overdueByMs = ageMs - expectedMs * graceFactor
    if (overdueByMs <= 0) continue
    out.push({ runId: r.runId, gen: r.gen, status: r.status, ageMs, expectedMs, overdueByMs })
  }
  return out.sort((a, b) => b.overdueByMs - a.overdueByMs)
}

/** findOrphans 需要的最小形状（避免与 store 循环依赖）。 */
export interface RunStateLike {
  readonly runId: string
  readonly gen: number
  readonly status: string
  readonly at: string
  readonly expectedMs?: number
}

/** 一行人读描述（用于通知文本与工具渲染）。 */
export function describeOrphan(o: OrphanScan): string {
  const h = (ms: number) => (ms / 3_600_000).toFixed(1) + 'h'
  return `${o.runId}（gen${o.gen} · ${o.status}）已派发 ${h(o.ageMs)}，超期 ${h(o.overdueByMs)}`
}

/**
 * 会话是否**被打断**（尾部有 `turn/start` 而其后无 `turn/end`）。
 *
 * @param read - 按 seq 读事件的读取器（调用方用 `session.eventAt` 包裹）
 * @param fromSeq - 起点（通常是 `session.seq`）
 * @param lookback - 向前回溯多少个事件（缺省 400，与 compaction 守望同量级）
 * @returns `truncated` + 尾部事件类型（诊断用）
 */
export function scanSessionOutcome(
  read: (seq: number) => unknown,
  fromSeq: number,
  lookback: number = 400,
): { truncated: boolean; lastTypes: string[] } {
  const floor = Math.max(0, fromSeq - lookback)
  let lastEndSeq = -1
  /** 在**尚未找到** turn/end 之前遇到的 turn/start ⇒ 它位于最近 end 之上 ⇒ 末轮未闭合 */
  let unclosedStart = false
  const lastTypes: string[] = []
  for (let seq = fromSeq; seq >= floor; seq -= 1) {
    const ev = read(seq) as { type?: unknown } | undefined | null
    if (ev === null || typeof ev !== 'object') continue
    const type = typeof ev.type === 'string' ? ev.type : ''
    if (type === '') continue
    if (lastTypes.length < 5) lastTypes.push(type)
    if (type === 'turn/end') {
      lastEndSeq = seq
      break // 判据已定：其上的 start 状态已记录；更低的 start 属于已闭合轮，不相关
    }
    if (type === 'turn/start') unclosedStart = true
  }
  // 窗口内**没有任何** turn/end ⇒ 整段没有闭合轮（比「末轮未闭合」更可疑，同样算截断）
  return { truncated: lastEndSeq < 0 || unclosedStart, lastTypes }
}

/** 截断提交的注记（写进 RunState.note 与账本代记，防未来把截断读数误读成能力回归）。 */
export const TRUNCATED_CAVEAT = '截断提交：child 会话无闭合 turn/end（读数不可与完整轮直接比较）'

/** 收尸注记（reap 留痕；不留痕的收尸 = 又一次静默）。 */
export function reapNote(reason: string): string {
  return 'reaped：' + reason
}

/**
 * 派发**前**的工作区体检（t-a19d7800 件 1：治未乱 > 事后收尸）。
 *
 * 抽成纯函数是为了**可测**——它原先藏在 `evolve_spawn` 的 execute 里，只有真派发才走得到，
 * 而真派发要花钱；而它要防的恰是「派发了却无从下手」。
 *
 * @param modeltestDir - 配置里的 modeltest 根
 * @param exists - 存在性探针（注入以便测；生产传 `existsSync`）
 * @returns 目标工作区路径 + 是否缺失（缺失 ⇒ 调用方必须**响亮报错且不派发**）
 */
export function workspaceStatus(
  modeltestDir: string,
  exists: (p: string) => boolean,
  joinPath: (...parts: string[]) => string,
): { project: string; missing: boolean } {
  const project = joinPath(modeltestDir, 'workspace', 'project2_task')
  return { project, missing: !exists(project) }
}

/** 工作区缺失时的报错文本（把已知真因写进错误里，而不是让人再去考古）。 */
export function workspaceMissingMessage(project: string, modeltestDir: string): string {
  return 'modeltest 工作区不存在：' + project + '（配置 modeltestDir=' + modeltestDir + '）'
    + '——该目录在盘上不存在，即 2026-09-13 事故形态（归档 `_tmp_review` 时把活跃工作区一起搬走）。'
    + '本轮**未派发、未写 run 记录**；请先恢复/重建工作区。'
}
