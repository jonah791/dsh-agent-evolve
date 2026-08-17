/** 评测器：宿主侧调用 modeltest run_full_eval.py（冻结评分面），解析分数入账本。 */
import { spawn } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export interface EvalScore {
  ability: number | null
  ship: number | null
  releaseClass: string | null
  dimensions: Record<string, number | null>
  resultsDir: string
}

/** 跑完整评测（阻塞直到完成/超时）。 */
export async function runFullEval(
  modeltestDir: string,
  pythonBin: string,
  project: string,
  meta: { model: string; harness: string; runGroupId: string },
  timeoutMs: number,
): Promise<EvalScore> {
  const script = join(modeltestDir, 'evaluator', 'run_full_eval.py')
  const args = [
    script,
    project,
    '--no-diff',
    '--model', meta.model,
    '--harness', meta.harness,
    '--run-group-id', meta.runGroupId,
  ]
  const out = await runCapture(pythonBin, args, modeltestDir, timeoutMs)
  // 评测完成 ≠ exit 0：测试有失败项时 run_full_eval 返回非零，但 summary 已生成。
  // 只要 summary.json 存在即视为评测完成；不存在才报错。
  const resultsRoot = join(modeltestDir, 'evaluator', 'results')
  const newest = newestSummary(resultsRoot)
  if (!newest) {
    throw new Error('run_full_eval 未产出 summary.json (exit ' + out.code + '): ' + out.tail.slice(0, 800))
  }
  const summary = JSON.parse(readFileSync(newest, 'utf8')) as {
    ability_draft?: number | null
    ship_draft?: number | null
    release_class_hint?: string | null
    dimensions?: Record<string, number | null>
  }
  return {
    ability: summary.ability_draft ?? null,
    ship: summary.ship_draft ?? null,
    releaseClass: summary.release_class_hint ?? null,
    dimensions: summary.dimensions ?? {},
    resultsDir: join(resultsRoot, dirOf(newest)),
  }
}

function newestSummary(resultsRoot: string): string | null {
  if (!existsSync(resultsRoot)) return null
  let best: string | null = null
  let bestTime = 0
  for (const entry of readDirSafe(resultsRoot)) {
    const p = join(resultsRoot, entry, 'summary.json')
    if (!existsSync(p)) continue
    const mtime = mtimeOf(p)
    if (mtime > bestTime) {
      bestTime = mtime
      best = p
    }
  }
  return best
}

function dirOf(p: string): string {
  return p.split(/[\\/]/).slice(-2, -1)[0] ?? ''
}

function mtimeOf(p: string): number {
  try {
    return statSync(p).mtimeMs
  } catch {
    return 0
  }
}

function readDirSafe(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

interface RunResult { code: number; tail: string }

function runCapture(bin: string, args: string[], cwd: string, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, windowsHide: true })
    let tail = ''
    let killed = false
    const timer = setTimeout(() => {
      killed = true
      child.kill()
    }, timeoutMs)
    child.stdout.on('data', (d: Buffer) => {
      tail = (tail + d.toString()).slice(-4000)
    })
    child.stderr.on('data', (d: Buffer) => {
      tail = (tail + d.toString()).slice(-4000)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: killed ? 124 : (code ?? -1), tail: killed ? '评测超时被杀' : tail })
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ code: -2, tail: String(err) })
    })
  })
}

import { statSync, readdirSync } from 'node:fs'
