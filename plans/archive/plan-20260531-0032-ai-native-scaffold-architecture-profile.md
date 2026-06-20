# Plan: AI-Native Scaffold Architecture Profile

> **Status**: Archived
> **Created**: 20260531-0032
> **Slug**: ai-native-scaffold-architecture-profile
> **Planning Source**: waza-think
> **Orchestration Kind**: waza-think
> **Source Ref**: think scaffold AI-native architecture research
> **Spec**: `docs/spec.md`
> **Research**: See `tasks/research.md`
> **Sprint Contract**: `tasks/contracts/ai-native-scaffold-architecture-profile.contract.md`
> **Sprint Review**: `tasks/reviews/ai-native-scaffold-architecture-profile.review.md`
> **Implementation Notes**: `tasks/notes/ai-native-scaffold-architecture-profile.notes.md`

## Agentic Routing
- Selected route: planning
- Routing reason: Captured from waza-think planning output.
- Source ref: think scaffold AI-native architecture research
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260531-0032-ai-native-scaffold-architecture-profile.md`
- Sprint contract: `tasks/contracts/ai-native-scaffold-architecture-profile.contract.md`
- Sprint review: `tasks/reviews/ai-native-scaffold-architecture-profile.review.md`
- Implementation notes: `tasks/notes/ai-native-scaffold-architecture-profile.notes.md`
- Deferred-goal ledger: `tasks/todo.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/ai-native-scaffold-architecture-profile.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree; `.claude/.active-plan` is a legacy fallback during transition. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `scripts/plan-to-todo.sh --plan plans/plan-20260531-0032-ai-native-scaffold-architecture-profile.md` and may start `scripts/contract-worktree.sh start --plan plans/plan-20260531-0032-ai-native-scaffold-architecture-profile.md`.

## Approach
### Strategy
Use the captured planning output below as the execution source of truth.

### Trade-offs
| Option | Pros | Cons | Decision |
|--------|------|------|----------|
| Captured plan | Preserves the approved Codex Plan or Waza think decision | Requires the captured text to be concrete enough to execute | Use |

## Detailed Design
### File Changes
| File | Action | Description |
|------|--------|-------------|
| See captured planning output | Follow | Implement only the approved scope named below |

### Code Snippets
See captured planning output.

### Data Flow
See captured planning output.

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Captured plan lacks enough detail | Medium | Execution may need clarification | Stop before implementation if the captured output contradicts repo rules or lacks concrete file targets |

## Task Contracts
- Contract file: `tasks/contracts/ai-native-scaffold-architecture-profile.contract.md`
- Review file: `tasks/reviews/ai-native-scaffold-architecture-profile.review.md`
- Implementation notes file: `tasks/notes/ai-native-scaffold-architecture-profile.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `bash scripts/verify-contract.sh --contract tasks/contracts/ai-native-scaffold-architecture-profile.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan`, the owning worktree is written to `.ai/harness/active-worktree`, and the plan is mirrored to `.claude/.active-plan` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Evidence Contract

- **State/progress path**: `plans/plan-20260531-0032-ai-native-scaffold-architecture-profile.md` task breakdown, `tasks/todo.md` deferred-goal ledger, `tasks/contracts/ai-native-scaffold-architecture-profile.contract.md`, `tasks/reviews/ai-native-scaffold-architecture-profile.review.md`, and `tasks/notes/ai-native-scaffold-architecture-profile.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/ai-native-scaffold-architecture-profile.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: before execution remove `plans/plan-20260531-0032-ai-native-scaffold-architecture-profile.md`; after execution revert branch `codex/ai-native-scaffold-architecture-profile` or the generated task artifacts

## Captured Planning Output

**Building**: 给 `repo-harness-scaffold` 增加一个 AI-native scaffold profile system，而不是新增一个单独 Plan L。现有 A-K plan 继续是项目类型轴；AI-native profile 是叠加轴，用来决定 agent runtime、UI protocol、sidecar kernel、tool boundary、observability、frontend state 的默认结构。默认推荐形状是 Vite 8 + TanStack Router/Query + Bun/Hono agent gateway + AG-UI event transport + assistant-ui UI runtime；CopilotKit、A2UI、Python/Go/Rust sidecar 都作为场景化 profile，不做全量默认依赖。

**Not building**:
- 不把 Headroom、Caveman、CBM 加进默认 scaffold；CodeGraph 仍是结构导航 authority。
- 不新增 Plan L；保留 `assets/plan-map.json` 的 A-K 编码和现有测试约束。
- 不默认生成 Python、Go、Rust 三套服务；只生成边界和可选 sidecar profile。
- 不默认接入具体模型供应商、API key、云 tracing 账号或托管平台。
- 不把 A2UI 作为默认生产层；A2UI 作为实验性 declarative UI payload/profile。

