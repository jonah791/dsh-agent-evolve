<!--
  DSH 插件生态公约声明（plugin-ecosystem-convention · 组合优先/声明清晰/兼容优先）
  purpose: 跨代自评估进化系统（受益主体 = 宿主 agent 本体）：编辑本体规则段（AGENTS.md 标记段，编辑即热重载）→ 白纸子智能体继承该版本跑 modeltest → 官方 run_full_eval 评分入账本 → 提升/持平 commit 成新锚点、降低则回滚到最近锚点
  inject: 'tools','agents','subagents'
  tools: evolve_init,evolve_edit,evolve_commit,evolve_round_start,evolve_spawn,evolve_status,evolve_submit,evolve_ledger
  runtime: host-only（无 client 侧；改代码须构建 → 预检 → 重启才生效）
  envDeps: 外部 Python（`pythonBin`，默认 `python`）+ 一个 modeltest 仓库（`evaluator/make_broken_project.py`、`evaluator/run_full_eval.py`、`CANDIDATE_PROMPT.md`）；评测轮会真实创建子智能体并调用 LLM（有成本）；本插件自身无网络访问
  boundary: 对宿主文件的唯一写入是 `<workspaceDir>/AGENTS.md` 的 `<!-- dsh-agent-evolve:start -->…<!-- end -->` 标记段；评分权威在外部脚本（本插件不自行打分、不解析测试明细）；不管理子智能体生命周期（`evolve_spawn` 不唤醒）
  compat: cordis ^4.0.1 / dsh-tools ^0.1.0-rc.6 / dsh-agent ^0.0.1-rc.1 / dsh-llm ^0.0.1-rc.1 / dsh-session ^0.0.1-rc.1 / DSH 0.1.5 起 persona 键为 prefix
-->
# dsh-agent-evolve — 跨代自评估进化插件

<p align="center">
  <a href="https://github.com/jonah791/dsh-agent-evolve"><img src="https://img.shields.io/badge/version-0.1.2-blue" alt="version"></a>
  <img src="https://img.shields.io/badge/License-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/TypeScript-3178C6" alt="TypeScript">
  <img src="https://img.shields.io/badge/tests-6%20passed-brightgreen" alt="tests">
  <img src="https://img.shields.io/badge/npm%20test-absent-lightgrey" alt="no npm test script">
</p>

**一句话**：给宿主 agent 本体装一条「改规则 → 量化验证 → 采纳或撤回」的流水线——本体规则段（`agent-rules`）写在 `<workspaceDir>/AGENTS.md` 的标记段里，`evolve_edit` 一写即热重载；子智能体以**白纸 + 系统上下文**继承该版本跑 modeltest，官方 `run_full_eval` 的分数入账本，提升/持平 `commit` 成新锚点，降低 `rollback` 回最近锚点。

**为什么值得用**：改自己的行为规则通常只能靠感觉——本插件把它变成**有分数的实验**：控制变量（子智能体无对话历史、无账本、无经验注入，唯一变量是资源版本）、评分来自冻结的官方评测面、每次变更留下版本 + diff + 锚点链 + 撤回记录。没有它，规则演进就是「改了试试」；有了它，规则演进是「带撤回的版本管理」。

## 能力

