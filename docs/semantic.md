# dsh-agent-evolve 语义文档

| 项 | 值 |
|----|----|
| 能力名 | `dsh-agent-evolve`（跨代自评估进化系统，受益主体 = 宿主 agent 本体） |
| 主副本路径 | `self-plugins/dsh-agent-evolve/docs/semantic.md` |
| 实现落点 | `src/index.ts`（入口 `apply` + 8 个工具 + `defaultComposition`）、`src/types.ts`（`Ledger`/`Resource`/`ResourceVersion`/`Generation`/`RunState`）、`src/store.ts`（`EvolveStore`：账本/资源版本/run 持久化 + `nextVersion`/`lineDiff`）、`src/evaluator.ts`（`runFullEval`）、`src/parent.ts`（`selectParentAgent`/`rootDepthOf`）、`src/presets.ts`（`renderPreset`/`removePreset`/`replacePersonaText`）、`tests/parent.test.mjs` |
| 版本 | 0.1.2 |
| 状态 | draft |
| 作者 | 爱丽丝 |
| 日期 | 2026-09-14 |

## 1 · 定位与反定位

**定位**：为宿主 agent 本体提供「改规则 → 量化验证 → 采纳或撤回」的跨代自评估闭环。本体规则段（`agent-rules`）写在 `<workspaceDir>/AGENTS.md` 的标记段里，编辑即热重载；子智能体以白纸 + 系统上下文继承该版本执行 modeltest 任务；官方评测给出分数，分数入账本（`ledger.json`），提升/持平则 commit 成新锚点，降低则回滚到最近锚点。

**反定位**（本插件不做什么）：
- 不是评分权威：分数完全来自外部 `<modeltestDir>/evaluator/run_full_eval.py`，本插件只调用与解析；
- 不管理子智能体生命周期：`evolve_spawn` 只投递初始 prompt，**不唤醒**（唤醒是主会话手动 `send_message` 的职责）；
- 不写 AGENTS.md 标记段以外的内容：`writeRulesToDisk` 只替换 `<!-- dsh-agent-evolve:start -->` 与 `<!-- dsh-agent-evolve:end -->` 之间的文本；
- 不是通用 A/B 平台、不是插件生态管理器、不做记忆/技能沉淀（那是 self-test / 技能熔炉的职责）。

## 2 · 术语表

| 术语 | 含义（源码依据） |
|------|------------------|
| 进化资源 `ResourceId` | `'agent-rules' \| 'candidate-prompt' \| 'composition'`（`types.ts`；工具入参 enum 仅前两者） |
| 版本 `ResourceVersion` | `version`(vX.Y) + `content` 全文 + `note` + `at` + `diff` |
| 浮动版本 `active` | `Ledger.active[id]`：编辑后未经评测验证的版本 |
| 锚点 `anchors` | `Resource.anchors: string[]`：已验证版本按序存放，`at(-1)` = 最近锚点 |
| 代 `gen` | 一次「round_start → spawn → submit」评测轮（`Generation`） |
| run | 一次子智能体派发记录（`RunState.status: pending/running/done/failed`） |
| 账本 `Ledger` | `<dataDir>/ledger.json`：资源 + 锚点链 + 浮动版本 + 代 + 编辑 + 撤回 |
| 白纸继承 | 子智能体无对话历史、无账本，prompt = 任务说明书 + 本体规则（`buildTaskPrompt`） |
| 评测面 | `run_full_eval`（`--no-diff`，冻结评分面 + hidden 隔离）产出的 `summary.json` |

## 3 · 概念模型

主流水线（工具即步骤）：
`evolve_init`（登记 v0.0 基线 + 首个锚点）→ `evolve_edit`（追加 vX.Y，若为 `agent-rules` 立即写 AGENTS.md）→ `evolve_round_start`（跑 `make_broken_project.py` 重置坏项目 + 渲染 `evolve-live` 预设）→ `evolve_spawn`（`ctx.subagents.startContinuable` 创建白纸子智能体）→ 主会话 `send_message` 唤醒 → `evolve_submit`（`run_full_eval` → 分数入 `generations`）→ `evolve_commit`（提升/持平 → 新锚点；否则 `rollback=true` 回滚）。

