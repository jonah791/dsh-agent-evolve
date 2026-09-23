/**
 * dsh-agent-evolve：跨代自评估进化插件。
 *
 * 核心信条：进化的最终受益主体是宿主 agent 本体（爱丽丝）。
 * - 本体资源（agent-rules）：编辑即热重载（AGENTS.md 每 turn 重读），
 *   子智能体（subagent）继承本体配置（白纸 + 系统上下文）。
 * - 顺序：先热重载（修改立即作用到本体）→ 子智能体继承验证 → 分数对比
 *   → 提升/持平则 commit（新锚点），降低则撤回（回滚到最近锚点）。
 * - 评测：宿主侧调用 modeltest run_full_eval.py（冻结评分面 + hidden 隔离）。
 * - 控制变量：子智能体无对话历史、无账本、无经验注入——唯一变量是本体配置版本。
 * @module dsh-agent-evolve
 */
import { readFileSync, writeFileSync, existsSync, appendFileSync, readdirSync, rmSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-subagent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { EvolveStore } from './store.ts'
import { selectParentAgent } from './parent.ts'
// t-a19d7800：孤儿治理——超期识别、收尸留痕、截断提交判定（纯函数）
import {
  DEFAULT_EXPECTED_MS,
  TRUNCATED_CAVEAT,
  describeOrphan,
  findOrphans,
  reapNote,
  scanSessionOutcome,
  workspaceMissingMessage,
  workspaceStatus,
} from './orphans.ts'
// t-d20b129c：工作区重置契约——`workspace/` 顶层跨代残留的清理与集合差判据（纯函数）
import {
  looksLikeWorkspace,
  planWorkspaceReset,
  sweptSummary,
  workspaceResetMessage,
  workspaceSetDiff,
} from './workspace-reset.ts'
import { renderPreset } from './presets.ts'
import { runFullEval } from './evaluator.ts'
import type { Ledger, ResourceId } from './types.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-agent-evolve': { kind: 'dsh-agent-evolve' }
  }
}

export const name = 'agent-evolve'
export const inject = ['tools', 'agents', 'subagents'] as const

export interface Config {
  modeltestDir: string
  workspaceDir: string
  /**
   * 主会话锚点（可选）。**只作优先锚点**，不作唯一真源——见 apply 内 resolveParentAgent 的
   * 2026-09-11 修复说明：写死的 session id 会随会话更替腐化，导致 evolve_spawn 抛错、
   * 整条进化主线静默失效。留空则自动解析当前活跃根 agent。
   */
  mainSessionId: string
  pythonBin: string
  dshHome: string
  dataDir: string
  evalTimeoutMs: number
}
export const Config = z.object({
  modeltestDir: z.string(),
  workspaceDir: z.string(),
  mainSessionId: z.string().default(''),
  pythonBin: z.string().default('python'),
  // 2026-08-30 对齐：DSH_HOME 已从 C:/Users/tr/.dsh 迁移到 E:/alice/.dsh（8-21）；默认值跟随环境变量，防陈旧路径兜底踩坑
  dshHome: z.string().default(process.env.DSH_HOME || ''),
  dataDir: z.string().default(process.env.DSH_HOME ? process.env.DSH_HOME + '/.evolve' : 'E:/alice/.evolve'),
  evalTimeoutMs: z.number().default(1500000),
})

const RULES_FILE = 'AGENTS.md'
const RULES_MARKER_START = '<!-- dsh-agent-evolve:start -->'
const RULES_MARKER_END = '<!-- dsh-agent-evolve:end -->'

