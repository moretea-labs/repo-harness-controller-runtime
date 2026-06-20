# 架构 Research Report:loop-in-hook 对照 NLAH 论文与 Loop Engineering

> **Date**: 2026-06-12
> **Repo baseline**: repo-harness 0.3.0,commit `9e32602`(workflow compatibility 5.2.3)
> **Status**: 格局判断(hypothesis,待 proof point 验证),非已批准的实施方案

## 0. 来源与基线

| 来源 | 形态 | 关键定位 |
|------|------|----------|
| Pan, Zou, Guo, Ni, Zheng. *Natural-Language Agent Harnesses* (NLAH). arXiv:2603.25723v1, 2026-03-26 | 学术论文,18 页全文(`_ref/nlah-2603.25723.pdf`) | 把 harness 控制逻辑外化为可执行自然语言对象,在 SWE-bench Verified / OSWorld 上做受控消融 |
| Addy Osmani. *Loop Engineering*. 2026-06-08(x.com/addyosmani/status/2064127981161959567 → addyosmani.com/blog/loop-engineering/) | 实践者文章 | "Loop engineering is replacing yourself as the person who prompts the agent. You design the system that does it instead." |
| 烟花老师 @teach_fireworks. 《长任务 Agent 的最小工程闭环》2026-05-25(`_ref/teach-fireworks-long-task-agent-min-loop-2026-05-25.md`) | 实践者长文(已归档摘要) | 五层架构(state/planning/execution/verification/supervision)+ 八实践最小闭环;作为第三方三角验证 |
| 本仓库 loop-in-hook 实现 | `README.md` + `.ai/hooks/`(13 脚本 ~5.2K 行 bash)+ `src/cli/hook/`(~600 行 TS decision engine)+ 16 个 file-backed state surfaces | 被评估对象 |

---

## 1. 外部证据梳理

### 1.1 NLAH/IHR:论文实际证明了什么

论文提出 NLAH(自然语言表达的 harness:contracts / roles / stage structure / adapters & scripts / state semantics / failure taxonomy)与 IHR(in-loop LLM + backend + runtime charter 的共享运行时),并给出三组受控证据。**注意它的实现形态:IHR 不是新框架,而是 stock Codex CLI 0.114.0 + 一个固定 runtime skill(charter)+ 按 benchmark 定制的 harness skill(Fig 3 realization mapping)。**

**RQ1 — 行为效应(Table 1, 2)**:

| 配置(SWE Verified, TRAE) | 解决率 | Prompt tokens | Tool calls | 时长 |
|---|---|---|---|---|
| Full IHR | 74.4% | 16.3M | 642.6 | 32.5 min |
| 去掉 runtime skill (w/o RTS) | **76.0%** | 11.1M | 451.9 | 16.6 min |
| 去掉 harness skill (w/o HS) | 75.2% | **1.2M** | 51.1 | 6.7 min |

- Full IHR 花了 **~13.6× prompt tokens**(16.3M vs 1.2M),聚合解决率反而不是最高。125 个样本中 >110 个在各配置间结果一致;差异集中在边界 case。论文自己的结论:full harness 是 **solved-set replacer**(换掉哪些题被解出),不是 uniform frontier expander。
- Table 4:Full IHR 下 **~90% 的 token/tool/LLM 调用发生在 delegated child agents**(parent 只占 8–10%),parent 是 runtime-only orchestrator。

**RQ2 — 模块消融(Table 3, Figure 4)**:从 benchmark-specific Basic 出发,每次只加一个模块:

| 模块 | SWE Δ | OSWorld Δ | Figure 4 score-cost 判定 |
|---|---|---|---|
| Self-evolution(验收门控的重试循环) | **+4.8** | +2.7 | 唯一"分数上移、成本几乎不右移"的模块 |
| File-backed state | +1.6 | **+5.5** | 温和右移,过程结构性收益 |
| Evidence-backed answering | +1.6 | 0.0 | 同上 |
| Verifier(独立验证者) | −0.8 | **−8.4** | dominated(被支配:更贵且更差) |
| Multi-candidate search | −2.4 | −5.6 | dominated,成本最重 |
| Dynamic orchestration | 0.0 | +2.7 | 分数贴 Basic 但成本不贴 |

