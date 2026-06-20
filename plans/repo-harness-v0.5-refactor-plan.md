# repo-harness v0.5 重构方案：拆分 user-level runtime 与 repo-level adoption

> 目标：用一次更大但更干净的 breaking refactor，彻底解决“全局安装后，每个项目仍像要初始化一次”的用户体验问题。
> 核心边界：`init/update` 只负责 user-level，`adopt/run` 只负责 repo-level，`setup check/doctor` 永远 read-only。

---

## 0. 执行摘要

当前问题不是缺少全局安装，而是 CLI 命令语义和实现边界混在一起：

- `repo-harness init` 已经被定义为 user/machine 首次 bootstrap。
- `repo-harness update` 当前仍混入 repo refresh、host adapters、skills、external tooling、CodeGraph 等动作。
- 大量本应 package/user-level 分发的 runtime docs、helper scripts、hook runtime、policy defaults 被 materialize 到每个 repo。
- `init-hook` 的 read-only Agent checklist 机制是正确方向，但还没有产品化为独立的 setup/readiness 层。

本次重构选择 **v0.5 breaking refactor**：

```text
init        = user/machine 首次 bootstrap
update      = CLI + user-level runtime 更新
adopt       = repo-level contract 安装、刷新、迁移、瘦身
run         = repo-level helper dispatch
setup check = read-only readiness / 原 init-hook 产品化
doctor      = read-only human-readable diagnostics
```

最终用户心智：

```bash
# 一台机器一次
repo-harness init

# 升级 CLI/runtime
repo-harness update

# 一个 repo 一次，之后按需刷新
repo-harness adopt

# 出问题时检查
repo-harness setup check

# repo workflow helper
repo-harness run check-task-workflow --strict
```

一句话原则：

```text
init/update 永远是 user-level
adopt/run 永远是 repo-level
setup check/doctor 永远 read-only
```

---

## 1. 现状问题

### 1.1 命令语义混乱

现在 `update` 名义上像“刷新 repo harness”，但用户直觉里 `update` 更像“更新 CLI”。如果全局安装后每个 repo 都还要 `update`，用户会觉得：

```text
我已经全局安装了，为什么每个项目还要初始化一次？
```

新的语义应该顺应用户直觉：

```text
repo-harness update = 更新 CLI / user runtime
repo-harness adopt  = 当前 repo 接入或刷新 harness
```

### 1.2 user-level 和 repo-level 动作耦合

当前实现中，repo refresh 路径会默认触发一些 user-level 动作：

- sync repo-harness skills
- install host adapters
- install external skills
- ensure CodeGraph
- configure MCP
- brain root sync 等

这些动作不应该随着每个 repo adoption 自动发生。它们应该属于：

```text
init    首次配置
update  CLI/runtime 更新
setup check 只检查并给出 agent_actions
```

### 1.3 repo surface 太重

当前 repo adoption 会倾向于把以下内容落到每个 repo：

- `.ai/harness/scripts/*` helper runtime 副本
- `.ai/hooks/*` hook runtime 副本或 fallback
- `docs/reference-configs/*` 大量通用参考文档
- `.ai/harness/policy.json` full merged policy
- `.claude/templates/*` 通用模板
- 兼容历史路径的 scripts wrappers

这导致：

- 每个 repo 都有 runtime 副本，升级 CLI 后还要刷新 repo。
- 通用文档和 policy defaults 变更会制造 repo diff。
- 用户难以区分“项目事实”和“repo-harness runtime 默认值”。

### 1.4 init-hook 方向正确但未产品化

`init-hook` 现在本质是 read-only readiness audit：

- 不写 hooks
- 不写 user-owned markdown
- 不改 repo runtime
- 聚合 status、doctor、global rules、tooling、legacy checks
- 输出 `agent_actions`

这应该成为正式命令：

```bash
repo-harness setup check --json
```

`init-hook` 保留为兼容 alias。

---

## 2. 新产品模型

### 2.1 命令职责表

