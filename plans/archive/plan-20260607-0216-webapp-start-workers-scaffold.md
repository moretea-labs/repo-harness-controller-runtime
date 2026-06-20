# Plan: Webapp Start Workers Scaffold Refresh

> **Status**: Archived
> **Created**: 20260607-0216
> **Slug**: webapp-start-workers-scaffold
> **Planning Source**: repo-harness-plan
> **Orchestration Kind**: repo-harness-plan
> **Source Ref**: user-provided Salesko Start/Workers architecture as scaffold reference
> **Spec**: `docs/spec.md`
> **Research**: See `tasks/research.md`
> **Sprint Contract**: `tasks/contracts/20260607-0216-webapp-start-workers-scaffold.contract.md`
> **Sprint Review**: `tasks/reviews/20260607-0216-webapp-start-workers-scaffold.review.md`
> **Implementation Notes**: `tasks/notes/20260607-0216-webapp-start-workers-scaffold.notes.md`

## Agentic Routing
- Selected route: planning
- Routing reason: Captured from repo-harness-plan planning output.
- Source ref: user-provided Salesko Start/Workers architecture as scaffold reference
- Due diligence:
  - P1 map: See captured planning output below.
  - P2 trace: See captured planning output below.
  - P3 decision rationale: See captured planning output below.

## Workflow Inventory
Complete this inventory before implementation. If any line is unknown, keep the plan in Draft and fill it before projection.

- Active plan: `plans/plan-20260607-0216-webapp-start-workers-scaffold.md`
- Sprint contract: `tasks/contracts/20260607-0216-webapp-start-workers-scaffold.contract.md`
- Sprint review: `tasks/reviews/20260607-0216-webapp-start-workers-scaffold.review.md`
- Implementation notes: `tasks/notes/20260607-0216-webapp-start-workers-scaffold.notes.md`
- Deferred-goal ledger: `tasks/todo.md`
- Current checks: `.ai/harness/checks/latest.json`
- Run snapshots: `.ai/harness/runs/`
- Scope authority: `tasks/contracts/20260607-0216-webapp-start-workers-scaffold.contract.md` `allowed_paths`
- Concurrency rule: `.ai/harness/active-plan` selects the active plan for this worktree when present; `.ai/harness/active-worktree` records the owning worktree; `.claude/.active-plan` is a legacy fallback during transition. If another worktree already owns active work, open or switch to the matching worktree instead of serializing unrelated plans.
- Execution isolation: approved contract-level work projects through `scripts/plan-to-todo.sh --plan plans/plan-20260607-0216-webapp-start-workers-scaffold.md` and may start `scripts/contract-worktree.sh start --plan plans/plan-20260607-0216-webapp-start-workers-scaffold.md`.

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
- Contract file: `tasks/contracts/20260607-0216-webapp-start-workers-scaffold.contract.md`
- Review file: `tasks/reviews/20260607-0216-webapp-start-workers-scaffold.review.md`
- Implementation notes file: `tasks/notes/20260607-0216-webapp-start-workers-scaffold.notes.md`
- Template: `.claude/templates/contract.template.md`
- Verification command: `bash scripts/verify-contract.sh --contract tasks/contracts/20260607-0216-webapp-start-workers-scaffold.contract.md --strict`
- Active plan rule: this captured plan is written to `.ai/harness/active-plan`, the owning worktree is written to `.ai/harness/active-worktree`, and the plan is mirrored to `.claude/.active-plan` unless --no-active is used. Do not infer active execution from the latest non-archived plan.

## Handoff

- Checks file: `.ai/harness/checks/latest.json`
- Session handoff: `.ai/harness/handoff/current.md`

## Evidence Contract

- **State/progress path**: `plans/plan-20260607-0216-webapp-start-workers-scaffold.md` task breakdown, `tasks/todo.md` deferred-goal ledger, `tasks/contracts/20260607-0216-webapp-start-workers-scaffold.contract.md`, `tasks/reviews/20260607-0216-webapp-start-workers-scaffold.review.md`, and `tasks/notes/20260607-0216-webapp-start-workers-scaffold.notes.md`
- **Verification evidence**: `.ai/harness/checks/latest.json`, `.ai/harness/runs/`, and the commands named in the captured planning output
- **Evaluator rubric**: `tasks/reviews/20260607-0216-webapp-start-workers-scaffold.review.md` must record a passing Waza /check style recommendation
- **Stop condition**: all task breakdown items are complete, sprint verification passes, and the review recommends pass
- **Rollback surface**: before execution remove `plans/plan-20260607-0216-webapp-start-workers-scaffold.md`; after execution revert branch `codex/webapp-start-workers-scaffold` or the generated task artifacts