论文的机制解释(p6-7, p17):**显式结构只有在"收紧中间行为到真实验收条件的路径"时赚钱;增加与最终验收弱对齐的本地流程层是有害的。** 最扎眼的反例 `sympy__sympy-23950`(p17):独立 verifier 报告 "solved",官方评测 `test_as_set` 仍然 fail——额外流程层让运行"更结构化、局部更有说服力",同时漂离真实验收对象。

**RQ3 — code→NL 迁移(Table 5)**:OS-Symphony 原生代码 harness 30.4% → NLAH 重构 47.2%(时长 361.5→140.8 min)。增益机制不是"自然语言更聪明",而是**可靠性机制的搬迁**:从屏幕截图似真性修复(GUI focus repair)搬到 file-backed state + path-addressable evidence + artifact-backed closure。主轨迹步数几乎不变(18.1 → 18.2 unique commands),多出来的日志事件(58.5)是 observability + recovery 脚手架。

**Runtime charter 五原则(Appendix C)**:runtime-only parent role;minimal delegated baseline;call-graph recovery with explicit context semantics(`fork_context=true/false`);separated runtime state and final artifacts(`STATE_ROOT` vs `artifacts/`);contract-first completion and auditability。**Agent call 形式化(Appendix A)**:把单次 model call 提升为带执行契约 κ 的 agent call——required outputs、budget、permission scope、completion conditions、designated output paths。

**论文自报局限**:n=125/36 单 seed 子集;自然语言精度低于代码;runtime charter 可能吸收应归因 harness 文本的行为(runtime contamination);消融 ≠ 严格因果识别。

### 1.2 Addy Osmani:Loop Engineering 五组件

核心命题:把自己从"给 agent 打 prompt 的人"替换掉,转而设计那个系统。五组件 + 一个底座:

1. **Automations**(heartbeat):"Automations that go off on a schedule and do discovery and triage by themselves"
2. **Worktrees**:并行 agent 互不踩踏
3. **Skills**:固化项目知识,避免 agent 每轮重新猜
4. **Plugins/Connectors**:接入既有工具(issue tracker、PR、Slack)
5. **Sub-agents**:"One of them has the idea and a different one checks it"(创造者/验证者分离)
- 底座:**state persistence** — "The agent forgets, the repo doesn't."

边界警告与本报告同等重要:"A loop running unattended is also a loop making mistakes unattended";token 成本要显式管理;"Build the loop. But build it like someone who intends to stay the engineer, not just the person who presses go." 文中的具体日常形态:晨间定时 triage(CI 失败 + open issues)→ 每个 finding 开独立 worktree → 一个 sub-agent 起草修复、另一个评审 → connector 开 PR → 结果写入 markdown state file → 人类只看 triage inbox 里 loop 处理不了的项。

### 1.3 teach_fireworks(三角验证)

五层架构(state/planning/execution/verification/supervision)与八实践最小闭环和上述两者高度同构,另给两条裁决性原则:

- **"Stronger models thin the harness, but do not remove it"** —— 定期追问每个 harness 层是否仍在解决真实失败模式;留下并 instrument 有效的,删掉变成阻力的。
- 其 Critical Reading 先于论文指出了同一风险:**evaluator alignment**(独立评估者的 rubric 若不对齐真实验收面,只会加延迟与成本)——与 NLAH verifier −8.4 的实测互为印证。

三方收敛点:**file-backed durable state、evidence-backed completion、创造者/验证者分离、显式预算与停止条件、人类保留 supervision**。这五点是 2026 年中关于 agent harness 的实践共识,且 NLAH 给了其中前两点定量背书。

---

## 2. loop-in-hook 现状地图(P1 / P2)

### 2.1 P1:结构

三层:host adapters(用户级 `~/.claude/settings.json` / `~/.codex/hooks.json`)→ `repo-harness-hook` CLI route registry → repo 内 `.ai/hooks/*.sh`(本自托管仓库 pin `hook_source: "repo"`)。事件绑定拓扑:

