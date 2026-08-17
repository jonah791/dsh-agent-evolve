/** 配置仓库 / 账本 / 锚点链持久化（JSON 文件）。 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Ledger, Resource, ResourceId, ResourceVersion, RunState, Generation } from './types.ts'

export class EvolveStore {
  constructor(
    readonly dataDir: string,
    readonly modeltestDir: string,
    readonly mainSessionId: string,
    readonly compositionSource: string,
  ) {
    mkdirSync(join(dataDir, 'resources'), { recursive: true })
    mkdirSync(join(dataDir, 'runs'), { recursive: true })
  }

  private ledgerPath = () => join(this.dataDir, 'ledger.json')

  readLedger(): Ledger | null {
    try {
      return JSON.parse(readFileSync(this.ledgerPath(), 'utf8')) as Ledger
    } catch {
      return null
    }
  }

  writeLedger(l: Ledger): void {
    writeFileSync(this.ledgerPath(), JSON.stringify(l, null, 2), 'utf8')
  }

  ensureLedger(): Ledger {
    const existing = this.readLedger()
    if (existing?.initialized) return existing
    const ledger: Ledger = {
      initialized: true,
      modeltestDir: this.modeltestDir,
      mainSessionId: this.mainSessionId,
      compositionSource: this.compositionSource,
      createdAt: new Date().toISOString(),
      resources: {} as Ledger['resources'],
      active: {},
      generations: [],
      edits: [],
      rollbacks: [],
    }
    this.writeLedger(ledger)
    return ledger
  }

  private resourceDir(id: ResourceId) {
    return join(this.dataDir, 'resources', id)
  }

  /** 添加资源版本（vX.Y 递增）；返回版本号。 */
  addVersion(l: Ledger, id: ResourceId, content: string, note: string): string {
    const res = l.resources[id] ?? { id, versions: [], anchors: [] }
    const last = res.versions.at(-1)
    const version = nextVersion(last?.version)
    const prev = last?.content ?? ''
    const diff = lineDiff(prev, content)
    res.versions.push({ version, content, note, at: new Date().toISOString(), diff })
    l.resources[id] = res
    mkdirSync(this.resourceDir(id), { recursive: true })
    writeFileSync(join(this.resourceDir(id), version + '.txt'), content, 'utf8')
    this.writeLedger(l)
    return version
  }

  /** 读取资源某版本内容；缺省当前浮动版本，再缺省锚点。 */
  contentOf(l: Ledger, id: ResourceId): string {
    const res = l.resources[id]
    if (!res) return ''
    const active = l.active[id]
    const version = active ?? res.anchors.at(-1) ?? res.versions.at(-1)?.version
    const v = res.versions.find((x) => x.version === version)
    return v?.content ?? res.versions.at(-1)?.content ?? ''
  }

  /** 当前浮动版本号（无则锚点）。 */
  versionOf(l: Ledger, id: ResourceId): string {
    const res = l.resources[id]
    if (!res) return 'v0.0'
    return l.active[id] ?? res.anchors.at(-1) ?? res.versions.at(-1)?.version ?? 'v0.0'
  }

  /** 最近锚点版本号。 */
  anchorOf(l: Ledger, id: ResourceId): string {
    const res = l.resources[id]
    return res?.anchors.at(-1) ?? res?.versions.at(-1)?.version ?? 'v0.0'
  }

  writeRun(r: RunState): void {
    writeFileSync(join(this.dataDir, 'runs', r.runId + '.json'), JSON.stringify(r, null, 2), 'utf8')
  }

  readRun(runId: string): RunState | null {
    try {
      return JSON.parse(readFileSync(join(this.dataDir, 'runs', runId + '.json'), 'utf8')) as RunState
    } catch {
      return null
    }
  }

  listRuns(): RunState[] {
    const dir = join(this.dataDir, 'runs')
    if (!existsSync(dir)) return []
    return readdirSafe(dir).filter((f) => f.endsWith('.json')).map((f) => {
      try { return JSON.parse(readFileSync(join(dir, f), 'utf8')) as RunState } catch { return null }
    }).filter((x): x is RunState => x !== null).sort((a, b) => a.at.localeCompare(b.at))
  }
}

export function nextVersion(v?: string): string {
  if (!v) return 'v0.0'
  const m = v.match(/^v(\d+)\.(\d+)$/)
  if (!m) return 'v0.0'
  const major = Number(m[1])
  const minor = Number(m[2])
  if (minor < 9) return 'v' + major + '.' + (minor + 1)
  return 'v' + (major + 1) + '.0'
}

/** 行级 diff 摘要（v1 简化：统计 + 首变行）。 */
export function lineDiff(oldText: string, newText: string): { added: number; removed: number; firstChangedLine?: number; newLength: number } {
  const a = oldText.split(/\r?\n/)
  const b = newText.split(/\r?\n/)
  let added = 0
  let removed = 0
  let first: number | undefined
  const max = Math.max(a.length, b.length)
  for (let i = 0; i < max; i++) {
    if (a[i] !== b[i]) {
      if (a[i] !== undefined) removed++
      if (b[i] !== undefined) added++
      if (first === undefined) first = i + 1
    }
  }
  return { added, removed, firstChangedLine: first, newLength: b.length }
}

function readdirSafe(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}