不变量：
1. `active[id]` 非空 ⇒ 该版本尚未入锚；commit 时若 `active` 不在 `anchors` 内则 push 并删除 `active`。
2. AGENTS.md 标记段文本恒等于 `contentOf(l, 'agent-rules')` = `active ?? 最近锚点 ?? 最新版本`（edit / rollback 都经 `writeRulesToDisk` 重写）。
3. 版本号单调：`nextVersion` 规则为 `vX.Y`，`Y<9` 时 `Y+1`，否则 `X+1`、`Y=0`；无法解析则回到 `v0.0`。
4. 子智能体的唯一受控变量是资源版本（控制变量原则）。
5. 评测完成判据是「`results/` 下存在 summary.json」，**不是** exit code 0——测试有失败项时脚本非零退出但 summary 已生成。

## 4 · 契约

### 4.1 调用点清单

| 调用方 | 调用点（文件:符号） | 时机 |
|--------|---------------------|------|
| cordis 宿主 | `src/index.ts:inject = ['tools','agents','subagents']`、`name = 'agent-evolve'` | 插件激活（缺 inject 声明即抛错） |
| 宿主 agent（模型） | `src/index.ts:apply → ctx.tools.register` 注册 `evolve_init` | 首次初始化基线 |
| 宿主 agent | `src/index.ts:apply → evolve_edit` | 编辑 `agent-rules`/`candidate-prompt`（附带 `writeRulesToDisk` 热重载） |
| 宿主 agent | `src/index.ts:apply → evolve_commit`（`rollback` 分支） | 提升/持平提交新锚点；降低时回滚 |
| 宿主 agent | `src/index.ts:apply → evolve_round_start` | 开一代（`runCmd(pythonBin, make_broken_project.py)` + `renderPreset`） |
| 宿主 agent | `src/index.ts:apply → evolve_spawn` | 派发白纸子智能体（`ctx.subagents.startContinuable`） |
| 宿主 agent | `src/index.ts:apply → evolve_status` / `evolve_submit` / `evolve_ledger` | 查状态 / 跑评测入账 / 读账本 |
| 主会话（我方手动动作） | `send_message` 到 `evolve_spawn` 返回的 `sessionId`（`started.childId`） | spawn 返回后——**唯一唤醒路径**（源码注释：不在 spawn 内 followup，避免与 startContinuable 竞态） |
| 宿主 agent | `src/index.ts:resolveParentAgent → src/parent.ts:selectParentAgent` | 每次 spawn 解析父 agent（锚点 → 活跃根 agent → 响亮错误） |
| 宿主 agent | `src/index.ts:evolve_round_start → src/presets.ts:renderPreset` | 每轮开始渲染 `<dshHome>/.agent-presets/evolve-live/` |
| 宿主 agent | `src/index.ts:evolve_submit → src/evaluator.ts:runFullEval` | 提交评测（阻塞至完成/超时 `evalTimeoutMs`） |
| 本插件 | `ctx.agents.get(config.mainSessionId)` / `ctx.agents.list()` | 解析父 agent 的两个真源 |
| 外部脚本 | `<modeltestDir>/evaluator/make_broken_project.py`、`<modeltestDir>/evaluator/run_full_eval.py` | 由 `runCmd` / `runCapture` 以 `pythonBin` 启动 |
| 宿主 agent-instructions | 读取 `<workspaceDir>/AGENTS.md` 标记段 | 每 turn（热重载的消费点） |
| 预设加载器 | 读取 `<dshHome>/.agent-presets/evolve-live/agent.cordis.yml` + `preset.yml` | 会话创建时（运行时发现，无需重启） |

本插件**不发射自定义会话事件**；对外只有 8 个工具 + 5 类落盘产物。

**4.2 工具契约（8 个，名字逐字）**：`evolve_init`、`evolve_edit`、`evolve_commit`、`evolve_round_start`、`evolve_spawn`、`evolve_status`、`evolve_submit`、`evolve_ledger`。输出 schema 一律 `additionalProperties: false`（严格返回值校验），键分别为：`{ok,candidatePromptFile,anchors}` / `{version,diff,hotReloaded}` / `{action,anchor,rollbackFrom?}` / `{workspace,candidatePromptVersion,rulesVersion}` / `{runId,sessionId}` / `{runs}` / `{ability,ship,releaseClass,dimensions}` / `{ledger}`。

**4.3 配置契约（`Config`）**：`modeltestDir`(必填)、`workspaceDir`(必填)、`mainSessionId`(默认 `''`)、`pythonBin`(默认 `python`)、`dshHome`(默认 `process.env.DSH_HOME || ''`)、`dataDir`(默认 `process.env.DSH_HOME ? process.env.DSH_HOME + '/.evolve' : 'E:/alice/.evolve'`)、`evalTimeoutMs`(默认 `1500000`)。