```
SessionStart          → session-start-context.sh (389行) + security-sentinel.sh (115行)
UserPromptSubmit      → prompt-guard.sh (1,076行) ⇄ TS engine prompt-guard-decide (~600行)
PreToolUse Edit|Write → worktree-guard.sh (39行) + pre-edit-guard.sh (241行)
PostToolUse Edit      → post-edit-guard.sh (254行)
PostToolUse Bash      → post-bash.sh (218行)
PostToolUse (always)  → post-tool-observer.sh (197行)
Stop                  → stop-orchestrator.sh (140行)
共享库                 → hook-input.sh (602行) + workflow-state.sh (~1000行) + session-state.sh
```

分工原则(README 与实现一致):shell 拥有文件系统权威与副作用;TypeScript 拥有 prompt-text 分类(Unicode-aware,`src/cli/hook/prompt-intents.ts`)与 `intent × plan-state` 决策表,返回单行 verdict JSON(`{protocol, action, intent, facts{~20 个 0/1}, derived}`)。prompt 层 advisory(exit 0),edit 层 deterministic(exit 2),done-claim 门校验 file-backed evidence。

State surfaces(16+):`plans/plan-*.md`(Status 生命周期)、`.ai/harness/active-plan` / `active-worktree`、`tasks/contracts/*.contract.md`(allowed_paths / verification / exit criteria)、`tasks/reviews/*.review.md`、`.ai/harness/checks/latest.json`、`handoff/current.md` + `resume.md`、`planning/pending.json`、`context-budget/latest.json`、`.claude/.trace.jsonl`、`policy.json`、`docs/spec.md`、`tasks/{todo,current,lessons,research}.md`。

### 2.2 P2:一次实现编辑的完整 trace

1. `UserPromptSubmit` → prompt-guard 剥离注入块 → TS engine 分类 intent → verdict → advisory 提示/路由 hint/capture 副作用;
2. `PreToolUse Edit` → worktree-guard(主树保护)→ pre-edit-guard:SpecGuard(`docs/spec.md` 存在)→ PlanStatusGuard(active plan 必须 Approved/Executing,否则 exit 2)→ ContractScopeGuard(`workflow_contract_allows_path` 校验 allowed_paths,越界 exit 2);
3. 编辑放行后 `PostToolUse Edit` → post-edit-guard 跑 continuous contract verification(`verify-contract.sh` 写 `checks/latest.json`)+ 架构 drift 同步 + task-handoff 摘要;
4. `PostToolUse always` → post-tool-observer 记 trace、每 5 次采样 context budget、orange/red 区刷新 handoff;
5. 用户声称完成 → prompt-guard done gate 校验 contract/checks/review/acceptance 四类 file-backed 证据;
6. `Stop` → stop-orchestrator 刷新 handoff;若 pending planning 状态新鲜且末条消息像 plan,**emit decision=block 强制一轮 self-review**(PlanCompletenessGate)。

### 2.3 已记录的痛点(tasks/lessons.md,2026-05-27 ~ 06-10)

- **延迟税**:hook 启动成本由 fork/exec 主导(bash parse ~12ms、TS spawn ~35ms,单 hook 全链 warm ~250ms,负载下 >2s);
- **intent 误报史**:"开发新功能"类 prompt 曾被过度触发(2026-05-28 修复);宿主注入的 skill/context 块污染分类(需 `strip_prompt_context_blocks`);engine 不可达时 prompt 层降级为一次性 advisory;
- **stale marker**:Draft plan 删除/归档后 marker 未清,后续 prompt 全被误判(需三态检测 clean/deleted/foreign_worktree);
- **串行 gate 摩擦**:spec→plan→contract→evidence→review→acceptance 逐个解锁,没有批量补齐命令;
- **advisory/enforcement 混淆**:用户看到 advisory 提示但实现仍被拦,分不清哪层在管。

---

## 3. 对位分析:验证、缺口与反模式

### 3.1 已被外部证据验证的资产(keep & double down)