| 命令 | Scope | 允许写入 | 禁止写入 | 语义 |
|---|---|---|---|---|
| `repo-harness init` | user-level | `~/.repo-harness/*`、`~/.claude/*`、`~/.codex/*`、user skills、host adapters | 当前 repo workflow files | 首次配置这台机器 |
| `repo-harness update` | user-level | global CLI package、repo-harness-owned global runtime、host adapter managed entries | 当前 repo workflow files | 更新 CLI/runtime |
| `repo-harness adopt` | repo-level | `.ai/harness/*`、`.ai/context/*`、`docs/spec.md`、`plans/`、`tasks/`、repo docs stubs/wrappers | `~/.claude/*`、`~/.codex/*`、global skills、global package | 安装或刷新 repo contract |
| `repo-harness run` | repo-level dispatch | repo workflow evidence only, if helper does so | user-level config | 运行 package-dispatched helper |
| `repo-harness setup check` | read-only | 无 | 无 | readiness audit / Agent actions |
| `repo-harness doctor` | read-only | 无 | 无 | 人类可读诊断 |

### 2.2 用户路径

首次安装：

```bash
bun add -g repo-harness
repo-harness init
```

更新 CLI：

```bash
repo-harness update
```

当前 repo 接入或刷新：

```bash
cd my-repo
repo-harness adopt --dry-run
repo-harness adopt
```

检查机器缺什么：

```bash
repo-harness setup check --json
```

---

## 3. 命令规范

### 3.1 `repo-harness init`

#### 用途

一次性 user-level bootstrap。

#### 支持参数

```bash
repo-harness init
repo-harness init --target codex|claude|both
repo-harness init --no-cli
repo-harness init --no-hooks
repo-harness init --no-sync-skill
repo-harness init --no-external-skills
repo-harness init --no-codegraph
repo-harness init --brain-root <path>
repo-harness init --refresh
repo-harness init --json
```

#### 默认动作

```text
1. 确认/安装 global CLI
2. 写 ~/.repo-harness/config.json
3. 写/刷新 ~/.claude/settings.json managed hook entries
4. 写/刷新 ~/.codex/hooks.json managed hook entries
5. 写/合并 ~/.claude/CLAUDE.md 与 ~/.codex/AGENTS.md 的 Global Working Rules managed block
6. 同步 repo-harness-owned skills/runtime aliases
7. 可选安装 Waza / Mermaid / cross-review skills
8. 可选配置 CodeGraph CLI/MCP
9. 最后跑 setup check
```

#### 禁止行为

`init` 不应该：

```text
- inspect 当前 repo
- 写 .ai/
- 写 tasks/
- 写 plans/
- 写 docs/spec.md
- 执行 repo migration
```

#### 错误提示

如果用户传入 repo 相关参数：

```text
repo-harness init is user-level only.
For repo-level setup, run:
  repo-harness adopt --repo .
```

---

### 3.2 `repo-harness update`

#### 用途

更新 CLI package 和 repo-harness-owned user-level runtime。

#### 支持参数

```bash
repo-harness update
repo-harness update --check
repo-harness update --version 0.5.1
repo-harness update --channel latest|next
repo-harness update --target codex|claude|both
repo-harness update --no-runtime-refresh
repo-harness update --json
```

#### 默认流程

```text
1. detect install source
2. check latest package version
3. install selected version
4. exec new CLI: repo-harness init --refresh
5. run setup check summary
```

#### 第三方 tooling 策略

`update` 可以刷新 repo-harness-owned runtime 和 managed host adapters，但不应该默认升级第三方工具：

- Waza
- Mermaid skill
- gbrain
- CodeGraph
- gstack
- `npx skills update`

第三方 tooling 的 install/upgrade 只由 `setup check` 输出 `agent_actions`，由用户或 Agent 显式执行。

#### 禁止行为

`update` 不接受：

```bash
repo-harness update --repo .
repo-harness update --dry-run    # 如果 dry-run 语义指 repo dry-run，应移到 adopt
repo-harness update --interactive # 如果是 repo install planner，应移到 adopt
```

错误提示：

```text
repo-harness update no longer refreshes repositories.
For repo-level refresh, run:
  repo-harness adopt --repo .
```

---

### 3.3 `repo-harness adopt`

#### 用途

repo-level contract 安装、刷新、迁移、瘦身。

#### 支持参数

```bash
repo-harness adopt
repo-harness adopt --repo <path>
repo-harness adopt --dry-run
repo-harness adopt --verify
repo-harness adopt --no-verify
repo-harness adopt --migrate-legacy
repo-harness adopt --compact
repo-harness adopt --mode minimal|standard|self-host
repo-harness adopt --json
```

#### 默认动作

