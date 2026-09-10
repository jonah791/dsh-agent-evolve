/** 热重载：把资源渲染为 <dshHome>/.agent-presets/evolve-live/（运行时发现，无需重启）。 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Ledger } from './types.ts'

export const PRESET_ID = 'evolve-live'
export const PRESET_ROOT = '.agent-presets'

/** 渲染当前配置到 .agent-presets/evolve-live/（应用=热重载；回滚=重渲染锚点版本）。 */
export function renderPreset(
  dshHome: string,
  l: Ledger,
  systemPrompt: string,
  composition: string,
): string {
  const dir = join(dshHome, PRESET_ROOT, PRESET_ID)
  mkdirSync(dir, { recursive: true })
  // persona prefix 占位符替换（0.1.5 起配置键为 prefix）
  const rendered = composition.includes('{{SYSTEM_PROMPT}}')
    ? composition.replace(/\{\{SYSTEM_PROMPT\}\}/g, () => indentBlock(systemPrompt, 6))
    : composition
  writeFileSync(join(dir, 'agent.cordis.yml'), rendered, 'utf8')
  writeFileSync(join(dir, 'preset.yml'), 'name: evolve-live\ndescription: dsh-agent-evolve 进化变体（运行时热重载）\norder: 99\n', 'utf8')
  return dir
}

/** 移除 preset 目录（回滚到无变体状态时用）。 */
export function removePreset(dshHome: string): void {
  try {
    rmSync(join(dshHome, PRESET_ROOT, PRESET_ID), { recursive: true, force: true })
  } catch { /* 不存在即无操作 */ }
}

/** 把文本按给定空格数缩进（用于 YAML 块内嵌）。 */
function indentBlock(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces)
  const lines = text.split(/\r?\n/)
  const out: string[] = []
  for (const line of lines) {
    out.push(line.trim().length === 0 ? '' : pad + line)
  }
  return out.join('\n')
}

/** 在 composition 模板中把 persona 的 prefix 替换为占位符（evolve_init 用）。 */
export function replacePersonaText(composition: string): string {
  // 0.1.5 起 persona 配置键为 "prefix:"（原 "text:"）；块标量形如 "prefix: >-"
  const pattern = /(prefix:\s*>?-\s*\n(?:\s{6,}.*\n?)*)/m
  const m = composition.match(pattern)
  if (!m) return composition
  return composition.slice(0, m.index) + 'prefix: |\n      {{SYSTEM_PROMPT}}\n' + composition.slice((m.index ?? 0) + m[0].length)
}