## Evidence
- Repo map: `repo-harness-scaffold` 只负责新项目/模块创建，使用 `assets/plan-map.json` 的 A-K catalog，然后接 harness install path。
- Current plan authority: `assets/plan-map.json` hard-codes A-K and tests assert canonical A-K in `tests/plan-map-consistency.test.ts`.
- Current question authority: `assets/initializer-question-pack.v4.json` has 13 decision points; `tests/initializer-question-pack.test.ts` asserts v4 and the count.
- Current generation path: `scripts/assemble-template.ts` loads plan map and question pack; `scripts/init-project.sh` and `scripts/migrate-project-template.sh` attach workflow assets.
- Vite current docs show `v8.0.14`, Rolldown-based production builds, Bun scaffolding support, and Node.js `20.19+` / `22.12+` compatibility requirement: https://vite.dev/guide/
- AG-UI docs define an event-driven architecture with standardized run, message, tool, state, and custom events: https://docs.ag-ui.com/concepts/architecture and https://docs.ag-ui.com/concepts/events
- assistant-ui runtime docs position AG-UI, Vercel AI SDK v6, LangGraph, A2A, Google ADK and custom runtimes as adapter choices: https://www.assistant-ui.com/docs/runtimes/pick-a-runtime
- A2UI v0.8 is stable and v0.9 is current/draft; it is declarative UI across trust boundaries, not executable code: https://a2ui.org/
- MCP docs define tools/resources/prompts and official SDK tiers; TypeScript, Python, Go are Tier 1 and Rust is Tier 2 as of current docs: https://modelcontextprotocol.io/docs/getting-started/intro and https://modelcontextprotocol.io/docs/sdk
- OpenTelemetry GenAI semantic conventions are still development status, so scaffold should prepare names/span surfaces without pretending they are final-stable: https://opentelemetry.io/docs/specs/semconv/gen-ai/

## P1 Map
Relevant repo components:
- `assets/skill-commands/repo-harness-scaffold/SKILL.md`: public scaffold command contract.
- `assets/plan-map.json`: project-type authority for A-K plan choices and default template variables.
- `assets/initializer-question-pack.v4.json` plus `assets/initializer-question-pack.v4.schema.json`: guided Q&A authority.
- `scripts/initializer-question-pack.ts`: runtime loader and preferred package manager inference.
- `scripts/assemble-template.ts`: plan/question-pack consumption and template variable expansion.
- `assets/project-structures/*.txt`: generated structure examples.
- `assets/templates/*.template.md`: generated documentation surfaces.
- `scripts/init-project.sh`, `scripts/migrate-project-template.sh`, `scripts/lib/project-init-lib.sh`: final project creation and workflow attach path.
- Tests: `tests/initializer-question-pack.test.ts`, `tests/plan-map-consistency.test.ts`, `tests/output-parity.test.ts`, `tests/scaffold-parity.test.ts`, `tests/create-project-dirs.runtime.test.ts`, `tests/migration-script.test.ts`.

Responsibility split:
- Plan catalog owns repo type, not AI maturity.
- Question pack owns material scaffold decisions.
- Template variables own generated prose and project tree hints.
- External tooling policy owns agent-workflow readiness, not app runtime dependencies.
- Generated app runtime owns AG-UI/MCP/sidecar boundaries only when the chosen AI-native profile needs them.

Out of scope:
- Product-specific model selection.
- Provider credentials.
- Real service deployment.
- Replacing the repo-harness workflow contract.

## P2 Traced Path
Concrete scaffold path:
1. User invokes `repo-harness-scaffold` with a project type.
2. The command uses `assets/plan-map.json` to select Plan C/D/E/K-style stack defaults.
3. The initializer asks guided questions from `assets/initializer-question-pack.v4.json`.
4. `scripts/initializer-question-pack.ts` and `scripts/assemble-template.ts` resolve defaults and template variables.
5. `scripts/init-project.sh` creates files and project structure.
6. `scripts/migrate-project-template.sh` attaches repo-harness workflow files, policy, hooks, and reference docs.
7. Generated repo verification runs scaffold parity, task workflow, and migration dry-run checks.