```text
1. resolve git repo root
2. read-only 检查 user runtime readiness，只提示不修复
3. 创建/刷新 .ai/harness/workflow-contract.json
4. 创建/合并 .ai/harness/policy.json repo overrides
5. 创建/刷新 .ai/context/context-map.json 与 capabilities.json
6. 创建 docs/spec.md、plans/、tasks/、docs/architecture/ 等 repo contract surface
7. 写 docs/reference-configs/*.md pointer stubs
8. 写 scripts/* compatibility wrappers
9. 迁移/退休 legacy repo-local host adapters
10. verify repo workflow
```

#### 模式

```text
minimal
  - workflow contract
  - policy override
  - docs/spec.md
  - tasks/plans core surface
  - docs/reference-configs stubs

standard
  - minimal
  - architecture/workstream surfaces
  - compatibility wrappers
  - context map/capabilities

self-host
  - standard
  - repo-pinned hooks/helpers
  - full local runtime copies
  - used by repo-harness itself or explicit hook/helper development repos
```

#### 禁止行为

`adopt` 可以读 HOME 来给 readiness warnings，但不能写 HOME：

```text
- 不写 ~/.claude/*
- 不写 ~/.codex/*
- 不写 ~/.repo-harness/*
- 不安装 npm global package
- 不安装或升级 third-party skills
- 不配置 MCP
```

如果 readiness 不足，只输出：

```text
[adopt] user runtime attention:
  run: repo-harness setup check --json
```

---

### 3.4 `repo-harness setup check`

#### 用途

read-only readiness checklist。产品化原 `init-hook`。

#### 支持参数

```bash
repo-harness setup check
repo-harness setup check --target codex|claude|both
repo-harness setup check --check-updates
repo-harness setup check --json
```

#### 兼容 alias

```bash
repo-harness init-hook
```

#### 输出结构

```json
{
  "version": 1,
  "status": "ok",
  "target": "both",
  "checkUpdates": false,
  "summary": {
    "ok": 12,
    "warn": 0,
    "fail": 0,
    "na": 0,
    "needs_agent": 0
  },
  "checks": [],
  "agent_actions": []
}
```

#### Agent action contract

所有建议执行的 mutation 都必须带：

```json
{
  "id": "adapter.codex.install",
  "status": "needs_agent",
  "reason": "Codex user-level adapter is missing or does not match the route registry.",
  "requires_agent": true,
  "risk": "Writes user-level host hook config; preserve unmanaged user entries and re-check managed count.",
  "command": "repo-harness install --target codex --location global",
  "targets": ["~/.codex/hooks.json"],
  "verification": "repo-harness setup check --json"
}
```

`setup check` 自己永远不执行 `command`。

---

### 3.5 `repo-harness run`

#### 用途

从 package runtime dispatch repo helper，替代每个 repo 复制 `.ai/harness/scripts/*`。

#### 支持形式

```bash
repo-harness run <helper> [...args]
```

示例：

```bash
repo-harness run check-task-workflow --strict
repo-harness run plan-to-todo --plan plans/plan-xxx.md
repo-harness run verify-contract --contract tasks/contracts/xxx.contract.md
repo-harness run sprint-backlog next
```

---

## 4. 文件归属与写入边界

### 4.1 user-level files

只由 `init/update/install` 写：

```text
~/.repo-harness/config.json
~/.repo-harness/readiness/cache.json
~/.repo-harness/runtime/
~/.claude/settings.json
~/.codex/hooks.json
~/.codex/config.toml
~/.claude/CLAUDE.md
~/.codex/AGENTS.md
~/.claude/skills/*
~/.codex/skills/*
```

### 4.2 repo-level files

只由 `adopt/run` 写：

```text
.ai/harness/workflow-contract.json
.ai/harness/policy.json
.ai/context/context-map.json
.ai/context/capabilities.json
docs/spec.md
docs/architecture/index.md
docs/reference-configs/*.md
plans/
tasks/
scripts/repo-harness.sh
scripts/check-task-workflow.sh
```

### 4.3 package-level files

由 npm package 分发，不复制到普通 repo：

```text
assets/hooks/*
assets/reference-configs/*
assets/templates/*
assets/workflow-contract.v2.json
assets/policies/tasks-first-harness-v2.json
assets/helpers/*
```

---

## 5. 模块拆分方案

### 5.1 新目录结构