| 工具 | 用途 |
|------|------|
| `evolve_init` | 初始化：读 `<workspaceDir>/AGENTS.md` 标记段与 `<modeltestDir>/CANDIDATE_PROMPT.md` 注册 `v0.0` 基线，并把两资源的 `v0.0` 锁成首个锚点 |
| `evolve_edit` | 编辑资源（`agent-rules` / `candidate-prompt`）：新版本 + 行级 diff 留痕；`agent-rules` 立即写入 AGENTS.md（热重载，下个 turn 生效） |
| `evolve_commit` | `commit`：当前浮动版本（`active`）push 成新锚点；`rollback: true`：删 `active`、重写 AGENTS.md 到最近锚点、`rollbacks[]` 增一条 |
| `evolve_round_start` | 开一代：跑 `make_broken_project.py` 重置坏项目 + 渲染 `evolve-live` 预设；返回工作区与两份版本号 |
| `evolve_spawn` | 派发白纸子智能体（`subagents.startContinuable`）跑 modeltest；返回 `runId` + `sessionId`（**须主会话手动 `send_message` 唤醒**） |
| `evolve_status` | 查 run 状态：传 `runId` 查单个，缺省列出全部（`runs/<runId>.json`） |
| `evolve_submit` | 子智能体完成后跑官方评测（`run_full_eval`，冻结评分面）→ `ability`/`ship`/`releaseClass`/`dimensions` 入账本 `generations[]` |
| `evolve_ledger` | 读历史账本（父智能体专用）：代 / 版本 / 分数 / 锚点链 / 撤回记录 |

行为侧（无工具）：`apply` 内的父 agent 解析（锚点 → 活跃根 agent → 响亮报错）；`writeRulesToDisk` 的标记段正则替换。

> 输出 schema 全部 `additionalProperties: false`（严格返回值校验）；返回键固定为 `{ok,candidatePromptFile,anchors}` / `{version,diff,hotReloaded}` / `{action,anchor,rollbackFrom?}` / `{workspace,candidatePromptVersion,rulesVersion}` / `{runId,sessionId}` / `{runs}` / `{ability,ship,releaseClass,dimensions}` / `{ledger}`。

## 快速开始

**1) 装依赖**（自研插件家园 `self-plugins/`，在目标 profile 的 `package.json` 加 link 依赖）：

```jsonc
"dsh-agent-evolve": "link:<工作区>/self-plugins/dsh-agent-evolve"
```

**2) 挂组合**（profile 的 `cordis.patch.yml`；`modeltestDir` / `workspaceDir` 必填）：

```yaml
- insert:
    - id: agent-agent-evolve
      name: dsh-agent-evolve
      config:
        modeltestDir: <modeltest 仓库根>
        workspaceDir: <工作区>
        # mainSessionId: 可选优先锚点，留空即自动解析当前活跃根 agent
        # dataDir: 建议显式给，否则跟随 DSH_HOME
```

**3) 30 秒验证**：调 `evolve_ledger` → 期望返回 `{ledger:{generations,active,anchors,rollbacks}}`（首次调用会因 `ensureLedger` 落一份空账本，`initialized: true`）；再调 `evolve_status` → 返回 `{runs:[…]}`。工具面出现 8 个 `evolve_*` 工具即插件已在本进程加载。

> 前置条件：`<modeltestDir>` 下必须真实存在 `CANDIDATE_PROMPT.md`、`evaluator/make_broken_project.py`、`evaluator/run_full_eval.py`，且 `pythonBin` 可执行——否则 `evolve_init` 会注册空任务书，`evolve_round_start` / `evolve_submit` 会失败（退出码 `-2` = 解释器不可执行）。

## 配置

| 项 | 默认 | 说明 |
|----|------|------|
| `modeltestDir` | **必填（无默认）** | modeltest 仓库根：`CANDIDATE_PROMPT.md`、`evaluator/*.py`、`workspace/project2_task` 都相对它解析 |
| `workspaceDir` | **必填（无默认）** | 宿主工作区根，`AGENTS.md` 在这里——标记段写入的唯一目标 |
| `mainSessionId` | `''` | **优先锚点，不是唯一真源**（2026-09-11 修复）：配的会话在场则用它，否则回退当前活跃根 agent；两者皆无 → 响亮报错（含 `agents=<n>` 与锚点回显）。写死的 session id 会随会话更替腐化 |
| `pythonBin` | `python` | 起外部脚本的解释器；不可执行时子进程退出码 `-2` |
| `dshHome` | `process.env.DSH_HOME \|\| ''` | `evolve-live` 预设渲染到 `<dshHome>/.agent-presets/evolve-live/` |
| `dataDir` | `${DSH_HOME}/.evolve`；`DSH_HOME` 未设时回落到**源码内硬编码路径** | 账本 / 资源版本 / run 的落点。**部署务必显式配置**（否则换机器即静默写到别处） |
| `evalTimeoutMs` | `1500000`（25 分钟） | 评测等待上限；超时判 `124`，且与「无 summary」共用同一条错误文案（无法事后区分，见 `docs/semantic.md` §10 第 5 条） |