**4.4 落盘契约**：`<dataDir>/ledger.json`｜`<dataDir>/resources/<ResourceId>/vX.Y.txt`｜`<dataDir>/runs/<runId>.json`｜`<workspaceDir>/AGENTS.md`（标记段）｜`<dshHome>/.agent-presets/evolve-live/{agent.cordis.yml,preset.yml}`｜`<modeltestDir>/evaluator/results/<dir>/summary.json`（读取）。

## 5 · 边界与信任

- **信任源**：只有 `run_full_eval` 的 `summary.json` 是评分权威；插件不自行打分，也不解析测试明细。
- **写入边界**：对宿主文件的唯一写入是 `AGENTS.md` 标记段（正则替换）；无标记时追加在文末。
- **危险面**：`evolve_edit(agent-rules)` 直接改本体规则 → 影响我自己的行为；误编辑的兜底是锚点链 + `rollback=true`。
- **失败语义（不静默）**：父 agent 解析失败抛带诊断的错误（含 `agents=<n>` 与锚点回显）；评测无 summary 抛错并附 stdout/stderr 尾部 800 字符；`pythonBin` 不可执行 → 退出码 `-2`；超时 → `124` 且判据同「无 summary」。
- **权限**：以 `pythonBin` 起子进程；无网络访问；不读取凭据。

## 6 · 与既有机制的关系

- **agent-instructions（AGENTS.md 注入）**：本插件是标记段的生产者，宿主每 turn 重读 → 编辑即热重载；这也是「本体受益」的物理链路。
- **dsh-agent-self-test（自指探针）**：互补——探针检验「我的行为假设」，evolve 检验「我的规则集跨代分数」。
- **dsh-semantic-docs / `docs/semantics/registry.json`**：本文件是其主副本，注册归注册方（本次未改注册表）。
- **哨兵/守护（hot-reload）**：插件为 host-only，改代码后构建 → 预检 → 重启才生效。
- **记忆/checkpoint**：不共享存储，evolve 状态只在 `<dataDir>` 内，不参与会话日志。

## 7 · 可证伪验收清单

| # | 可证伪命题 | 证据（单测名或命令或日志行或落盘产物） | 状态 |
|---|-----------|----------------------------------------|------|
| 1 | 父 agent 解析在锚点腐化时回退而非抛错 | `tests/parent.test.mjs`「尸体样本：配置锚点已腐化…回退到当前活跃根 agent」（`node --test tests/`） | 已通过（离线） |
| 2 | 无活跃根 agent 时响亮报错，含 `agents=0` 与锚点回显 | `tests/parent.test.mjs`「无任何活跃 agent → 响亮错误」 | 已通过（离线） |
| 3 | 子代理（`delegationDepth>0`）不会被当作父 | `tests/parent.test.mjs`「只有子代理在场…」 | 已通过（离线） |
| 4 | `evolve_edit(agent-rules)` 后 AGENTS.md 标记段 = 新版本正文 | `read` `<workspaceDir>/AGENTS.md` 标记段 vs `ledger.json` 的 `active['agent-rules']` 正文逐字比对 | 待验收 |
| 5 | `evolve_commit(rollback=true)` 后标记段回到最近锚点正文，且 `rollbacks[]` 增一条 | `ledger.json` 的 `rollbacks` 数组长度 +1 且 `toVersion` = `anchors.at(-1)` | 待验收 |
| 6 | 现场生效：`dataDir`（`E:/alice/.evolve`）下 `ledger.json` 存在且 `initialized: true` | `E:/alice/.evolve/ledger.json` 首两行（本次读数：`"initialized": true`） | 已通过（现场） |
| 7 | 现场规则段已注入：AGENTS.md 标记段正文 = 账本 `agent-rules` 最新版本正文 | AGENTS.md `dsh-agent-evolve:start/end` 段（v0.4「抽象行为原则 v0.4」）vs `ledger.json` v0.4 `content` | 已通过（现场） |
| 8 | 评测完成判据是 summary 存在而非 exit 0 | `src/evaluator.ts:runFullEval` 注释 + 非零退出下仍解析 `summary.json`；命令：`python <modeltestDir>/evaluator/run_full_eval.py <project> --no-diff` | 待验收 |
| 9 | `evolve_spawn` 后子智能体停在 ready，须手动 `send_message` 才开跑 | `evolve_status` 返回 `status: "pending"`，直到主会话投递消息 | 待验收 |
| 10 | 改代码后 `lib/*.js` mtime 晚于 web 进程启动时间才算真正生效 | `Get-ChildItem lib`（本次读数 mtime `2026/9/11 13:45:12`）vs web 进程启动时间 | 待验收 |