```text
src/cli/commands/
  init.ts
  update.ts
  adopt.ts
  setup.ts
  run.ts
  policy.ts
  docs.ts
  doctor.ts
  install.ts
  security.ts

src/cli/user-runtime/
  config.ts
  package-manager.ts
  runtime-refresh.ts
  host-adapters.ts
  global-rules.ts
  skills.ts
  codegraph.ts
  brain.ts
  readiness-cache.ts

src/cli/repo-adoption/
  repo-root.ts
  adopt-options.ts
  adopt-plan.ts
  adopt-apply.ts
  workflow-contract.ts
  policy-overrides.ts
  context-files.ts
  docs-stubs.ts
  helper-wrappers.ts
  legacy-migration.ts
  compact.ts
  verify.ts

src/cli/setup/
  check.ts
  checks/status.ts
  checks/doctor.ts
  checks/global-rules.ts
  checks/tooling.ts
  checks/legacy.ts
  agent-actions.ts

src/cli/runtime/
  helper-registry.ts
  helper-runner.ts
  policy-resolver.ts
  docs-resolver.ts
```

### 5.2 Import 边界

强制规则：

```text
commands/init.ts       -> user-runtime + setup only
commands/update.ts     -> user-runtime + setup only
commands/adopt.ts      -> repo-adoption + setup read-only only
commands/setup.ts      -> setup only
commands/run.ts        -> runtime + repo root only

user-runtime/*         must not import repo-adoption/*
repo-adoption/*        must not mutate HOME
setup/*                must not mutate HOME or repo
runtime/*              must not call npm install / npx skills add
```

建议加边界测试：

```text
tests/boundaries/import-boundaries.test.ts
tests/boundaries/scope-writes.test.ts
```

---

## 6. 核心实现设计

### 6.1 `runUserInit`

```ts
export interface UserInitOptions {
  target: "codex" | "claude" | "both";
  installCli: boolean;
  hostAdapters: boolean;
  syncSkill: boolean;
  externalSkills: boolean;
  codegraph: boolean;
  brainRoot?: string;
  refresh?: boolean;
  json?: boolean;
}

export function runUserInit(opts: UserInitOptions): UserRuntimeResult {
  const steps: UserRuntimeStep[] = [];

  if (opts.installCli) {
    steps.push(ensureCliInstalled());
  }

  steps.push(ensureRepoHarnessConfig(opts));
  steps.push(refreshManagedHostAdapters(opts));
  steps.push(writeGlobalWorkingRules(opts));

  if (opts.syncSkill) {
    steps.push(syncRepoHarnessOwnedSkills(opts));
  }

  if (opts.externalSkills) {
    steps.push(ensureExternalSkills(opts));
  }

  if (opts.codegraph) {
    steps.push(ensureCodegraphUserRuntime(opts));
  }

  steps.push(runSetupCheckSummary(opts));

  return renderUserRuntimeResult(steps);
}
```

### 6.2 `runCliUpdate`

```ts
export interface CliUpdateOptions {
  checkOnly?: boolean;
  version?: string;
  channel?: "latest" | "next";
  target: "codex" | "claude" | "both";
  runtimeRefresh: boolean;
  json?: boolean;
}

export function runCliUpdate(opts: CliUpdateOptions): CliUpdateResult {
  const current = detectInstallSource();
  const latest = resolveTargetVersion(opts);

  if (opts.checkOnly) {
    return renderUpdateCheck(current, latest);
  }

  const install = installGlobalPackage({
    source: current,
    version: opts.version ?? opts.channel ?? "latest",
  });

  if (opts.runtimeRefresh !== false) {
    execNewCli([
      "init",
      "--refresh",
      "--target",
      opts.target,
      "--no-external-skills",
    ]);
  }

  return renderCliUpdateResult(install, runSetupCheckSummary(opts));
}
```

### 6.3 `runRepoAdopt`

```ts
export interface RepoAdoptOptions {
  repo?: string;
  dryRun?: boolean;
  verify?: boolean;
  migrateLegacy?: boolean;
  compact?: boolean;
  mode: "minimal" | "standard" | "self-host";
  json?: boolean;
}

export function runRepoAdopt(opts: RepoAdoptOptions): RepoAdoptResult {
  const repoRoot = resolveGitRepoRoot(opts.repo ?? process.cwd());

  const readiness = runSetupCheckReadOnly({
    cwd: repoRoot,
    target: "both",
  });

  const plan = buildAdoptPlan(repoRoot, opts, readiness);

  if (opts.dryRun) {
    return renderAdoptPlan(plan);
  }

  applyWorkflowContract(repoRoot, plan);
  applyPolicyOverrides(repoRoot, plan);
  applyContextFiles(repoRoot, plan);
  applyDocsStubs(repoRoot, plan);
  applyHelperWrappers(repoRoot, plan);

  if (opts.migrateLegacy) {
    retireLegacyRepoAdapters(repoRoot, plan);
    migrateLegacyWorkflowDocs(repoRoot, plan);
  }

  if (opts.compact) {
    compactGeneratedRuntime(repoRoot, plan);
  }

  if (opts.verify !== false) {
    verifyRepoWorkflow(repoRoot);
  }

  return renderAdoptResult(plan, readiness);
}
```