## 落盘与自证（出问题时先看这里）

本插件**没有阶段轨迹层**（无 `<DSH_HOME>/*-trace.jsonl`），只有**状态快照**——「断在哪一段」要靠产物有无与时间跨度反推。落盘产物如下：

| 路径 | 内容 |
|------|------|
| `<dataDir>/ledger.json` | 账本：`initialized` / `modeltestDir` / `mainSessionId` / `compositionSource` / `createdAt` / `resources{id,versions[],anchors[]}` / `active`（浮动版本）/ `generations[]` / `edits[]` / `rollbacks[]` |
| `<dataDir>/resources/<ResourceId>/vX.Y.txt` | 每次 `addVersion` 落一份全文（`agent-rules` / `candidate-prompt`），版本号 `vX.Y` 由 `nextVersion` 单调推进（`Y<9` 则 `Y+1`，否则 `X+1`、`Y=0`；不可解析则回 `v0.0`） |
| `<dataDir>/runs/<runId>.json` | `RunState`：`runId` / `gen` / `sessionId`（子智能体会话）/ `status`（实际只会写 `pending`→`done`，`running`/`failed` 无写入点）/ `at` / `doneAt` / `note` |
| `<workspaceDir>/AGENTS.md` | **唯一宿主文件写入**：只替换 `dsh-agent-evolve:start/end` 标记段之间的文本；无标记则追加文末 |
| `<dshHome>/.agent-presets/evolve-live/{agent.cordis.yml,preset.yml}` | 每轮 `evolve_round_start` 重渲染（预设加载器运行时发现，无需重启） |
| `<modeltestDir>/evaluator/results/<dir>/summary.json` | **读取**（非本插件写）：评分唯一权威 |

**一条命令答五问**：

```bash
LD="$DSH_HOME/.evolve/ledger.json"        # dataDir 未显式配置时的默认落点
python -c "import json;l=json.load(open('$LD'));print(l['generations'][-1]);print(l['active'],list(l['rollbacks']))"
# ① 跑的是哪个构建  → 账本**无 build 字段**（缺口）；改用 mtime 对照：stat -c %y lib/index.js vs web 进程启动时间
# ② 谁发起          → generations[].sessionId（子智能体会话）+ runId；l['mainSessionId'] = 初始化时登记的父锚点
# ③ 断在哪一段      → 有 runs/ 但无对应 generations 条目 ⇒ 卡在 submit；runs 里 status=pending ⇒ 派发了但没被唤醒/没跑完
# ④ 结果质量        → generations[].ability / ship / releaseClass / dimensions（含 final_code、security、migration…）
# ⑤ 耗时与预算      → 该 run 的 at → doneAt 跨度 vs evalTimeoutMs（1500000ms）
```

现场读数（2026-09-14 实测）：`generations` 9 条、`edits` 0 条（该数组**无写入点**）、`rollbacks` 0 条，`active = {candidate-prompt: v0.7}`，`agent-rules` 锚点链 `v0.0 → v0.1 → v0.3 → v0.6`；最新一代 gen8：`ability 96 / ship 96 / B+`。

## 生效判据与回退