| 资产 | 外部对应 | 证据 |
|------|---------|------|
| **File-backed spine**(plans/contracts/checks/handoff/trace) | NLAH file-backed state 模块(externalized / path-addressable / compaction-stable);Addy "the repo doesn't forget";teach_fireworks state layer | SWE +1.6 / OSWorld **+5.5**;RQ3 迁移增益的主要机制 |
| **Acceptance-tightening gates**(done gate 校验 file-backed 证据;`verify-contract.sh` 直接对齐 contract exit criteria) | NLAH self-evolution 家族("acceptance-gated attempt loop");evidence-backed answering | SWE **+4.8**(self-evolution 是 Figure 4 唯一帕累托改进模块);+1.6 |
| **Worktree 隔离 + handoff/resume** | Addy 组件 #2;NLAH compaction-stable 性质 | 实践共识,论文 RQ3 中 artifact-backed closure 的载体 |
| **Edit 层确定性裁决**(path + plan state,不猜语言) | NLAH 分工:代码负责确定性操作 | lessons.md 自己的结论:"prompt-text intent guessing is unreliable; path + plan state is deterministic" |

这一半的结论很明确:**loop-in-hook 的 file-backed 脊柱不但不要动,而且是论文定量背书的那一类投资。**0.3.0 把 enforcement 从 prompt 层下沉到 edit 层,也与证据方向一致。

### 3.2 一个反模式(论文分工的镜像倒置)

**P1:用 TypeScript 模仿 LLM 读自然语言。** NLAH 验证的分工是:

```
自然语言 → harness 编排逻辑(roles、contracts、验证门、状态语义、委派边界),由 in-loop LLM 解释
代码     → 确定性操作与工具接口
```

loop-in-hook 在 prompt 层恰好倒置:~600 行 TS 分类器 + `intent × plan-state` 决策表试图从 prompt 文本**用代码**推断语义(done / plan_start / implement / bug_hunt / ~20 个 facts),而真正的 in-loop LLM(宿主 agent 本身)就坐在旁边,且已经在读 CLAUDE.md。后果全在 lessons.md 里:误报修一个冒一个(分类器维护无界)、注入块污染、engine 降级、advisory/enforcement 混淆。更深的代价是 NLAH 的核心论点:**决策表锁在 TS 里,就不是可编辑、可消融、可迁移的 harness 对象**——用户改一条路由规则要改代码发版,而不是改一行契约文本。

注意精确归因:edit 层与 done 层的**证据校验**是确定性事实判断(文件存在、status 字段、路径匹配),放在代码里是对的。倒置只发生在 prompt 层的**语义推断**上。

### 3.3 三个缺口

**G1:Contract 已是 80% 的 agent-call κ,却只用来拦人、不用来派活。** 对照 NLAH Appendix A 的 κ 定义:

| κ 字段 | `tasks/contracts/*.contract.md` 现状 |
|---|---|
| required outputs / completion conditions | ✅ exit criteria + verification 规则 |
| designated output paths | ✅ allowed_paths |
| budget(tokens/tool calls/time) | ❌ 缺 |
| permission scope | ❌ 缺(目前由宿主权限模式兜底) |
| roles(worker/verifier 分离) | ❌ 缺(review 文件靠人/Waza 手动触发) |

论文 Full IHR 下 ~90% 工作发生在 contract-bounded child agents;Addy 组件 #5 要求创造者与验证者是不同 agent;teach_fireworks 要求 evaluator 独立且能 FAIL。loop-in-hook 的对应物全是"同一个会话 + 人类驱动":contract 约束的是人手里的那个 agent,而不是被派遣的 agent。`contract-worktree.sh` 已经做了隔离,差的只是"把 contract 当任务包交给 child"这一步。

**G2:没有 heartbeat。** Addy 五组件中,skills(✅ 命令面)、worktrees(✅)、connectors(部分:gh/Waza/gbrain)、sub-agents(❌ 见 G1)、**automations(❌ 完全缺失)**。一切都是 host-event-reactive:`sprint-backlog.sh next` 存在但要人开口,drift request 会写文件但没人定时分诊,`check-task-workflow.sh` 只在有人跑时才跑。

**G3:控制流走私进 veto hooks。** `stop-orchestrator.sh` 通过 block Stop 强制一轮 self-review(PlanCompletenessGate);done 流程靠 TS 检测 "done" 措辞再触发证据校验;路由建议靠 prompt 层 advisory 注入。这些都是**用否决面模拟编排面**:loop 没有发动机,于是刹车系统兼职踩油门。13 个 hook dispatch、每事件 250ms–2s 的 fork/exec 税,有一部分就是在为这种兼职买单。

### 3.4 一条警戒线(同样来自证据)