---

## 7. Contract v2 设计

### 7.1 目标

Contract v2 把 repo-local contract 和 package runtime 分开：

```text
hooks   = package central-first
helpers = package dispatch
docs    = package runtime docs + repo pointer stubs
policy  = package defaults + repo overrides
```

普通 repo 不再默认复制完整 hook/helper runtime。

### 7.2 `.ai/harness/workflow-contract.json`

新格式：

```json
{
  "version": 2,
  "contractId": "tasks-first-harness-v2",
  "minCliVersion": "0.5.0",
  "runtime": {
    "hooks": {
      "mode": "central-first",
      "packageSource": "assets/hooks",
      "repoOverridePolicyKey": "hook_source",
      "repoOverrideValue": "repo"
    },
    "helpers": {
      "mode": "package-dispatch",
      "dispatcher": "repo-harness run",
      "repoOverridePolicyKey": "helper_source",
      "repoOverrideValue": "repo"
    },
    "docs": {
      "mode": "runtime-docs-with-repo-stubs",
      "resolver": "repo-harness docs show <doc-id>",
      "stubDirectory": "docs/reference-configs"
    },
    "policy": {
      "mode": "resolved-defaults-plus-repo-overrides",
      "resolver": "repo-harness policy show --resolved"
    }
  },
  "repoSurfaces": {
    "requiredDirectories": [
      "plans",
      "plans/archive",
      "plans/prds",
      "plans/sprints",
      "tasks",
      "tasks/contracts",
      "tasks/reviews",
      "tasks/notes",
      "tasks/workstreams",
      ".ai/context",
      ".ai/harness",
      "docs/architecture",
      "docs/reference-configs"
    ],
    "requiredFiles": [
      "docs/spec.md",
      "tasks/current.md",
      "tasks/todos.md",
      "tasks/lessons.md",
      ".ai/context/context-map.json",
      ".ai/context/capabilities.json",
      ".ai/harness/policy.json",
      ".ai/harness/workflow-contract.json",
      "docs/architecture/index.md"
    ],
    "compatibilityWrappers": [
      "scripts/repo-harness.sh",
      "scripts/check-task-workflow.sh"
    ]
  }
}
```

### 7.3 `.ai/harness/policy.json`

从 full merged policy 改成 override-only：

```json
{
  "version": 2,
  "extends": "repo-harness://policy/tasks-first-harness-v2",
  "overrides": {
    "hook_source": "central",
    "helper_source": "package",
    "guards": {
      "edit_plan_gate": "enforce"
    },
    "documentation": {
      "profile": "minimal-agentic"
    }
  }
}
```

新增命令：

```bash
repo-harness policy show --resolved
repo-harness policy path --default
repo-harness policy path --repo
```

Resolution 顺序：

```text
package defaults
→ ~/.repo-harness/config.json user defaults
→ .ai/harness/policy.json overrides
→ env overrides
```

### 7.4 `docs/reference-configs/*.md`

全部默认写 pointer stubs：

```md
<!-- repo-harness: reference-config-stub v1 -->
# repo-harness Reference: harness-overview

> **Runtime Docs**: user-level repo-harness reference
> **Doc ID**: harness-overview
> **Source Command**: `repo-harness docs show harness-overview`

This repo keeps workflow facts and runtime artifacts locally under `.ai/`.
The full generic runtime guide is supplied by the installed repo-harness package.

Use:

```bash
repo-harness docs path harness-overview
repo-harness docs show harness-overview
```
```

---

## 8. Helper package-dispatch

### 8.1 Helper registry

```ts
export const HELPERS = {
  "check-task-workflow": {
    file: "assets/helpers/check-task-workflow.sh",
    runtime: "bash"
  },
  "plan-to-todo": {
    file: "assets/helpers/plan-to-todo.sh",
    runtime: "bash"
  },
  "verify-contract": {
    file: "assets/helpers/verify-contract.sh",
    runtime: "bash"
  },
  "contract-run": {
    file: "assets/helpers/contract-run.ts",
    runtime: "bun"
  }
} as const;
```