## Captured Planning Output

**Verdict**

更新 repo-harness scaffold 的 Webapp stack default：当项目需要 public landing 的 SEO/SSR 同时还有 authenticated/client-heavy workspace 时，推荐 **TanStack Start + Vite + Cloudflare Workers** 作为单一 `apps/web` 前端部署。

不要把新 scaffold 默认生成成 `apps/marketing` + `apps/web` 两个可部署前端组件。`apps/marketing` 只能作为 legacy/rollback surface 或显式 opt-in content app，不作为默认架构。

## P1 Map

Authoritative scaffold surfaces:

- `assets/plan-map.json`: A-K stack-family source of truth. Plan B currently means Vite client app shell; Plan C currently means TanStack Start or React Router Framework Mode only when needed; Plan E owns Cloudflare edge web stack guidance; Plan D owns shared Bun workspace guidance.
- `assets/initializer-question-pack.v4.json` and schema: guided decisions and inferred defaults. It already has AI-native overlay; this plan should add or refine a webapp rendering/deployment decision without creating Plan L.
- `scripts/initializer-question-pack.ts`: typed loader/summary surface for new guided decision metadata.
- `scripts/assemble-template.ts`: expands plan map/question pack variables into generated `CLAUDE.md`/`AGENTS.md` and docs.
- `assets/project-structures/*.txt`: scaffold-visible project structures. Existing `vite-tanstack.txt` represents client-only Vite, and `astro-ssr.txt` represents Astro/content shell; this plan needs a Start + Workers structure surface.
- `assets/templates/tech-stack.template.md` plus `assets/partials/*`: generated docs and root context surfaces that describe stack, routing, Cloudflare deployment, and project structure.
- `references/tech-stacks.md`, `SKILL.md`, `README.md`, and `docs/reference-configs/release-deploy.md`: public/advisory scaffold docs.
- Tests: `tests/plan-map-consistency.test.ts`, `tests/initializer-question-pack.test.ts`, `tests/output-parity.test.ts`, `tests/scaffold-parity.test.ts`, `tests/create-project-dirs.runtime.test.ts`, and a focused unit test for the new webapp stack rule.

Out of scope:

- No Salesko app implementation changes.
- No generated production app code beyond scaffold docs/structure guidance unless the existing generator already owns that surface.
- No new Plan code. A-K stays stable.
- No default provider secrets, auth implementation, domain cutover, or deployment execution.
- No retirement of legacy `apps/marketing` docs unless the generated-default guidance is safely separated from legacy rollback guidance.

Docs/current framework facts to preserve in implementation:

- TanStack Start uses `@tanstack/react-start/plugin/vite` before the React Vite plugin.
- TanStack Start supports selective SSR with route-level `ssr: false`, which is the correct default for `/app` style WebGL/auth workspace routes.
- TanStack Start Cloudflare hosting uses `@cloudflare/vite-plugin`, `wrangler.jsonc`, `wrangler deploy`, and Worker assets rather than `wrangler pages deploy`.
- Cloudflare Worker deploy config should describe Worker `main`, `assets`, `compatibility_date`, and `nodejs_compat` only when needed.

Source docs used for this plan:

- TanStack Start build from scratch: https://tanstack.com/start/latest/docs/framework/react/build-from-scratch.md
- TanStack Start selective SSR: https://tanstack.com/start/latest/docs/framework/react/guide/selective-ssr.md
- TanStack Start Cloudflare hosting: https://tanstack.com/start/latest/docs/framework/react/guide/hosting.md
- Cloudflare Workers Vite plugin: https://developers.cloudflare.com/workers/vite-plugin/reference/api/

## P2 Traced Path

Current scaffold trace:

1. User chooses a stack family through `repo-harness-scaffold` or generated initializer prompts.
2. `assets/plan-map.json` maps Plan B/C/D/E to default stack variables.
3. `assets/initializer-question-pack.v4.json` contributes inferred defaults and optional AI-native profile metadata.
4. `scripts/assemble-template.ts` merges plan variables, question-pack defaults, and user variables.
5. Generated context/docs describe project structure, tech stack, Cloudflare guidance, and verification surfaces.
6. Existing repo migration attaches workflow assets through `scripts/migrate-project-template.sh` and helper templates.

Target trace for Webapp stack:

1. User selects a webapp/SaaS stack that needs SEO/SSR and authenticated workspace, usually Plan C directly or Plan D/E with a web frontend.
2. The scaffold resolves `webapp_rendering_model = start-workers` or equivalent metadata from plan defaults or guided Q&A.
3. Template assembly emits one `apps/web` frontend component:
   - `/` is SSR/prerender-capable landing/public route with meta, OG, canonical, and crawler-visible HTML.
   - `/app` is client-only through `ssr: false` or an equivalent route boundary.
   - WebGL/canvas/browser-only components stay lazy/client-only and are not imported into SSR execution.
4. The generated structure includes `apps/web/wrangler.jsonc`, TanStack Start route files, explicit env names such as `VITE_API_BASE_URL` and `VITE_AGENT_API_URL`, and Cloudflare Worker deploy commands.
5. Independent backend runtimes remain separate components only when they are true runtime authorities, for example `apps/api`, `apps/agent`, `apps/mcp`, or service packages.
6. Generated release guidance says apex/root domain can point to the web Worker, with any former marketing/Pages app treated as rollback/legacy, not as a second default frontend deploy.

Failure path to document:

- If TanStack Start + Workers scaffold cannot pass build/dev smoke, fallback is not two frontends. Fallback is an explicit framework evaluation between Vike and React Router Framework Mode, captured as a separate plan/update.

## P3 Decision Rationale

The existing scaffold shape likely exists for good reasons:

- Plan B keeps pure client apps cheap and simple.
- Plan A keeps Astro-first content/SSR sites clear.
- Plan C avoids making full-stack React mandatory until SSR/server functions are actually needed.
- Plan E keeps Cloudflare edge concerns separated from app runtime choice.
- AI-native profile already uses an overlay axis so A-K does not explode.

The new invariant is narrower: a modern SaaS webapp with public SEO landing plus authenticated client-heavy workspace should not be scaffolded into two separately deployed frontend components by default. The smallest coherent change is therefore to update the scaffold decision model and docs, not to replace all Vite guidance.

Decision:

- Keep Plan B as client-only Vite + TanStack Router/Query for internal apps, dashboards, embedded tools, or products with no SEO SSR requirement.
- Make Plan C the preferred React webapp answer for SEO/SSR + app workspace: TanStack Start + Vite + Cloudflare Workers, with React Router Framework Mode/Vike as fallback alternatives only if Start fails a gate.
- Update Plan E Cloudflare guidance so SSR React webapps deploy as Workers, not Pages, when using Start.
- Update Plan D monorepo guidance so `apps/web` is the single frontend deployment by default, while `apps/api`/`apps/agent`/`apps/mcp` remain independent backend/runtime Workers when needed.
- Preserve Plan A Astro-first for content-heavy sites where the app workspace is a separate explicit choice, but do not recommend Astro + Vite split as the default SaaS SEO answer.

At 10x project count, the first failure will be ambiguous scaffold output: agents may still generate Pages deployment commands or split marketing/web by habit. The mitigation is testable wording and negative tests that fail if Plan C Start output implies two frontend deploys or `wrangler pages deploy` for the Start app.

## File Changes

| File | Action | Description |
|---|---|---|
| `assets/plan-map.json` | Modify | Rename/refine Plan B/C/E/D stack tables so Plan C clearly owns TanStack Start + Workers for SEO/SSR webapps, while Plan B remains client-only Vite. |
| `assets/initializer-question-pack.v4.json` | Modify | Add or refine a webapp rendering/deployment decision such as `webapp_rendering_model`, with `client-only`, `start-workers`, `astro-content`, and `custom` choices. |
| `assets/initializer-question-pack.v4.schema.json` | Modify | Validate the new webapp rendering metadata. |
| `scripts/initializer-question-pack.ts` | Modify | Expose the new decision/default in the question summary. |
| `scripts/assemble-template.ts` | Modify | Emit Start/Workers template variables and conditions without changing default non-web plans. |
| `assets/project-structures/tanstack-start-workers.txt` | Add | Show a single `apps/web` Start app with `/` SSR route, `/app` client-only route, Worker config, env examples, and backend Worker boundaries. |
| `assets/project-structures/vite-tanstack.txt` | Modify | Make the client-only limitation explicit and point SEO/SSR needs to Plan C Start/Workers. |
| `assets/templates/tech-stack.template.md` | Modify | Add web rendering/deployment rows when the Start/Workers model is selected. |
| `assets/partials/04-project-structure.partial.md` | Modify | Include Start/Workers structure overlay when selected. |
| `assets/partials/06-cloudflare.partial.md` and `assets/partials-agents/07-cloudflare.partial.md` | Modify | Distinguish Worker SSR deploy from Pages static deploy; prefer `wrangler deploy` for Start. |
| `references/tech-stacks.md` | Modify | Document the single-frontend SSR SaaS recommendation and fallback hierarchy. |
| `SKILL.md` / `README.md` | Modify | Update public scaffold guidance without adding a new command or Plan code. |
| `docs/reference-configs/release-deploy.md` | Modify | Record release guidance: apex web Worker, `/app` client route, backend Workers separate, marketing Pages only legacy/rollback. |
| `tests/plan-map-consistency.test.ts` | Modify | Assert Plan B/C/E names and tables preserve the new semantics and A-K remains unchanged. |
| `tests/initializer-question-pack.test.ts` | Modify | Assert the webapp rendering decision exists and defaults safely. |
| `tests/output-parity.test.ts` | Modify | Assert Plan C Start output includes SSR/Workers guidance and default Plan B does not get unwanted Start text. |
| `tests/scaffold-parity.test.ts` | Modify | Assert the new project structure file exists and contains `/`, `/app`, `ssr: false`, and `wrangler.jsonc`. |
| `tests/unit/webapp-start-workers-scaffold.test.ts` | Add | Focused regression test for single frontend deploy, no default `apps/marketing` deploy, and route-level client-only workspace guidance. |