**生效判据**（三选一，按可靠性排序）：
1. **进程级**：`lib/index.js`（及 `lib/*.js`）的 mtime **≤** web 进程启动时间，且 `src/*.ts` 不新于 `lib/*.js`（源码改了没构建 = 跑的还是旧产物）；
2. **语义级**（最直接）：本会话工具面出现 8 个 `evolve_*` 工具，且 `evolve_ledger` 能返回账本 ⇒ 插件已在本进程加载；
3. **落盘级**：`<dataDir>` 下出现新 `resources/*/vX.Y.txt` / `runs/<runId>.json` 或 mtime 前进；`<workspaceDir>/AGENTS.md` 标记段正文 = 账本 `contentOf('agent-rules')`（= `active ?? 最近锚点`）。

> 注意：**重新构建 ≠ 生效**——产物 mtime 新只证明「构建过」，**进程启动时间晚于产物 mtime** 才算「在跑它」（AGENTS §5.11 §6）。
>
> 版本号自称可能过期：现场 `resources/agent-rules/v0.6.txt` 的正文标题仍写「抽象行为原则 v0.4」，且 `v0.4.txt` 与 `v0.6.txt` 的 md5 完全相同——正文没变而版本号推进是正常留痕，**不要拿正文里的自称版本号当判据**，只认 `ledger.json` 的 `versions[].version` / `anchors[]`。

**回退**（三档）：
- **源码级**：`git -C self-plugins/dsh-agent-evolve revert <commit>`（或 `git checkout <上一提交>`）→ `npm run build` → 预检 → 哨兵重启；
- **组合级**：profile patch 给 `agent-agent-evolve` 行加 `disabled: true`，或 `plugin_stop dsh-agent-evolve` → 8 个工具消失、标记段不再被改写（**注意**：标记段文本会**留在 AGENTS.md 里继续被注入**，是否保留须手工决定）；
- **运行期/数据级**：调 `evolve_commit({rollback: true})` 把本体规则段退回最近锚点（重写 AGENTS.md + `rollbacks[]` 留痕）；账本整体可由 `ledger.json` + `resources/*/vX.Y.txt` 人工回放。回退后用同一套判据复验。

## 测试

```bash
npm run build && node --test "tests/*.test.mjs"
# ⚠ 本仓库 package.json **没有 `test` 脚本**（只有 build / typecheck），`npm test` 会直接报 Missing script
```

**6 例离线测试全部通过**（`# tests 6 / # pass 6 / # fail 0`，2026-09-14 实测）。测试**跑的是构建产物**（`import '../lib/parent.js'`）——改源码后必须先 `npm run build`，否则测的是旧产物。

`tests/parent.test.mjs` 6 例，覆盖 `selectParentAgent` / `rootDepthOf` 的全部决策分支：
1. **尸体测试**：配置锚点已腐化（真实事故样本 `session-5a785c96…` 不在场）→ 必须回退到当前活跃根 agent，不得抛错（旧实现即死于此）；
2. 锚点在场 → 优先用锚点（向后兼容）；
3. 无任何活跃 agent → **响亮报错**，断言含 `找不到主会话 agent` / `agents=0` / 锚点回显；
4. 只有子代理在场（`delegationDepth > 0`）→ 报错，不得把子代理当父；
5. 多个根 agent → 取列表末尾（最新激活）；
6. `delegationDepth` 缺省/null → 视为根 agent。

**是否需要网络/真实外部依赖**：单测**零外部依赖、零网络**（只 import lib 产物，不 spawn、不读文件）。但插件主流程需要真实环境——`evolve_round_start` 起 Python 跑 `make_broken_project.py`、`evolve_spawn` 创建真子智能体、`evolve_submit` 跑 `run_full_eval.py` 并**阻塞至完成或 25 分钟超时**（评测轮会真实调用 LLM，**有成本**）。这些步骤本仓库**不做自动化测试**。

**未覆盖**（见 [`docs/semantic.md`](docs/semantic.md) §7 第 4/5/8/9/10 条仍「待验收」）：其余 7 个工具的接线、`EvolveStore` 的版本递增与 diff、`renderPreset` 渲染、`runFullEval` 的 summary 解析、`evolve_edit → AGENTS.md` 标记段一致性、`rollback` 后标记段回落。