### 8.2 Runner

```ts
export function runHelper(name: string, args: string[], cwd = process.cwd()): number {
  const helper = resolveHelper(name, cwd);
  if (!helper) {
    console.error(`repo-harness run: unknown helper "${name}"`);
    return 2;
  }

  const repoRoot = resolveGitRepoRoot(cwd);
  if (!repoRoot) {
    console.error("repo-harness run: not in a git repository");
    return 2;
  }

  return spawnHelper(helper, args, {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOOK_REPO_ROOT: repoRoot,
      REPO_HARNESS_HELPER_SOURCE: helper.source
    }
  });
}
```

### 8.3 Repo wrappers

`adopt` 写兼容 wrappers，而不是复制完整 helper runtime：

```bash
#!/bin/bash
set -euo pipefail
exec repo-harness run check-task-workflow "$@"
```

普通 repo：

```text
scripts/check-task-workflow.sh -> repo-harness run check-task-workflow
.ai/harness/scripts/*          -> not required
```

self-host repo：

```text
scripts/check-task-workflow.sh -> .ai/harness/scripts/check-task-workflow.sh
.ai/harness/scripts/*          -> full local copy
policy.helper_source           -> repo
```

---

## 9. Hook runtime 策略

保留 central-first hook runtime：

```text
1. REPO_HARNESS_HOOK_SOURCE env: repo | central | absolute hooks dir
2. repo policy pin "hook_source": "repo"
3. packaged assets/hooks
4. repo .ai/hooks fallback
```

普通 repo：

```text
~/.codex/hooks.json / ~/.claude/settings.json
→ repo-harness-hook
→ package assets/hooks
→ opt-in repo workflow state
```

self-host repo：

```text
~/.codex/hooks.json / ~/.claude/settings.json
→ repo-harness-hook
→ .ai/hooks
```

`.ai/hooks/README.md` 应明确：

```text
This repo does not pin hook_source=repo, so active hook execution is user-level and central-first.
Only self-hosted hook development repos should pin hook_source=repo.
```

---

## 10. Readiness cache

新增：

```text
~/.repo-harness/readiness/cache.json
```

格式：

```json
{
  "version": 1,
  "repoHarnessVersion": "0.5.0",
  "target": "both",
  "host": "darwin-arm64",
  "checkedAt": "2026-06-13T00:00:00Z",
  "ttlHours": 24,
  "status": "ok",
  "summary": {
    "ok": 12,
    "warn": 0,
    "fail": 0,
    "needs_agent": 0
  },
  "agentActions": []
}
```

SessionStart 不跑完整 `setup check`，只读 cache。触发轻量刷新条件：

```text
- CLI version 变化
- cache 超过 TTL
- 当前 repo opt-in 但 contract minCliVersion 不满足
- hook route scripts drift
- legacy repo-local adapter config 存在
```

当需要提示时，SessionStart 注入短 context：

```text
repo-harness setup attention:
- adapter.codex.install: repo-harness install --target codex --location global
- global-rules.insert: inspect ~/.codex/AGENTS.md and ~/.claude/CLAUDE.md
Run: repo-harness setup check --json
```

不自动修复。

---

## 11. Legacy 迁移策略

### 11.1 旧 `update --repo`

v0.5 直接禁用：

```text
repo-harness update no longer accepts --repo.
Use repo-harness adopt --repo . for repo-level refresh.
Use repo-harness update for CLI/global runtime update.
```

### 11.2 旧 `migrate`

保留一版 alias：

```bash
repo-harness migrate --apply
```

内部转为：

```bash
repo-harness adopt --migrate-legacy
```

### 11.3 repo-local host adapters

迁移目标：

```text
User-level adapters:
  ~/.claude/settings.json
  ~/.codex/hooks.json

Legacy cleanup targets:
  .claude/settings.json
  .claude/settings.local.json hooks
  .codex/hooks.json
```

处理策略：

```text
- known-generated managed entries: remove
- custom/unrecognized entries: preserve or archive
- invalid JSON: warn, no delete
- empty file after hooks removal: remove with backup
```

备份命名：

```text
<file>.repo-harness-v1-backup
```

### 11.4 `adopt --compact`

`compact` 做瘦身：

