<!--
  DSH 插件生态公约声明（plugin-ecosystem-convention · 组合优先/声明清晰/兼容优先）
  purpose: 
  inject: 'tools','agents','subagents'
  tools: evolve_init,evolve_edit,evolve_commit,evolve_round_start,evolve_spawn,evolve_status,evolve_submit,evolve_ledger
  runtime: host-only
  envDeps: 无（纯逻辑/标准 Node）
  boundary: 无特殊授权边界
  compat: cordis ^4.0.1 / dsh-tools ^0.1.0-rc.6
-->
# dsh-agent-evolve — 跨代自评估进化插件


<p align="center">
  <a href="https://github.com/jonah791/dsh-agent-evolve"><img src="https://img.shields.io/badge/version-0.1.1-blue" alt="version"></a>
  <img src="https://img.shields.io/badge/License-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/TypeScript-3178C6" alt="TypeScript">
</p>
DSH（DeepSeek Harness）插件：宿主 agent 本体的自我进化系统——编辑本体规则（AGENTS.md）→ 子智能体继承验证 → 分数对比 → 提交或回滚，形成跨代自评估闭环。

## 功能特性

- **本体规则热重载**：编辑 `agent-rules` 立即生效（AGENTS.md 每 turn 重读）
- **子智能体验证**：白纸 + 系统上下文（无对话历史/无账本）——控制变量验证配置版本
- **官方评测**：modeltest 任务说明书 + run_full_eval（冻结评分面 + hidden 隔离）
- **锚点链**：提升/持平则 commit（新锚点），降低则回滚（最近锚点）
- **账本**：代/版本/分数/结论/锚点链/撤回记录全留痕

## 安装

```bash
cd <你的 self-plugins 目录>
git clone https://github.com/jonah791/dsh-agent-evolve.git
cd dsh-agent-evolve
pnpm install
pnpm build
```

## 使用

| 工具 | 说明 |
|------|------|
| `evolve_init` | 初始化：注册本体规则段与任务说明书基线 |
| `evolve_round_start` | 开始一代（重置坏项目 + 渲染配置） |
| `evolve_spawn` | 派发子智能体执行任务 |
| `evolve_submit` | 子智能体完成后跑官方评测，分数入账本 |
| `evolve_edit` | 编辑进化资源（规则段/任务说明书） |
| `evolve_commit` | 提交新锚点或回滚 |
| `evolve_ledger` | 读历史账本 |

## 相关

- [我的数字生命爱丽丝 — 插件生态中心（架构总览）](https://github.com/jonah791/alice-digital-life)

## License

MIT