Proposed AI-native runtime path inside generated apps:
1. Browser route renders app shell with TanStack Router.
2. Chat/agent panel uses assistant-ui; agent console state is held in a bounded run store.
3. assistant-ui connects through AG-UI `HttpAgent` or equivalent adapter.
4. Bun/Hono exposes `/api/agent/run` and streams AG-UI events.
5. Agent gateway delegates model-native orchestration to TS or Python, and delegates tool/work kernels to MCP servers or HTTP sidecars.
6. Go/Rust sidecars expose typed MCP tools or narrow HTTP jobs; they do not own UI protocol.
7. Events stream back as lifecycle, text, tool, state, interrupt/approval, and custom events.
8. TanStack Query owns server cache; TanStack Router search params own shareable URL state; Zustand owns run/session store; Jotai is only for local atomic UI/graph state when needed.
9. OpenTelemetry spans/log events record model calls, tools, handoffs, approvals, sidecar latency, and user-visible run outcome.

Bug/design pressure appears at step 3 of current scaffold: question pack has no AI-native profile dimension, so Plan C/D/E/K cannot express whether the app is a normal SaaS, agent runtime console, product copilot, or sidecar-heavy agent workbench.

## P3 Decision Rationale
The current A-K map likely exists to keep scaffold choices finite and testable. That invariant should stay. Adding another plan code for every AI stack combination would explode the catalog and break the simple A-K mental model. The smallest coherent change is therefore an overlay/profile model:

- Project type axis: A-K remains stable.
- AI-native profile axis: `none`, `chat-agent`, `runtime-console`, `product-copilot`, `workflow-agent`, `generative-ui-agent`, `browser-agent`, `research-agent`, `coding-agent`, `enterprise-agent-platform`, `voice-agent`, `sidecar-kernel`.
- Runtime defaults are generated from the cross product only where meaningful.

This works at 10x project count because the catalog does not multiply; tests can assert profile metadata separately. It fails first if the profile overlay starts owning concrete dependencies without generated files/tests proving them. Mitigation: start with docs/structure/policy defaults and one generated project-structure overlay before adding package install automation.

## Approach
Recommended implementation:
1. Add AI-native profile metadata to the scaffold question pack.
2. Add AI-native overlay metadata to plan map entries without changing A-K codes.
3. Add generated project structure overlays for `runtime-console`, `product-copilot`, and `sidecar-kernel`; keep the remaining scenario templates as documented presets until generated output needs them.
4. Update docs/templates so generated tech-stack docs explain protocol/runtime/state/data/sidecar boundaries.
5. Add tests that prove the profile is loaded, defaulted, and documented without changing existing A-K behavior.

Minimal option:
- Only add a new optional `ai_native_profile` decision point plus generated docs text. This is low-risk but does not give enough structure for sidecar projects.

Rejected alternative:
- Add Plan L for AI-native apps. Rejected because `plan-map` and tests intentionally define A-K, and AI-native is not one project type. It cuts across Plan C, D, E, J, and K.

## Proposed Profile Defaults
| Profile | Use case | Frontend | Runtime protocol | Backend | State default | Sidecar policy | UI schema |
|---|---|---|---|---|---|---|---|
| `none` | normal app | existing plan default | none | existing plan default | existing plan default | none | none |
| `chat-agent` | ordinary AI chat/RAG/help | Vite 8 + assistant-ui | AI SDK UI stream or AG-UI lite | Bun/Hono or existing API | TanStack Query + Zustand | Python only if model framework needs it | hardcoded components |
| `runtime-console` | runtime/debug console, trace, replay, prompt playground | Vite 8 + assistant-ui + custom trace/timeline | AG-UI required | Bun/Hono gateway | TanStack Query + Zustand + Jotai | Python sidecar allowed | A2UI optional, not default |
| `product-copilot` | SaaS in-app copilot | Vite 8 + CopilotKit or assistant-ui headless | AG-UI | Bun/Hono gateway | TanStack Query + Zustand/Jotai | MCP tools for business actions | optional A2UI experiment |
| `workflow-agent` | visual agent workflow/DAG builder | Vite 8 + React Flow/xyflow + Monaco | AG-UI | Bun/Hono gateway | Jotai + Zustand + TanStack Query | LangGraph/Temporal/Inngest optional executors | A2UI optional |
| `generative-ui-agent` | agent-generated UI, dynamic forms/cards/tables | Vite 8 + safe React registry | AG-UI | Bun/Hono gateway | Jotai + TanStack Query | sidecar only if renderer/tools need it | A2UI experimental |
| `browser-agent` | browser automation/computer-use/RPA | Vite 8 custom console | AG-UI | Bun/Hono gateway | Jotai + TanStack Query | Playwright/Browserbase/Stagehand worker | none by default |
| `research-agent` | deep research/evidence/report workspace | Vite 8 + assistant-ui + artifacts | AG-UI | Bun/Hono gateway | TanStack Query + Zustand + Jotai | Python optional for research pipelines | hardcoded artifacts first |
| `coding-agent` | AI IDE/repo/PR/devops agent | Vite 8 + assistant-ui + Monaco + diff/terminal panels | AG-UI + MCP optional | Bun/Hono gateway | Jotai + TanStack Query | sandbox worker, Go/Rust optional | none by default |
| `enterprise-agent-platform` | multi-tenant agent platform | Astro for web/docs/SSR shell + Vite 8 apps | AG-UI | Bun/Hono gateway | TanStack Query + Zustand + Jotai | sidecars by capability | A2UI optional |
| `voice-agent` | realtime voice/call assistant | Vite 8 realtime UI | AG-UI side-channel + WebRTC | Bun/Hono gateway | TanStack Query + Zustand | realtime/media sidecar optional | none by default |

