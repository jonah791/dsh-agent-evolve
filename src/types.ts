/** 跨代自评估进化插件 —— 共享类型。 */
export type ResourceId = 'agent-rules' | 'candidate-prompt' | 'composition'

export interface ResourceVersion {
  /** 版本号（v0.0 起） */
  version: string
  /** 内容全文 */
  content: string
  /** 编辑说明 */
  note: string
  /** 创建时间（ISO） */
  at: string
  /** diff 摘要（编辑产生） */
  diff?: { added: number; removed: number; firstChangedLine?: number; newLength: number }
}

export interface Resource {
  id: ResourceId
  versions: ResourceVersion[]
  /** 锚点版本号（已验证，按序） */
  anchors: string[]
}

export interface Generation {
  gen: number
  version: string
  runId: string
  sessionId?: string
  ability: number | null
  ship: number | null
  releaseClass: string | null
  dimensions: Record<string, number | null>
  at: string
  note: string
  /** 父的评估结论 */
  verdict?: string
}

export interface Ledger {
  initialized: boolean
  modeltestDir: string
  mainSessionId: string
  compositionSource: string
  createdAt: string
  resources: Record<ResourceId, Resource>
  /** 当前浮动版本（编辑后未验证） */
  active: Partial<Record<ResourceId, string>>
  generations: Generation[]
  edits: { version: string; resource: ResourceId; note: string; at: string; diff?: ResourceVersion['diff'] }[]
  rollbacks: { at: string; fromVersion: string; toVersion: string; note: string }[]
}

export interface RunState {
  runId: string
  gen: number
  sessionId?: string
  status: 'pending' | 'running' | 'done' | 'failed'
  at: string
  doneAt?: string
  note?: string
}