```text
1. 删除 generated .ai/harness/scripts/*，保留用户改过的
2. 删除 generated .ai/hooks/*.sh，保留 .ai/hooks/lib 或 repo pin
3. docs/reference-configs/*.md 改为 pointer stubs
4. full policy 改成 override-only policy
5. package.json scripts 改成 repo-harness run
6. legacy .claude/settings.json / .codex/hooks.json 退休或备份
```

删除只允许删除 known-generated 文件。unknown/custom 文件只能 preserve 或 archive。

---

## 12. 测试计划

### 12.1 Scope boundary tests

| Test | Expected |
|---|---|
| `init` in git repo | does not create `.ai/`, `tasks/`, `plans/` |
| `update` in git repo | does not modify repo files |
| `adopt` with temp HOME | does not modify `~/.claude`, `~/.codex`, `~/.repo-harness` |
| `setup check` | no writes anywhere |
| `adopt --mode self-host` | writes repo-pinned hooks/helpers |
| `adopt --mode standard` | does not write full hooks/helpers |

### 12.2 Migration tests

```text
v1 repo -> adopt --compact -> v2 repo
legacy .codex/hooks.json -> backup/remove if generated
legacy .claude/settings.json hooks -> retire managed entries
custom hooks -> preserve
custom docs/reference-configs -> preserve or archive, never overwrite silently
full generated policy -> override-only policy
package.json scripts -> repo-harness run
```

### 12.3 Runtime tests

```text
repo-harness-hook non-git repo -> exit 0
repo-harness-hook non-opt-in repo -> exit 0
repo-harness-hook opt-in repo -> package hooks by default
repo policy hook_source=repo -> repo hooks
repo policy helper_source=repo -> repo helpers
repo default helper_source=package -> repo-harness run helpers
```

### 12.4 Readiness tests

```text
setup check missing adapter -> needs_agent action
setup check missing global rules -> needs_agent action
setup check legacy project adapter -> needs_agent action
setup check --check-updates -> update advisories
setup check read-only snapshot -> no fs writes
```

### 12.5 Import boundary tests

```text
user-runtime cannot import repo-adoption
repo-adoption cannot import user-runtime mutators
setup cannot import fs write helpers
runtime cannot import package-manager / skills installer
```

---

## 13. 实施计划

### Phase 1：命令语义切断

改动：

```text
src/cli/index.ts
src/cli/commands/init.ts
src/cli/commands/update.ts
src/cli/commands/adopt.ts
src/cli/commands/setup.ts
```

目标：

```text
- update 改成 CLI/user-runtime update
- 新增 adopt
- init 保持 user-level bootstrap
- init-hook alias 到 setup check
- update --repo 报错
```

验收：

```bash
repo-harness update --repo .     # exit 2 + migration hint
repo-harness adopt --dry-run     # reports repo plan only
repo-harness setup check --json  # no writes
repo-harness init --json         # no repo writes
```

---

### Phase 2：模块拆分与边界测试

改动：

```text
src/cli/user-runtime/*
src/cli/repo-adoption/*
src/cli/setup/*
src/cli/runtime/*
tests/boundaries/*
```

验收测试：

```text
init with temp cwd repo:
  repo tree unchanged

update with temp cwd repo:
  repo tree unchanged

adopt with temp HOME:
  HOME tree unchanged

setup check:
  HOME unchanged
  repo unchanged
```

---

### Phase 3：contract v2

改动：

```text
assets/workflow-contract.v2.json
assets/policies/tasks-first-harness-v2.json
src/cli/repo-adoption/workflow-contract.ts
src/cli/runtime/policy-resolver.ts
src/cli/commands/policy.ts
```

验收：

```bash
repo-harness adopt --dry-run --json
repo-harness adopt
repo-harness policy show --resolved
```

检查：

```text
.ai/harness/policy.json 是 override-only
.ai/harness/workflow-contract.json 是 v2
docs/reference-configs 是 stubs
```

---

### Phase 4：helper package-dispatch

改动：

```text
src/cli/commands/run.ts
src/cli/runtime/helper-registry.ts
src/cli/runtime/helper-runner.ts
assets/helpers/*
scripts/lib/project-init-lib.sh
```

验收：

```bash
repo-harness run check-task-workflow --strict
bash scripts/check-task-workflow.sh --strict
```

普通 repo 不应该再有完整 `.ai/harness/scripts/*` runtime copy。

---

### Phase 5：compact/migrate

改动：

```text
src/cli/repo-adoption/legacy-migration.ts
src/cli/repo-adoption/compact.ts
tests/migration-script.test.ts
tests/bootstrap-files.test.ts
tests/workflow-contract.test.ts
```