export function apply(ctx: Context, config: Config): void {
  const store = new EvolveStore(config.dataDir, config.modeltestDir, config.mainSessionId, '')

  /**
   * 解析派发子智能体所需的父 agent（= 当前主会话）。
   *
   * 2026-09-11 修复（**配置腐化导致进化主线静默失效**）：旧实现直接
   * `ctx.agents.get(config.mainSessionId)`，而配置里的 session id 是**写死在 profile patch**
   * 里的（session-5a785c96…）。会话更替后该 id 不再在场 → evolve_spawn 直接抛
   * 「找不到主会话 agent」→ **整条进化主线（本体规则集的量化基准）在无人察觉下失效**
   * （最后成功评测 2026-08-17，闲置 24 天，是主人要求「发起评测轮」时才暴露的）。
   *
   * 正确语义：mainSessionId 是「当时的主会话」快照，只能当**优先锚点**，不能当唯一真源。
   * 解析顺序：配置锚点（若能解析）→ 当前活跃根 agent（delegationDepth 0 / 缺省）；
   * 两者皆无 → 抛**响亮**错误（列出在场 agent 数，便于定位，不静默）。
   */
  const resolveParentAgent = (): Agent => {
    const pinned = config.mainSessionId ? ctx.agents.get(config.mainSessionId as SessionId) : undefined
    const picked = selectParentAgent(config.mainSessionId, pinned as Agent | undefined, ctx.agents.list() as Agent[])
    if ('error' in picked) throw new Error(picked.error)
    return picked.agent
  }

  /** 孤儿侧车轨迹路径（§5.22：关键机制不得只写 logger——日志无人读 = 静默失效）。 */
  const orphansTracePath = join(config.dataDir, 'orphans.jsonl')

  /**
   * 孤儿自检（t-a19d7800 件 3 的「通知」半）。
   *
   * 事故形态：spawn→submit 环断掉后 run 永久停在 `pending`，**没有通知、没有收尸**
   * （存量 6 条 gen2/gen4×2/gen8/gen9/gen10；gen10 之后 9 小时无人发现，还是感知圈撞见的）。
   * 纪律：① §5.10「静默失败 = 死亡温床」——本应发生却没发生的事必须被说出来；
   * ② §5.22——留痕要**落盘**（侧车 jsonl），不能只 log；
   * ③ §5.24——启动自检与宿主同进程，**绝不允许抛出**（逃逸异常直接杀 web）。
   */
  const scanOrphansAtBoot = (): void => {
    try {
      const orphans = findOrphans(store.listRuns(), Date.now())
      if (orphans.length === 0) return
      try {
        appendFileSync(orphansTracePath, JSON.stringify({
          at: new Date().toISOString(),
          count: orphans.length,
          orphans: orphans.map(describeOrphan),
        }) + '\n', 'utf8')
      } catch { /* 落盘失败不阻塞加载 */ }
      // 尽力告知主会话；解析不到父 agent 不算错（侧车已留痕，不构成静默）
      try {
        const parent = resolveParentAgent()
        const text = '【进化孤儿】发现 ' + orphans.length + ' 条超期 run（spawn→submit 环已断）：\n'
          + orphans.slice(0, 6).map((o) => '· ' + describeOrphan(o)).join('\n')
          + '\n处置：`evolve_orphans` 看清单、`evolve_reap` 收尸（带原因，不删记录）。'
        parent.send(
          createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'dsh-agent-evolve' } }),
          'next-step',
          true,
        )
      } catch { /* 主会话不在场：侧车已留痕 */ }
    } catch { /* 自检绝不影响插件加载 */ }
  }
  scanOrphansAtBoot()

  // ---------- evolve_init ----------
  ctx.tools.register(defineTool({
    name: 'evolve_init',
    description: '初始化进化系统：读取本体 AGENTS.md 规则段与 modeltest 任务说明书注册 v0.0 基线，锁定锚点。',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean', required: true }, candidatePromptFile: { type: 'string', required: true }, anchors: { type: 'json', required: true } } }, render: (_a, v) => [{ type: 'text', text: '进化初始化完成。锚点: ' + JSON.stringify(v.anchors) }] },
    async execute() {
      const l = store.ensureLedger()
      const rulesPath = join(config.workspaceDir, RULES_FILE)
      let rulesText = ''
      if (existsSync(rulesPath)) rulesText = extractRules(readFileSync(rulesPath, 'utf8'))
      store.addVersion(l, 'agent-rules', rulesText, 'v0.0 基线：本体规则段')
      const cpPath = join(config.modeltestDir, 'CANDIDATE_PROMPT.md')
      const cpText = existsSync(cpPath) ? readFileSync(cpPath, 'utf8') : ''
      store.addVersion(l, 'candidate-prompt', cpText, 'v0.0 基线：modeltest 任务说明书')
      for (const id of ['agent-rules', 'candidate-prompt'] as ResourceId[]) {
        const res = l.resources[id]
        if (res && !res.anchors.includes(res.versions[0]!.version)) res.anchors.push(res.versions[0]!.version)
      }
      store.writeLedger(l)
      return { ok: true, candidatePromptFile: cpPath, anchors: { 'agent-rules': l.resources['agent-rules']!.anchors.at(-1) ?? 'v0.0', 'candidate-prompt': l.resources['candidate-prompt']!.anchors.at(-1) ?? 'v0.0' } }
    },
  }))

  // ---------- evolve_edit ----------
  ctx.tools.register(defineTool({
    name: 'evolve_edit',
    description: '编辑进化资源（agent-rules=本体规则段 / candidate-prompt=任务说明书）：新版本 + diff 留痕；agent-rules 立即写入 AGENTS.md（热重载，下个 turn 生效）。',
    parameters: {
      resource: { type: 'string', enum: ['agent-rules', 'candidate-prompt'], required: true, description: '进化资源' },
      newContent: { type: 'string', required: true, description: '新内容全文' },
      note: { type: 'string', description: '编辑说明' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { version: { type: 'string', required: true }, diff: { type: 'json', required: true }, hotReloaded: { type: 'boolean', required: true } } }, render: (_a, v) => { const d = (v.diff ?? {}) as { added?: number; removed?: number }; return [{ type: 'text', text: '编辑完成：' + v.version + '（diff +' + (d.added ?? 0) + '/-' + (d.removed ?? 0) + ' 行）' + (v.hotReloaded ? '，已热重载到本体 AGENTS.md' : '') }] } },
    async execute(args: { resource: ResourceId; newContent: string; note?: string }) {
      const l = store.ensureLedger()
      const version = store.addVersion(l, args.resource, args.newContent, args.note ?? '')
      l.active[args.resource] = version
      store.writeLedger(l)
      let hotReloaded = false
      if (args.resource === 'agent-rules') {
        writeRulesToDisk(l)
        hotReloaded = true
      }
      const res = l.resources[args.resource]!
      const v = res.versions.find((x) => x.version === version)!
      return { version, diff: v.diff ?? { added: 0, removed: 0, newLength: 0 }, hotReloaded }
    },
  }))

  // ---------- evolve_commit ----------
  ctx.tools.register(defineTool({
    name: 'evolve_commit',
    description: '提交/撤回：commit=当前浮动版本成为新锚点；rollback=true=回滚到最近锚点（重写 AGENTS.md）。',
    parameters: {
      rollback: { type: 'boolean', description: 'true=回滚到最近锚点' },
      note: { type: 'string', description: '说明' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { action: { type: 'string', required: true }, anchor: { type: 'string', required: true }, rollbackFrom: { type: 'string' } } }, render: (_a, v) => [{ type: 'text', text: (v.action === 'rollback' ? '已回滚到锚点 ' : '已提交，新锚点 ') + v.anchor }] },
    async execute(args: { rollback?: boolean; note?: string }) {
      const l = store.ensureLedger()
      if (args.rollback) {
        const res = l.resources['agent-rules']!
        const anchor = res.anchors.at(-1)
        const active = l.active['agent-rules']
        if (active && anchor && active !== anchor) {
          l.rollbacks.push({ at: new Date().toISOString(), fromVersion: active, toVersion: anchor, note: args.note ?? '' })
          delete l.active['agent-rules']
          store.writeLedger(l)
          writeRulesToDisk(l)
          return { action: 'rollback', anchor, rollbackFrom: active }
        }
        return { action: 'rollback', anchor: anchor ?? 'v0.0', rollbackFrom: active }
      }
      for (const id of ['agent-rules', 'candidate-prompt'] as ResourceId[]) {
        const res = l.resources[id]
        if (!res) continue
        const active = l.active[id]
        if (active && !res.anchors.includes(active)) {
          res.anchors.push(active)
          delete l.active[id]
        }
      }
      store.writeLedger(l)
      return { action: 'commit', anchor: l.resources['agent-rules']!.anchors.at(-1) ?? 'v0.0' }
    },
  }))

  // ---------- evolve_round_start ----------
  ctx.tools.register(defineTool({
    name: 'evolve_round_start',
    description: '开始一代：清理上一代残留（workspace/ 顶层集合差判据）+ 重置坏项目（make_broken_project）+ 渲染配置。返回工作区与版本信息。',
    parameters: { note: { type: 'string', description: '本轮说明' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { workspace: { type: 'string', required: true }, candidatePromptVersion: { type: 'string', required: true }, rulesVersion: { type: 'string', required: true }, swept: { type: 'string', required: true } } }, render: (_a, v) => [{ type: 'text', text: '一代开始：工作区已重置（清理 ' + v.swept + '），任务书 ' + v.candidatePromptVersion + '，本体规则 ' + v.rulesVersion }] },
    async execute() {
      const l = store.ensureLedger()
      const wsRoot = join(config.modeltestDir, 'workspace')
      // t-d20b129c：`make_broken_project.py` 的 reset_workspace() 只在 `project2_task/` 内部跑
      // `git checkout .` + `git clean -fdx`（cwd=TASK_PROJECT），**`workspace/` 顶层的上一代产物
      // 它一律不碰**（实测残留：`_evidence*/`、`_selftest_*.py`、`_tmp_*`、`project2_task_tree.txt`）。
      // 不清理 ⇒ 第 N+1 代 child 会看到第 N 代产物 ⇒ 跨代账本不可比。故本插件补这一步并当场断言。
      const before = existsSync(wsRoot) ? readdirSync(wsRoot) : []
      if (before.length > 0 && !looksLikeWorkspace(before)) {
        throw new Error('拒绝重置：' + wsRoot + ' 顶层无脚手架锚（reference/tests/tools）——疑似 modeltestDir 配错，**未做任何删除**。')
      }
      const plan = planWorkspaceReset(before)
      for (const name of plan.remove) rmSync(join(wsRoot, name), { recursive: true, force: true })
      const mb = join(config.modeltestDir, 'evaluator', 'make_broken_project.py')
      await runCmd(config.pythonBin, [mb], config.modeltestDir, 300000)
      const after = existsSync(wsRoot) ? readdirSync(wsRoot) : []
      const diff = workspaceSetDiff(after)
      if (!diff.ok) throw new Error(workspaceResetMessage(diff))
      const rules = store.contentOf(l, 'agent-rules')
      renderPreset(config.dshHome, l, rules, l.compositionSource || defaultComposition)
      return {
        workspace: join(config.modeltestDir, 'workspace', 'project2_task'),
        candidatePromptVersion: store.versionOf(l, 'candidate-prompt'),
        rulesVersion: store.versionOf(l, 'agent-rules'),
        swept: sweptSummary(plan),
      }
    },
  }))

  // ---------- evolve_spawn ----------
  ctx.tools.register(defineTool({
    name: 'evolve_spawn',
    description: '派发子智能体（白纸 + 系统上下文）：创建 continuable subagent 跑 modeltest 任务，完成时自动通知父。',
    parameters: {
      gen: { type: 'integer', description: '代数（缺省自动）' },
      task: { type: 'string', description: '任务文本覆盖' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { runId: { type: 'string', required: true }, sessionId: { type: 'string', required: true } } }, render: (_a, v) => [{ type: 'text', text: '子智能体已派发：run ' + v.runId + '（session ' + v.sessionId + '）' }] },
    async execute(args: { gen?: number; task?: string }, exec) {
      const l = store.ensureLedger()
      const gen = args.gen ?? l.generations.length
      const runId = 'gen' + gen + '-' + Date.now().toString(36)
      const rules = store.contentOf(l, 'agent-rules')
      const candidate = args.task ?? store.contentOf(l, 'candidate-prompt')
      const task = buildTaskPrompt(candidate, rules)
      const parent = resolveParentAgent()
      // 件 1（治未乱 > 事后收尸）：派发**前**校验工作区真实存在。
      // 2026-09-13 的真因就是「归档 `_tmp_review` 时把活跃工作区 modeltest 一起搬走」，
      // 此后每一轮都无从下手却**照常派发**，最终只表现为「run 永远停在 pending」。
      // 判据抽在 orphans.workspaceStatus（纯函数、可单测；藏在这里就只有真派发才走得到）。
      const ws = workspaceStatus(config.modeltestDir, existsSync, join)
      if (ws.missing) throw new Error(workspaceMissingMessage(ws.project, config.modeltestDir))
      const started = await ctx.subagents.startContinuable({
        provider: 'spawn',
        label: 'evolve-run-' + gen,
        request: {
          prompt: [{ type: 'text', text: task }],
          parent: parent as Agent,
          agentOptions: undefined,
        },
        signal: exec.signal,
      })
      // startContinuable 只投递初始 prompt 不唤醒：子智能体停在 ready 直到有消息。
      // v3（2026-08-17 修正）：不再 spawn 内嵌 followup 唤醒——gen4 实证立即 followup
      // 与 startContinuable 竞态，导致 turn 组装丢失系统上下文（inputTokens 从 2719 暴跌到
      // 293），模型在无上下文下幻觉乱码（gen5/retry 两次实证）。
      // 唤醒改由主会话在 spawn 返回 sessionId 后手动 send_message（gen3/gen4a 验证的可靠路径）。
      store.writeRun({
        runId,
        gen,
        sessionId: started.childId,
        status: 'pending',
        at: new Date().toISOString(),
        // 件 2：记下父会话与**期望时长**——孤儿要能找回主会话告知；超期判据也要有基准
        parentSessionId: (parent as { id?: string }).id,
        expectedMs: DEFAULT_EXPECTED_MS,
      })
      return { runId, sessionId: started.childId }
    },
  }))

  // ---------- evolve_status ----------
  ctx.tools.register(defineTool({
    name: 'evolve_status',
    description: '查询运行状态（全部或单个 run）。',
    parameters: { runId: { type: 'string', description: 'run id（缺省全部）' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { runs: { type: 'json', required: true } } }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v.runs) }] },
    async execute(args: { runId?: string }) {
      const runs = args.runId ? [store.readRun(args.runId)].filter((x): x is NonNullable<typeof x> => x !== null) : store.listRuns()
      return { runs: JSON.parse(JSON.stringify(runs)) }
    },
  }))

  // ---------- evolve_orphans（t-a19d7800 件 3：看得见）----------
  ctx.tools.register(defineTool({
    name: 'evolve_orphans',
    description: '列出**孤儿 run**（超期未收尾的 pending/running）：spawn→submit 环断掉后的可见面。只读，不收尸。',
    parameters: { graceFactor: { type: 'number', description: '宽限倍数（缺省 3，即超过期望时长×3 才算孤儿）' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { count: { type: 'number', required: true }, orphans: { type: 'json', required: true } } }, render: (_a, v) => [{ type: 'text', text: v.count === 0 ? '无孤儿 run。' : ('孤儿 ' + v.count + ' 条：\n' + (v.orphans as string[]).map((s) => '· ' + s).join('\n')) }] },
    async execute(args: { graceFactor?: number }) {
      const orphans = findOrphans(store.listRuns(), Date.now(), args.graceFactor ?? 3)
      return { count: orphans.length, orphans: JSON.parse(JSON.stringify(orphans.map(describeOrphan))) }
    },
  }))

  // ---------- evolve_reap（件 3 的「收尸」半：有原语，且留痕）----------
  ctx.tools.register(defineTool({
    name: 'evolve_reap',
    description: '收尸：把超期 run 标为 failed（带原因与时刻），**不删除记录**。缺省 dryRun=true 只预览；确认后传 dryRun:false 落盘。',
    parameters: {
      reason: { type: 'string', description: '收尸原因（写进 run 与账本痕迹）' },
      runId: { type: 'string', description: '只收这一条（缺省：全部孤儿）' },
      dryRun: { type: 'boolean', description: 'true=只预览不写（缺省 true）' },
      graceFactor: { type: 'number', description: '宽限倍数（缺省 3）' },
    },
    output: { schema: { type: 'object', additionalProperties: false, properties: { dryRun: { type: 'boolean', required: true }, reaped: { type: 'json', required: true } } }, render: (_a, v) => [{ type: 'text', text: (v.dryRun ? '（预览，未写盘）' : '（已写盘）') + '收尸 ' + (v.reaped as string[]).length + ' 条' + ((v.reaped as string[]).length ? '：\n' + (v.reaped as string[]).map((s) => '· ' + s).join('\n') : '') }] },
    async execute(args: { reason?: string; runId?: string; dryRun?: boolean; graceFactor?: number }) {
      const reason = args.reason ?? '超期未收尾（孤儿）'
      const dryRun = args.dryRun !== false
      const all = store.listRuns()
      const targets = args.runId
        ? all.filter((r) => r.runId === args.runId)
        : findOrphans(all, Date.now(), args.graceFactor ?? 3).map((o) => all.find((r) => r.runId === o.runId)!).filter(Boolean)
      const done: string[] = []
      for (const r of targets) {
        if (r.status === 'done' || r.status === 'failed') continue
        if (!dryRun) {
          const at = new Date().toISOString()
          store.writeRun({
            ...r,
            status: 'failed',
            doneAt: at,
            reaped: { at, reason },
            note: ((r.note ?? '') + ' ' + reapNote(reason)).trim(),
          })
        }
        done.push(r.runId + '（gen' + r.gen + ' · ' + r.status + ' ⇒ failed）')
      }
      return { dryRun, reaped: JSON.parse(JSON.stringify(done)) }
    },
  }))

  // ---------- evolve_submit ----------
  ctx.tools.register(defineTool({
    name: 'evolve_submit',
    description: '子智能体完成后跑官方评测（run_full_eval，冻结评分面），分数入账本并返回。',
    parameters: { runId: { type: 'string', required: true, description: 'run id' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ability: { type: 'number', required: true }, ship: { type: 'number', required: true }, releaseClass: { type: 'string', required: true }, dimensions: { type: 'json', required: true } } }, render: (_a, v) => [{ type: 'text', text: 'Ability=' + v.ability + ' Ship=' + v.ship + ' Class=' + v.releaseClass }] },
    async execute(args: { runId: string }) {
      const run = store.readRun(args.runId)
      if (!run) throw new Error('未知 run：' + args.runId)
      const l = store.ensureLedger()
      // 件 4（t-a19d7800）：提交**前**校验 child 终态。gen10 那次 child 被撕裂（无 turn/end）
      // 却照样提交，产出的 87.5 是**截断读数**——不标记，将来会被误读成能力回归。
      // 形状判据与孤儿识别共用 `orphans.scanSessionOutcome`（同一真源，不另写一套）。
      // 边界诚实：child 会话已不在场（如重启后）时**无法判定**，此时不标记截断——
      // 不假装「完整」，但也不无中生有地扣帽子；该情形留由 §8 的待验证项覆盖。
      let truncated = false
      if (run.sessionId) {
        const child = ctx.agents.get(run.sessionId as SessionId)
        // 品牌类型（SessionSeq）跨包不可直赋 number ⇒ 经 unknown 转一次（技能 dsh-sensor-plugin 记过同款坑）
        if (child) {
          const read = child.session.eventAt.bind(child.session) as unknown as (seq: number) => unknown
          truncated = scanSessionOutcome(read, child.session.seq as unknown as number).truncated
        }
      }
      if (truncated) {
        run.note = ((run.note ?? '') + ' ' + TRUNCATED_CAVEAT).trim()
        store.writeRun(run)
      }
      const project = join(config.modeltestDir, 'workspace', 'project2_task')
      const score = await runFullEval(config.modeltestDir, config.pythonBin, project, {
        model: 'dsh-evolve',
        harness: 'evolve',
        runGroupId: 'evolve-gen' + run.gen,
      }, config.evalTimeoutMs)
      run.status = 'done'
      run.doneAt = new Date().toISOString()
      store.writeRun(run)
      l.generations.push({
        gen: run.gen,
        version: store.versionOf(l, 'agent-rules'),
        runId: run.runId,
        sessionId: run.sessionId,
        ability: score.ability,
        ship: score.ship,
        releaseClass: score.releaseClass,
        dimensions: score.dimensions,
        at: new Date().toISOString(),
        note: run.note ?? '',
      })
      store.writeLedger(l)
      return { ability: score.ability ?? 0, ship: score.ship ?? 0, releaseClass: score.releaseClass ?? '', dimensions: score.dimensions }
    },
  }))

  // ---------- evolve_ledger ----------
  ctx.tools.register(defineTool({
    name: 'evolve_ledger',
    description: '读历史账本（父智能体专用：代/版本/分数/结论/锚点链/撤回记录）。',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: false, properties: { ledger: { type: 'json', required: true } } }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v.ledger) }] },
    async execute() {
      const l = store.ensureLedger()
      const slim = {
        generations: l.generations,
        active: l.active,
        anchors: Object.fromEntries(Object.entries(l.resources).map(([k, r]) => [k, r.anchors])),
        rollbacks: l.rollbacks,
      }
      return { ledger: JSON.parse(JSON.stringify(slim)) }
    },
  }))

  // ---------- 辅助 ----------
  function writeRulesToDisk(l: Ledger): void {
    const rulesPath = join(config.workspaceDir, RULES_FILE)
    const rulesText = store.contentOf(l, 'agent-rules')
    const full = existsSync(rulesPath) ? readFileSync(rulesPath, 'utf8') : ''
    const wrapped = RULES_MARKER_START + '\n' + rulesText + '\n' + RULES_MARKER_END
    const next = full.includes(RULES_MARKER_START)
      ? full.replace(/<!-- dsh-agent-evolve:start -->[\s\S]*<!-- dsh-agent-evolve:end -->/, wrapped)
      : full + '\n\n' + wrapped + '\n'
    writeFileSync(rulesPath, next, 'utf8')
  }
}