## Stack Position
- TS/Bun/Hono: default app-facing agent gateway. Use Web Standards, streaming, middleware, and type-safe client/RPC patterns.
- Python sidecar: use when agent framework/model ecosystem is the reason, e.g. OpenAI Agents SDK, LangGraph, PydanticAI, eval jobs, data science tools. It should emit AG-UI events or expose MCP/HTTP; it should not be imported into TS runtime.
- Go: use for long-lived workers, high-concurrency tool servers, infra adapters, and static deployment units. Prefer MCP server or narrow HTTP API.
- Rust: use for low-latency, parsing, indexing, sandboxing, native extensions, and data-heavy kernels. Prefer MCP/HTTP boundary; do not make it default app runtime.
- Astro: marketing/docs/content shell. Do not use it for agent console app shell.
- Vite 8: default React app build for AI-native UI shells. Capture Node version requirement in generated tech-stack docs.
- TanStack Router/Query: default app routing/cache. TanStack Start stays opt-in until a project actually needs full-stack SSR/server functions.
- Zustand/Jotai: default to Zustand for simple global UI state; add Jotai for workflow canvas selection, inspector filters, artifact editors, IDE state, multi-panel coordination, and derived local product state. Do not make both libraries compete for the same state domain.
- AG-UI: protocol/event bus for agent runtime UI.
- assistant-ui: default React chat/agent UI runtime.
- CopilotKit: profile default for product-copilot, not agent-console.
- A2UI: experimental payload/schema layer over AG-UI or MCP Apps when the product needs generated interactive UI across trust boundaries.
- Vercel AI SDK UI: good for plain chat/stream hooks; not the default complex agent runtime bus.

## Reference Plan Incorporation
The user-provided scaffold proposal is adopted as a profile taxonomy and stack policy, not as a separate public CLI product.

Adopt:
- `No Next.js`: do not add Next.js to default scaffold recommendations; use Astro for SSR/content and Vite 8 for app/console/IDE/workflow surfaces.
- `Bun-first`: use Bun workspaces as the default TypeScript monorepo base unless an existing repo or user override requires pnpm/npm.
- `Hono on Bun`: make Hono the default API gateway for AI-native generated structures.
- `runtime-console` is the default advanced template because it covers chat, tool calls, run events, approval, artifacts, trace, replay, prompt editing, and agent playground workflows.
- Shared contracts are a first-class package: generated overlays should describe `packages/contracts` for Zod/Valibot schemas covering runs, events, threads, tools, approvals, artifacts, workflows, and optional A2UI payloads.
- Data defaults for generated docs: Postgres + Drizzle by default; Redis/Object Storage/OpenTelemetry as common advanced defaults; pgvector/Qdrant, ClickHouse, Temporal/Inngest/BullMQ/Trigger.dev only as opt-in capabilities.

Reject or defer:
- Do not expose a new `bun create agent-scaffold` command from this repo. The existing public command remains `repo-harness-scaffold`; template names can be profile values or examples.
- Do not scaffold every scenario as generated files in the first implementation. Start with `runtime-console`, `product-copilot`, and `sidecar-kernel` overlays, then document the remaining profiles.
- Do not generate custom AG-UI event schemas that conflict with AG-UI's official event model. If the scaffold adds local `RunEvent` contracts, they must be documented as app-domain events/adapters over AG-UI, not a replacement protocol.
- Do not make Redis, ClickHouse, Temporal, Sentry, enterprise auth, vector DB, browser automation providers, or object storage mandatory defaults.