验收：

```bash
repo-harness adopt --migrate-legacy --compact --dry-run
repo-harness adopt --migrate-legacy --compact
repo-harness run check-task-workflow --strict
```

---

### Phase 6：文档与 release

改动：

```text
README.md
README.zh-CN.md
docs/CHANGELOG.md
references/migration-guide.md
docs/architecture/modules/runtime-harness/*
```

README 新 quickstart：

```bash
bun add -g repo-harness
repo-harness init

cd my-repo
repo-harness adopt --dry-run
repo-harness adopt
repo-harness run check-task-workflow --strict
```

Release note 核心文案：

```text
Breaking: repo-harness update is now CLI/user-runtime update only.
Use repo-harness adopt to install or refresh repo-level workflow contracts.
```

---

## 14. 推荐 PR 拆分

### PR 1：CLI command semantics

```text
- add adopt command
- add setup check command
- make init-hook alias
- change update to reject --repo
- tests for command scope
```

### PR 2：User runtime extraction

```text
- move global-runtime into user-runtime/*
- init calls runUserInit
- update calls runCliUpdate
- no repo imports
```

### PR 3：Repo adoption extraction

```text
- move runInit repo pieces into repo-adoption/*
- adopt calls runRepoAdopt
- no HOME writes
```

### PR 4：Contract v2 + policy resolver

```text
- workflow-contract.v2.json
- override-only policy
- policy show --resolved
- v1->v2 migration
```

### PR 5：Helper package-dispatch

```text
- repo-harness run
- helper registry
- wrappers
- compact old helper runtime
```

### PR 6：Docs + migration guide

```text
- README quickstart
- zh-CN docs
- migration guide
- changelog
```

---

## 15. 风险与处理

| 风险 | 处理 |
|---|---|
| 旧用户习惯 `update --repo` | 明确 exit 2 + exact command hint |
| v1 repo 依赖 `.ai/harness/scripts/*` | `adopt --compact` 先写 wrappers，验证后再删 generated runtime |
| 自托管 repo 需要 repo-local hooks/helpers | `adopt --mode self-host` + policy pin |
| third-party skills 自动升级风险 | `update` 不默认升级 third-party；只由 `setup check` 输出 agent_actions |
| user-level markdown 被覆盖 | managed block merge；不覆盖 unmanaged content |
| policy override-only 影响旧 checker | contract v2 checker 先支持 v1+v2；之后再移除 v1 |
| package-dispatch helper 需要 CLI 在 PATH | `setup check` 检查；wrapper 给明确错误 |
| old docs/tests 仍 assert `.ai/harness/scripts/*` | 分 Phase 更新 workflow contract tests 与 bootstrap tests |

---

## 16. Definition of Done

### CLI 语义

```text
- repo-harness init 不写 repo
- repo-harness update 不写 repo
- repo-harness adopt 不写 HOME
- repo-harness setup check 不写任何文件
- repo-harness init-hook 是 setup check alias
```

### Runtime

```text
- hook runtime central-first
- helper runtime package-dispatch
- self-host 模式可 repo pin
-普通 repo 不复制完整 hook/helper runtime
```

### Repo surface

```text
- policy override-only
- reference docs stubs only
- workflow-contract v2
- compatibility wrappers 可用
```

### Migration

```text
- v1 repo 可 adopt --migrate-legacy --compact 到 v2
- custom hooks/docs/config preserve
- known-generated runtime 可安全删除
```

### Docs

```text
- README quickstart 使用 init/update/adopt/setup check/run 新语义
- migration guide 说明 update breaking change
- changelog 标记 v0.5 breaking refactor
```

---

## 17. 最终用户心智

最终用户只需要记住：

```bash
repo-harness init        # 这台机器准备好
repo-harness update      # 更新 CLI/runtime
repo-harness adopt       # 当前 repo 接入/刷新
repo-harness setup check # 检查缺什么，不自动写
repo-harness run ...     # 跑 repo workflow helper
```

这次重构的关键不是新增 `adopt` 命令，而是把所有写入动作按 ownership 分层：

```text
user-level 只归 init/update
repo-level 只归 adopt/run
检查只归 setup check/doctor
```

切完以后，全局安装后每个项目只需要轻量 `adopt`，不会再重复安装 CLI、skills、host adapters，也不会把通用 runtime 文档和 helper 副本铺到每个 repo。
