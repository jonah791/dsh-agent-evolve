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
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-subagent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { EvolveStore } from './store.ts'
import { renderPreset } from './presets.ts'
import { runFullEval } from './evaluator.ts'
import type { Ledger, ResourceId } from './types.ts'

export const name = 'agent-evolve'
export const inject = ['tools', 'agents', 'subagents'] as const

export interface Config {
  modeltestDir: string
  workspaceDir: string
  mainSessionId: string
  pythonBin: string
  dshHome: string
  dataDir: string
  evalTimeoutMs: number
}
export const Config = z.object({
  modeltestDir: z.string(),
  workspaceDir: z.string(),
  mainSessionId: z.string(),
  pythonBin: z.string().default('python'),
  dshHome: z.string().default('C:/Users/tr/.dsh'),
  dataDir: z.string().default('C:/Users/tr/Documents/alice/.evolve'),
  evalTimeoutMs: z.number().default(1500000),
})

const RULES_FILE = 'AGENTS.md'
const RULES_MARKER_START = '<!-- dsh-agent-evolve:start -->'
const RULES_MARKER_END = '<!-- dsh-agent-evolve:end -->'

export function apply(ctx: Context, config: Config): void {
  const store = new EvolveStore(config.dataDir, config.modeltestDir, config.mainSessionId, '')

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
    description: '开始一代：重置坏项目（make_broken_project）+ 渲染配置。返回工作区与版本信息。',
    parameters: { note: { type: 'string', description: '本轮说明' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { workspace: { type: 'string', required: true }, candidatePromptVersion: { type: 'string', required: true }, rulesVersion: { type: 'string', required: true } } }, render: (_a, v) => [{ type: 'text', text: '一代开始：工作区已重置，任务书 ' + v.candidatePromptVersion + '，本体规则 ' + v.rulesVersion }] },
    async execute() {
      const l = store.ensureLedger()
      const mb = join(config.modeltestDir, 'evaluator', 'make_broken_project.py')
      await runCmd(config.pythonBin, [mb], config.modeltestDir, 300000)
      const rules = store.contentOf(l, 'agent-rules')
      renderPreset(config.dshHome, l, rules, l.compositionSource || defaultComposition)
      return {
        workspace: join(config.modeltestDir, 'workspace', 'project2_task'),
        candidatePromptVersion: store.versionOf(l, 'candidate-prompt'),
        rulesVersion: store.versionOf(l, 'agent-rules'),
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
      const parent = ctx.agents.get(config.mainSessionId as SessionId)
      if (!parent) throw new Error('找不到主会话 agent：' + config.mainSessionId)
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
      store.writeRun({ runId, gen, sessionId: started.childId, status: 'pending', at: new Date().toISOString() })
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

const defaultComposition = "# evolve-live default composition (v1: minimal-ish)\n- id: persona\n  name: '@deepseek-ai/dsh-persona'\n  config:\n    text: |-\n      You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.\n- id: tool-pwsh\n  name: '@deepseek-ai/dsh-tool-pwsh'\n  disabled: !!js process.platform !== 'win32'\n- id: tool-fs\n  name: '@deepseek-ai/dsh-tool-fs'\n- id: tool-fs-search\n  name: '@deepseek-ai/dsh-tool-fs-search'\n- id: tool-jobs\n  name: '@deepseek-ai/dsh-tool-jobs'"