## File Changes
| File | Action | Description |
|---|---|---|
| `assets/initializer-question-pack.v4.json` | Modify | Add optional `ai_native_profile` decision point and profile definitions. |
| `assets/initializer-question-pack.v4.schema.json` | Modify | Validate the new profile structure. |
| `scripts/initializer-question-pack.ts` | Modify | Extend TypeScript interfaces and summary output with AI-native profile metadata. |
| `assets/plan-map.json` | Modify | Add overlay defaults per plan without adding new plan codes. |
| `scripts/assemble-template.ts` | Modify | Expose AI-native overlay variables to templates. |
| `assets/project-structures/ai-native-runtime-console.txt` | Add | Project tree overlay for AG-UI + assistant-ui + Bun/Hono gateway. |
| `assets/project-structures/ai-native-product-copilot.txt` | Add | Project tree overlay for CopilotKit/AG-UI app copilot. |
| `assets/project-structures/ai-native-sidecar-kernel.txt` | Add | Project tree overlay for Python/Go/Rust sidecar boundaries without replacing TS core. |
| `assets/templates/tech-stack.template.md` | Modify | Add protocol/runtime/state/observability rows when AI-native profile is enabled. |
| `references/tech-stacks.md` | Modify | Document profile selection and recommended stacks. |
| `SKILL.md` / `README.md` | Modify | Mention AI-native profile overlay under scaffold without changing A-K plan index. |
| `tests/initializer-question-pack.test.ts` | Modify | Assert decision count/profile defaults and backward-compatible loading. |
| `tests/plan-map-consistency.test.ts` | Modify | Assert A-K remains unchanged and profile overlay is not a plan code. |
| `tests/output-parity.test.ts` / `tests/scaffold-parity.test.ts` | Modify | Assert generated docs include AI-native profile text only when enabled. |

This is more than 8 files, but it is one reviewable unit because the changed authority surfaces are tightly coupled: question pack, plan map, generation code, docs, and tests.

## Verification
- `bun test tests/initializer-question-pack.test.ts tests/plan-map-consistency.test.ts tests/output-parity.test.ts tests/scaffold-parity.test.ts`
- `bun test`
- `bash scripts/check-deploy-sql-order.sh`
- `bash scripts/check-task-sync.sh`
- `bash scripts/check-task-workflow.sh --strict`
- `bun scripts/inspect-project-state.ts --repo . --format text`
- `bash scripts/migrate-project-template.sh --repo . --dry-run`

Manual acceptance:
- Plan C without AI profile generates the same Vite/TanStack shape as before.
- Plan C with `runtime-console` documents AG-UI, assistant-ui, Bun/Hono gateway, state split, contracts, data defaults, and observability boundaries.
- Plan D with `sidecar-kernel` documents Python/Go/Rust as sidecar boundaries, not default UI runtime.
- Plan E with AI profile keeps Astro as marketing/content surface and points app shell to Vite/TanStack when needed.
- Generated docs never imply A2UI is production-default.

## Risk Assessment
| Risk | Likelihood | Impact | Mitigation |
|---|---:|---:|---|
| Profile overlay complicates simple scaffold flow | Medium | Medium | Keep profile optional and default `none` unless user requests AI-native. |
| A2UI draft churn creates stale recommendations | Medium | Medium | Mark A2UI experimental; default to AG-UI + hardcoded components. |
| Too many stacks become default dependencies | Medium | High | Generate boundaries/docs first; install only core selected dependencies in later slice. |
| Tests become brittle around decision count | High | Low | Update tests to assert ids/profile existence rather than only raw count where appropriate. |
| OTel GenAI conventions change before stable | Medium | Low | Generate observability concepts, not fixed attribute names as hard contract. |

## Rollback
Revert the scaffold-profile commit. Because this plan only changes generated defaults/docs/tests and does not migrate external data, rollback is a normal git revert. If a generated downstream project already used the profile, rerun scaffold/init with `ai_native_profile=none` or remove the generated AI overlay docs manually.

## Task Breakdown
- [ ] Extend question-pack schema and loader with `ai_native_profile` profiles.
- [ ] Add plan-map AI-native overlay defaults while preserving A-K plan codes.
- [ ] Add AI-native project-structure overlays for runtime console, product copilot, and sidecar kernel.
- [ ] Update generated tech-stack/reference docs with protocol/runtime/state/data/contracts/sidecar boundaries.
- [ ] Add targeted tests for backward compatibility and profile-enabled output.
- [ ] Run full required checks and record deviations in `tasks/notes/ai-native-scaffold-architecture-profile.notes.md` only if non-obvious tradeoffs arise.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->