## 设计要点

- **白纸继承 = 控制变量**：子智能体无对话历史、无账本、无经验注入；prompt = `CANDIDATE_PROMPT.md` + 本体规则段 + 输出要求（`buildTaskPrompt`）。**唯一受控变量是资源版本**——否则分数变化无法归因。
- **`evolve_spawn` 不唤醒（v3，血泪教训）**：`startContinuable` 只投递初始 prompt，子智能体停在 `ready`；spawn 内嵌 followup 会与它竞态，导致 turn 组装丢系统上下文（gen4 实测 `inputTokens` 从 2719 跌到 293，模型在无上下文下幻觉）。**唤醒是主会话手动 `send_message` 到返回的 `sessionId` 的职责**。
- **锚点是快照不是真源**（2026-09-11 事故）：`mainSessionId` 写死在 patch 里 → 会话更替后解析失败 → **整条进化主线静默失效 24 天**（最后成功评测 2026-08-17）。现在解析顺序为「锚点在用 → 活跃根 agent → 响亮报错」，配 `src/parent.ts` 纯函数 + 尸体测试。
- **评分权威在外部**：本插件不自行打分、不解析测试明细。完成判据是 `<modeltestDir>/evaluator/results/` 下**存在 `summary.json`**，**不是 exit code 0**——有失败项时脚本非零退出但 summary 已生成。
- **唯一宿主写入是标记段**：`writeRulesToDisk` 只做正则替换 `<!-- dsh-agent-evolve:start -->[\s\S]*<!-- dsh-agent-evolve:end -->`，不碰 AGENTS.md 的其余内容。热重载的物理链路是**宿主每 turn 重读 AGENTS.md**（agent-instructions），本插件不持有会话状态。
- **失败语义不静默**：父 agent 解析失败抛错含 `agents=<n>` 与锚点回显；评测无 summary 抛错并附 stdout/stderr 尾部 800 字符。
- **已知未决/未接线**（照实说）：① `compositionSource` 构造时传 `''`，走 `defaultComposition`（不含 `{{SYSTEM_PROMPT}}`）⇒ `evolve-live` 预设里**没有本体规则**，规则实际经 `buildTaskPrompt` 进任务文本；② `replacePersonaText` / `removePreset` 已导出但入口未引用；③ `ResourceId` 含 `composition` 却无任何写入路径；④ `evolve_submit` 取 `results/` 下 **mtime 最新**的 summary，未按 `runGroupId` 定位（并行评测有取错风险）；⑤ `edits[]` 数组无写入点；⑥ 无阶段轨迹层（AGENTS §5.22 五问中 ①③ 只能间接答）。
- **评测轮会改状态**：`evolve_spawn` 创建真实子智能体会话、`evolve_submit` 真实跑评测并写账本——**不是只读操作**，别在只读场景里试。

## 相关文档

| 文档 | 内容 |
|------|------|
| [`docs/semantic.md`](docs/semantic.md) | **权威契约**：定位与反定位、术语表、概念模型与不变量、契约（含调用点清单）、边界与信任、可证伪验收清单（10 条，其中 5 条待验收）、实践修订记录、未决问题（7 条） |
| [alice-digital-life](https://github.com/jonah791/alice-digital-life) | 本插件所属生态的中心索引（全部自研插件） |
| 技能 `plugin-maintainability` / `dsh-plugin-development` / `semantic-doc-first` | 机制自证与可维护性工程、DSH 插件开发方法论、语义文档优先开发 |
| 同族插件 `dsh-agent-self-test` | 互补：self-test 检验「行为假设」，evolve 检验「规则集跨代分数」 |

## License

MIT © jonah791

---

本插件属于我的数字生命爱丽丝（[alice-digital-life](https://github.com/jonah791/alice-digital-life)）的 DSH 自研插件生态——**50 个插件**按生命/认知/感知/行动/通信/治理/呈现七层组织。