NLAH 的负面结果与 Addy/teach_fireworks 的警告划定了优化的边界:

- **Verifier −8.4 / sympy-23950**:独立验证层的 rubric 一旦偏离真实验收对象,结构越多越有害。任何 verifier child 的 rubric 必须**就是** contract exit criteria,不允许自带标准。
- **Multi-candidate dominated / Full IHR 13× tokens**:不要把搜索拓扑、重型编排塞进 harness 默认路径;委派必须带 budget 字段。
- **"Stay the engineer" / supervision 层**:plan 的人工批准、外部 acceptance、危险操作确认不是要被自动化掉的摩擦,是 supervision 边界,保留。

---

## 4. 格局判断

### Thesis

loop-in-hook 把 harness 建成了一流的**刹车与档案系统**,而三方证据(NLAH 定量、Addy 与 teach_fireworks 定性)指向同一件事:下一层价值不在更聪明的拦截,而在**给 loop 装上发动机**——决策表从 TypeScript 迁回自然语言契约由宿主 LLM 解释,contract 升格为可委派的 agent-call κ(worker/verifier 分离),补上 scheduled heartbeat;hooks 收缩回它们被证据支持的本职:确定性 guards + state writers。

### Confidence

- **Level**: medium
- **Why not certain**:论文证据是 GPT-5.4 + Codex 0.114.0、n=125/36、单 seed 的 benchmark 子集,且自报 runtime contamination 风险;"NL 决策表自路由"在本仓库宿主(Claude Code / Codex)上的合规率从未实测——这正是 first proof point 要补的;委派层的 token 成本上界(13× 警示)未在本仓库工作负载下标定。

### The Trap

- **Inherited constraint**:"我们不拥有宿主 loop,hooks 是 Claude/Codex 唯一通用拦截面,所以控制逻辑必须住在 hooks(及其调用的 TS)里。"
- **Is it real?**: partially
- **Why**:对 **enforcement** 为真——阻断一次越权编辑只有 PreToolUse 能做,这条边界必须留在 hooks。对 **orchestration** 是惯性——NLAH 的 IHR 没有改任何宿主内核,就是 stock Codex + runtime skill + harness skill 跑出来的全部结果;本仓库自己也已有 `assets/skill-commands/` 命令面。"编排必须住在 hooks 里"从未被任何契约要求过。

### High-格局 Direction

目标模型三层,每层只做被证据支持的事:

1. **NL harness 层(新增/上移)**:`intent × plan-state` 决策表、路由规则、done 流程、委派拓扑写成自然语言契约(workflow contract / runtime-charter 命令面),由宿主 in-loop LLM 解释执行。UserPromptSubmit hook 不再分类语义,只注入 ~1KB **确定性状态快照**(plan/contract/evidence/worktree 状态,全部来自文件事实)。
2. **委派层(新增)**:contract 补齐 κ 字段(budget / permission scope / roles)。`contract-run`:worker child 在 contract worktree 内执行任务包,verifier child 以 exit criteria 为唯一 rubric 写 review 文件,parent 只 narrate(论文 runtime-only parent)。加 heartbeat:定时 triage(checks + sprint next + drift)写 triage inbox,人只看 inbox。
3. **确定性层(收缩)**:hooks 收敛到 pre-edit/worktree guards、post-tool observer、session-start 注入、stop 兜底证据检查;13 dispatch → ~6;`prompt-guard.sh` 1,076 行 → ~200 行(strip + snapshot + 显式触发 capture)。

### Frame-Opening Moves

- **Zero-legacy thought experiment**:2026 年 6 月从零做 repo-harness,宿主已原生提供 subagents、worktree 隔离、后台任务、skills——没人会写 600 行 TS 正则去猜用户 prompt 的意思,会把规则写进 agent 必读的契约文本里。分类器存在的唯一原因是它是 2025 年宿主能力下的历史产物。
- **Kill the wrong concept**:"prompt-intent classifier" 这个概念本身编码了错误模型(代码读自然语言)。不是修它、调它、加规则,是删除这个概念。
- **Ten-times question**:10 个 contract 的 sprint——现架构全部串行通过一个人类会话漏斗;委派架构是 N 个 worker/verifier 对在 worktree 里并行,parent + 人只处理 inbox。当前设计的弱轴在 10× 时第一个断。