## Task Breakdown

- [x] Map current scaffold authorities and decide exact metadata shape for `webapp_rendering_model` or equivalent.
- [x] Update Plan B/C/D/E stack defaults and generated wording while preserving A-K plan codes and AI-native overlay behavior.
- [x] Add the TanStack Start + Workers project-structure surface and wire it into template assembly.
- [x] Update Cloudflare deploy guidance so Start uses Worker deploy and client-only Vite/marketing static surfaces remain separate opt-in cases.
- [x] Add regression tests for single frontend deploy, route-level `/app` client-only boundary, and absence of default two-frontend scaffold wording.
- [x] Run focused tests, full tests, required workflow checks, and self-migration dry-run.

## Verification

Focused verification:

```bash
bun test tests/plan-map-consistency.test.ts tests/initializer-question-pack.test.ts tests/output-parity.test.ts tests/scaffold-parity.test.ts tests/unit/webapp-start-workers-scaffold.test.ts
```

Full repo verification:

```bash
bun test
bash scripts/check-deploy-sql-order.sh
bash scripts/check-task-sync.sh
bash scripts/check-task-workflow.sh --strict
bun scripts/inspect-project-state.ts --repo . --format text
bash scripts/migrate-project-template.sh --repo . --dry-run
```

Manual acceptance:

- Plan B output still describes client-only Vite/TanStack Router and does not imply SSR SEO support.
- Plan C output recommends TanStack Start + Vite + Cloudflare Workers for React SEO/SSR webapps.
- Plan C generated structure has one frontend deployment under `apps/web`, not default `apps/marketing` plus `apps/web`.
- Generated Cloudflare guidance says Start deploys with `wrangler deploy`, not `wrangler pages deploy`.
- Generated route guidance says `/` is SSR/prerender-capable and `/app` is client-only with browser-only/WebGL components lazy-loaded.
- Backend workers remain separate runtime authorities only when they own API/Agent/MCP behavior.

## Rollback

- Revert the new plan-map/question-pack/template/test changes.
- Restore the previous Plan B/C/E wording if downstream scaffold snapshots depend on the old labels.
- Do not remove the existing AI-native overlay implementation during rollback.

## Next Action Command

Recommended public route: `repo-harness-scaffold`.

Reason: this changes how new repo/module scaffolds describe and generate Webapp stack boundaries. It is not an existing-repo migration, release deploy, or repair task until the generated behavior is approved and implemented.

## Annotations
<!-- [NOTE]: prefixed inline. Claude processes all and revises. -->

## Task Breakdown
- [ ] Map current scaffold authorities and decide exact metadata shape for `webapp_rendering_model` or equivalent.
- [ ] Update Plan B/C/D/E stack defaults and generated wording while preserving A-K plan codes and AI-native overlay behavior.
- [ ] Add the TanStack Start + Workers project-structure surface and wire it into template assembly.
- [ ] Update Cloudflare deploy guidance so Start uses Worker deploy and client-only Vite/marketing static surfaces remain separate opt-in cases.
- [ ] Add regression tests for single frontend deploy, route-level `/app` client-only boundary, and absence of default two-frontend scaffold wording.
- [ ] Run focused tests, full tests, required workflow checks, and self-migration dry-run.