function extractRules(full: string): string {
  const m = full.match(/<!-- dsh-agent-evolve:start -->([\s\S]*?)<!-- dsh-agent-evolve:end -->/)
  return m?.[1]?.trim() ?? ''
}

function buildTaskPrompt(candidate: string, rules: string): string {
  const ruleSection = rules.trim().length > 0
    ? '\n\n【本体规则（继承自宿主，必须遵守）】\n' + rules + '\n'
    : ''
  return candidate + ruleSection + '\n\n【输出】完成后简要报告：修改了哪些模块、验证结果、未验证风险。'
}

function runCmd(bin: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, windowsHide: true })
    let killed = false
    const timer = setTimeout(() => { killed = true; child.kill() }, timeoutMs)
    child.on('close', (code: number | null) => { clearTimeout(timer); resolve({ code: killed ? 124 : (code ?? -1) }) })
    child.on('error', () => { clearTimeout(timer); resolve({ code: -2 }) })
  })
}

const defaultComposition = "# evolve-live default composition (v1: minimal-ish)\n- id: persona\n  name: '@deepseek-ai/dsh-persona'\n  config:\n    prefix: |-\n      You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.\n- id: tool-pwsh\n  name: '@deepseek-ai/dsh-tool-pwsh'\n  disabled: !!js process.platform !== 'win32'\n- id: tool-fs\n  name: '@deepseek-ai/dsh-tool-fs'\n- id: tool-fs-search\n  name: '@deepseek-ai/dsh-tool-fs-search'\n- id: tool-jobs\n  name: '@deepseek-ai/dsh-tool-jobs'"
