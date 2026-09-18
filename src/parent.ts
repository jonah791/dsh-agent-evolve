/**
 * parent.ts — 派发子智能体时「父 agent（主会话）」的解析（纯函数，可离线单测）。
 *
 * 为什么单独抽出来（AGENTS.md 自指循环：决策逻辑要与 IO 分离才能被证据检验）：
 * 2026-09-11 的事故形态是**配置腐化 → 主线静默失效**——profile patch 里写死的
 * `mainSessionId: session-5a785c96…` 随会话更替失效后，evolve_spawn 直接抛错，
 * 整条进化主线（本体规则集的量化基准）从 2026-08-17 起闲置 24 天无人察觉。
 * 处置：mainSessionId 降级为**优先锚点**，真源是「当前活跃的根 agent」；
 * 两者皆无时必须抛出**响亮**错误（列出在场 agent 数），不许静默 fallback。
 */

/** 根 agent 判据：delegationDepth 缺省或 0 为主会话；>0 是子代理，不可作父。 */
export function rootDepthOf(agent: unknown): number {
  const depth = (agent as { session?: { header?: { delegationDepth?: number } } } | null | undefined)
    ?.session?.header?.delegationDepth
  return typeof depth === 'number' ? depth : 0
}

/** 解析结果：命中 agent 或带诊断的失败（失败必须是显式的，不得返回 undefined）。 */
export type ParentSelection<T> = { agent: T } | { error: string }

/**
 * 选出父 agent。
 * 顺序：① 配置锚点（若能解析）→ ② 当前活跃根 agent 中最新的一个 → ③ 显式错误。
 * @param pinnedId - 配置里的主会话锚点（仅用于错误信息回显）
 * @param pinned - 配置锚点解析出来的 agent（不在场则为 undefined）
 * @param agents - 当前活跃 agent 列表
 */
export function selectParentAgent<T>(pinnedId: string, pinned: T | undefined, agents: T[]): ParentSelection<T> {
  if (pinned !== undefined) return { agent: pinned }
  const roots = agents.filter((a) => rootDepthOf(a) === 0)
  if (roots.length === 0) {
    return {
      error: '找不到主会话 agent：配置锚点 mainSessionId=' + (pinnedId || '(空)')
        + ' 不在场，且当前无活跃根 agent（agents=' + agents.length
        + '）——请先激活一个主会话',
    }
  }
  // 取最后一个（最新激活的根 agent）；并行实例场景由配置锚点覆盖
  return { agent: roots[roots.length - 1]! }
}
