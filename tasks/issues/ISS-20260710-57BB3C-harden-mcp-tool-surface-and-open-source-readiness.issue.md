---
id: "ISS-20260710-57BB3C"
kind: "investigation"
status: "planned"
updated_at: "2026-07-10T05:33:37.706Z"
source: "repo-harness-controller-v8"
---

# Harden MCP tool surface and open-source readiness

Default tool-surface allowlist, facade integration validation, open-source configuration audit and release hardening.

## Goals

- Inspect and modify repo-harness-controller-runtime to complete release-preparation hardening. Implement a minimal default MCP tools/list surface centered on rh_status, rh_inbox, rh_context, and rh_work, plus only any strictly necessary minimal repository bootstrap/list entry. Preserve all old tool implementations behind explicit advanced/compatibility configuration and do not delete them. Add targeted tests proving default vs advanced/compatibility exposure and facade coverage for status/context/inbox/work lifecycle paths. Audit tracked files and configuration for personal bindings and open-source risks: /Users/greyson, fixed repo_id/checkout_id, Tailscale hostnames, personal GitHub mappings, OAuth/token/runtime files, _ops/controller-home and .ai/harness runtime data. Fix ignore rules, examples, defaults and docs where needed without exposing secrets. Run focused checks and an available release gate or equivalent. Commit all intended changes. If using an isolated worktree/branch, integrate to the main checkout and clean the worktree/branch before finishing. Avoid broad test expansion and do not touch generated dependencies/build outputs.

## Non-goals

- Do not make unrelated changes outside the declared Task scope.

## Acceptance Criteria

- [ ] Default MCP tools/list exposes only the four facade tools and any explicitly justified minimal repository entry
- [ ] Legacy tools remain available only in explicit advanced/compatibility mode
- [ ] Targeted tests cover exposure modes and facade lifecycle behavior
- [ ] No tracked personal secrets or runtime state; personal path/identifier bindings are removed from distributable defaults/examples/docs
- [ ] Focused checks and release-readiness audit are run and results documented
- [ ] Changes are committed and isolated branch/worktree is integrated and cleaned

## GitHub

- Not published.

## Tasks

### T1 — Harden MCP tool surface and open-source readiness

- Status: `cancelled`
- Objective: Inspect and modify repo-harness-controller-runtime to complete release-preparation hardening. Implement a minimal default MCP tools/list surface centered on rh_status, rh_inbox, rh_context, and rh_work, plus only any strictly necessary minimal repository bootstrap/list entry. Preserve all old tool implementations behind explicit advanced/compatibility configuration and do not delete them. Add targeted tests proving default vs advanced/compatibility exposure and facade coverage for status/context/inbox/work lifecycle paths. Audit tracked files and configuration for personal bindings and open-source risks: /Users/greyson, fixed repo_id/checkout_id, Tailscale hostnames, personal GitHub mappings, OAuth/token/runtime files, _ops/controller-home and .ai/harness runtime data. Fix ignore rules, examples, defaults and docs where needed without exposing secrets. Run focused checks and an available release gate or equivalent. Commit all intended changes. If using an isolated worktree/branch, integrate to the main checkout and clean the worktree/branch before finishing. Avoid broad test expansion and do not touch generated dependencies/build outputs.
- Depends on: none
- Allowed paths: `src/**`, `test/**`, `tests/**`, `docs/**`, `README.md`, `package.json`, `bun.lock`, `tsconfig*.json`, `.gitignore`, `.npmignore`, `.repo-harness/**`, `scripts/**`
- Checks: `test`, `lint`, `typecheck`
- Execution hint: agent / codex

### T2 — Implement minimal MCP facade surface and open-source release hardening

- Status: `cancelled`
- Objective: Continue the unimplemented scope after two zero-change cancelled runs. Implement a minimal default MCP tools/list surface centered on rh_status, rh_inbox, rh_context, and rh_work, plus only indispensable repository selection/bootstrap entries. Preserve all legacy implementations behind explicit advanced/compatibility profiles. Add focused exposure and facade lifecycle tests. Audit tracked distributable files for personal paths, fixed repo/checkout identifiers, Tailscale hosts, personal GitHub mappings, credentials/runtime files, _ops/controller-home and .ai/harness content; fix ignore/package exclusions, examples and concise docs without reading or printing secret contents. Run targeted checks and a bounded release-readiness audit, commit changes, do not push.
- Depends on: none
- Allowed paths: `src/cli/mcp/**`, `src/runtime/facade/**`, `src/runtime/gateway/**`, `tests/cli/**`, `tests/runtime/**`, `scripts/**`, `docs/**`, `README.md`, `package.json`, `.gitignore`, `.npmignore`, `.repo-harness/**`
- Checks: `package:check:type`, `package:check:controller-v8`
- Execution hint: agent / codex

### T3 — Implement precise MCP facade exposure and release audit

- Status: `blocked`
- Objective: Replace the zero-change auth-blocked broad-scope T2. Modify only the concrete MCP tool-definition/profile files, dedicated facade contract tests, release-surface audit scripts and public packaging/docs files. Default tools/list must expose rh_status, rh_inbox, rh_context, rh_work and only indispensable repository selection/bootstrap entries. Legacy tools remain callable only under explicit advanced/compatibility profiles. Add focused tests and a bounded tracked-file release audit without reading secret contents. Run typecheck and focused controller checks, commit in an isolated branch, do not push.
- Depends on: none
- Allowed paths: `src/cli/mcp/tools.ts`, `src/cli/mcp/legacy-tool-service.ts`, `src/cli/mcp/policy.ts`, `src/cli/mcp/types.ts`, `src/cli/mcp/facade-tool-service.ts`, `src/runtime/facade/**`, `tests/cli/mcp-tool-surface.test.ts`, `tests/cli/mcp-controller.test.ts`, `tests/runtime/facade-contracts.test.ts`, `scripts/check-release-surface.ts`, `scripts/check-release-surface.sh`, `scripts/public-export.ts`, `.gitignore`, `.npmignore`, `package.json`, `README.md`, `README.en.md`, `docs/open-source-release.md`, `docs/chatgpt-controller.md`
- Checks: `package:check:type`, `package:check:controller-v8`
- Execution hint: agent / codex

## Related Artifacts

- None.