### Bold Takes(kill list)

1. **删除 `prompt-intents.ts` 语义分类与 TS 内的 intent×plan-state 决策表**(经 staged 验证后)。替代:确定性状态快照注入 + NL 决策表。保留显式确定性触发(命令式 capture);"done" 从语言推断改为 **artifact 声明**——completion is an artifact, not an utterance:跑 close/verify 命令产生证据,Stop hook 做存在性兜底。
2. **`prompt-guard.sh` 从 1,076 行减到 ~200 行**;其 plan-state 读取逻辑全部复用 `workflow-state.sh` 既有函数。
3. **Contract 升格为完整 κ 并成为委派单元**(budget/permission scope/roles 字段 + `contract-run`)。verifier rubric **必须等于** contract exit criteria——这是从 NLAH verifier −8.4 直接抄来的红线。
4. **新增 heartbeat**:一个 cron/loop 定时跑 `check-task-workflow.sh` + `sprint-backlog.sh next` + drift 分诊,写 `triage inbox` 文件。Addy 五组件中唯一全缺的一个,也是最便宜的一个。
5. **不保留**:为分类器继续累积 lessons.md 修补规则;stop-orchestrator 的"以 block 模拟编排"长期化(NL 契约接管 self-review 流程后,Stop hook 退回纯证据兜底)。

### Options

| Option | What it optimizes | Cost | Verdict |
|--------|-------------------|------|---------|
| **Conservative path**:保留 TS 分类器,继续按 lessons.md 逐条修误报,hooks 拓扑不动 | 零迁移风险,现有测试全保 | 分类器维护无界(已三轮修补);决策表永远不是可编辑 harness 对象;G1–G3 三缺口原样保留 | **reject**——它优化的是"不动",而三方证据都说价值在另一边 |
| **Clean target**:一步删 TS 决策表 + 上委派层 + heartbeat | 终态最干净,一次到位 | NL 路由合规未实测就拆掉确定性兜底,不可回退;违反本报告自己的"小心求证" | not recommended(作为方向图保留) |
| **Staged clean path**:① proof-point eval(TS 路由 vs NL 自路由 A/B)→ ② 状态快照注入上线、TS 表降级为影子对照 → ③ contract κ 字段 + `contract-run`(单 contract 试点)→ ④ heartbeat → ⑤ eval 达标后删 TS 表 | 每步可回退、每步有证据 | 多一轮排序与影子期的双轨成本 | **recommended** |

### What Not To Do

- 不做 multi-candidate search、不给 verifier 发明独立 rubric、不默认重型编排——NLAH 负面结果三连。
- 不自动化 plan 批准与外部 acceptance——supervision 是边界不是摩擦("stay the engineer")。
- 不动 file-backed 脊柱与 edit 层确定性裁决——那是被 +5.5/+4.8 背书的资产。
- 不在 proof point 之前写任何删除分类器的代码——本报告是 hypothesis,不是许可证。

### First Proof Point

扩展现有 `bun run benchmark:skills` 基建(已有 `route-workflow-check` eval):同一组 prompt 场景(含 lessons.md 三个历史误报案例)下 A/B 对比——

- A 臂:现行 TS verdict 路由;
- B 臂:~1KB 状态快照注入 + NL 决策表(契约文本),宿主 agent 自路由。

度量:路由合规率、误报/漏报、每 prompt token 增量。这是整个方向最便宜的一张试纸,不改任何产品代码。

### Falsifier

以下任一成立即证伪(相应回退):

1. B 臂合规率显著低于 A 臂(agent 不可靠地遵守 NL 决策表)→ 分类器保留,但收缩为显式触发集合;
2. 快照 + NL 表的 token 增量在真实会话中失控(超出 advisory 注入现状一个量级)→ 快照降频/瘦身;
3. `contract-run` 试点中 worker/verifier child 的 review fail 率或证据质量劣于单会话基线 → 委派层重设计(可能回到"同会话、角色分离"的弱形态);
4. heartbeat inbox 两周内没有产生任何人类采纳的 triage 项 → 撤掉 cron,承认本仓库工作流没有无人值守发现的需求。

### Payoff Ledger(收益账单)