## 8 · 与实现的关系

**生效判据**（改了代码后怎么证明真的在跑新构建）：
1. **构建-进程先后**：`lib/index.js` 等产物的 mtime 必须**晚于 web 进程启动时间**——mtime 新只证明「构建过」，不证明「进程在跑它」；
2. **工具可答**：`evolve_ledger` 返回账本 ⇒ 插件已在本进程加载（本会话可见 8 个 `evolve_*` 工具）；
3. **落盘产物增长**：`<dataDir>/ledger.json`、`runs/<runId>.json`、`resources/agent-rules/vX.Y.txt` 出现新文件/新 mtime；
4. **规则段注入**：`<workspaceDir>/AGENTS.md` 标记段正文 = 账本 `active ?? 最近锚点` 正文（现场：v0.4 一致）；
5. **评测面**：`<modeltestDir>/evaluator/results/<dir>/summary.json` 新增且 mtime 前进。

**回退**（出问题怎么退）：
- 代码层：`git revert` / `git checkout <上一条提交>` 回退源码并重建（本仓库含 `.git`；**push 必须走 Windows 侧 git**，WSL 无凭据助手会静默挂起）；
- 数据层：`evolve_commit(rollback=true)` 把本体规则段退到最近锚点（重写 AGENTS.md，`rollbacks` 留痕）；账本整体可由 `resources/*/vX.Y.txt` 与 `ledger.json` 人工回放；
- 运行层：`plugin_stop dsh-agent-evolve` 停用插件（经哨兵重启）；停用后标记段文本会**留在 AGENTS.md**，需手工决定是否保留。

## 9 · 实践修订记录

- 2026-09-14 补课：本插件此前无语义文档（可维护性工程）
- 2026-09-11 配置腐化事故回修：`mainSessionId` 从「唯一真源」降级为**优先锚点**，解析逻辑抽成 `src/parent.ts` 纯函数 + `tests/parent.test.mjs` 尸体测试（来源：源码注释与测试文件）
- 2026-08-17 spawn 唤醒竞态回修（v3）+ 0.1.2 persona 键改 `prefix:`（`evolve-live` 模板；DSH 0.1.5 起）——来源：`src/index.ts` 注释与 README「兼容性」
- 规则段版本演进 v0.0→v0.4 全部留痕于 `ledger.json`（本次读数：v0.4「抽象行为原则 v0.4」，7 条）

## 10 · 未决问题

1. **预设占位符从不替换**：`EvolveStore` 构造时 `compositionSource` 传 `''`，`evolve_round_start` 走 `defaultComposition`，而该模板**不含** `{{SYSTEM_PROMPT}}` ⇒ `renderPreset` 的替换分支不触发，`evolve-live` 预设里没有本体规则；规则实际经 `buildTaskPrompt` 进入子智能体任务文本。是否有意为之？待确认。
2. `replacePersonaText` / `removePreset` 已导出但 `src/index.ts` 未引用（死代码或预留接线）——是否接线待定。
3. `ResourceId` 含 `composition`，但无任何工具入参或初始化路径写它（`evolve_init` 只注册 `agent-rules`/`candidate-prompt`）。
4. `evolve_submit` 取「`results/` 下 mtime 最新的 summary.json」，未按 `runGroupId`（`evolve-gen<n>`）精确定位——并行/追加评测时存在取错风险。
5. `evalTimeoutMs` 默认 25 分钟；超时（`124`）与无 summary 报同一条错误文案，事后无法从错误区分超时与评测崩溃。
6. `dataDir` 现场落点 `E:/alice/.evolve`（`E:/alice/.dsh/.evolve` 不存在）说明有显式配置覆盖默认值，但 patch 落点未在 `E:\alice\.dsh` 下检索到——配置文件位置待查。
7. 本文件状态 `draft`：第 7 节 4/5/8/9/10 条仍「待验收」，未做线上验收前不得升 `implemented`。