| Move | Price paid now | What it buys | When the payoff shows |
|------|----------------|--------------|-----------------------|
| 删 TS 语义分类 + 决策表迁入 NL 契约 | eval 基建 + 影子双轨期 + 删 ~600 行 TS、缩 ~850 行 bash 的回归测试 | lessons.md 中"误报修补"整类工作消失;决策表变成用户可直接编辑、可消融、可跨 repo 迁移的 harness 对象(NLAH 的 harness-as-research-object);engine 不可达降级路径消失 | 第一次新增路由规则只改契约文本、不发版就生效时 |
| Contract 补 κ + `contract-run`(worker/verifier 分离) | contract schema 扩展 + spawn 胶水 + 试点期 | sprint 内 N contract 并行(10× 轴解锁);自评偏置在结构上被消除(验证者不是写代码的那个 agent);budget 字段给委派加上 13× 警示要求的硬上限 | 第一个 sprint 有 2+ contract 在 worktree 里并行跑完、review 由 verifier child 写出时 |
| Heartbeat(定时 triage → inbox) | 一个 cron 任务 + 一个 inbox 文件约定 | 发现/分诊不再依赖人开口;drift request 与 sprint next 从"被动文件"变成"早晨的清单" | 第一个早晨 inbox 里出现一条人没触发过、但确实该处理的项 |
| Hook diet(13 → ~6 dispatch) | 路由注册表与测试重排 | 每个宿主事件回收 fork/exec 税(warm ~250ms,负载 >2s);hook 失败面收窄 | `tests/hook-runtime.test.ts` 的 phase-probe 计时数字直接下降 |

---

## 5. 证据引用附录(便于复核)

| 论断 | 出处(`_ref/nlah-2603.25723.pdf`) |
|------|------|
| Full IHR 74.4 / w-o RTS 76.0 / w-o HS 75.2;16.3M vs 1.2M tokens | p5 Table 1 |
| >110/125 样本各配置一致;solved-set replacer | p5 Table 2 及正文 |
| 模块消融全表(self-evo +4.8、file +1.6/+5.5、verifier −0.8/−8.4、multi −2.4/−5.6、dynamic 0/+2.7) | p6 Table 3 |
| ~90% 用量在 delegated children(91.5/91.9/90.2/90.6%) | p6 Table 4 |
| OS-Symphony 30.4 → 47.2;18.1 vs 18.2 步;可靠性机制搬迁 | p7 Table 5 及正文 |
| Agent call κ 形式化 T=(p, F_in, κ) | p14 Appendix A |
| Runtime charter 五原则(runtime-only parent、fork_context、STATE_ROOT/artifacts、contract-first completion) | p14–15 Appendix C |
| sympy-23950:verifier 说 solved、评测 fail;"extra process layers… drifting away from the actual acceptance object" | p16–17 Appendix E |
| Figure 4 score-cost:self-evolution 唯一帕累托改进;verifier/multi dominated | p16 Figure 4 |
| 六个 RQ2 模块的 NL 原文(file-backed state、evidence-backed、verifier separation、self-evolution、multi-candidate、dynamic orchestration) | p17–18 Appendix F |
| Addy 五组件、"replacing yourself as the person who prompts"、"stay the engineer"、token 经济警告 | addyosmani.com/blog/loop-engineering(2026-06-08) |
| 五层架构、"stronger models thin the harness"、evaluator alignment 风险 | `_ref/teach-fireworks-long-task-agent-min-loop-2026-05-25.md` |
| loop-in-hook 行数/拓扑/痛点 | `.ai/hooks/`、`src/cli/hook/`、`tasks/lessons.md`(2026-05-27 ~ 06-10 条目) |

---

## 6. 后续动作(留给读者决策,本报告不立项)

1. 若认可方向:把 **First Proof Point**(routing A/B eval)立为下一个 plan 的唯一 slice,走标准 plans/ → contracts/ 流程;
2. 若需要外部评审:本报告可走 gstack `plan-eng-review` 做工程压测,或用 `goudi` 做落地拆解;
3. brain 同步:是否注册进 `.ai/harness/brain-manifest.json`(repo-to-brain)由维护者决定——research 报告没有 `asset_path` 产品镜像,注册前需确认 `sync-brain-docs.sh` 对该字段缺省的行为。
