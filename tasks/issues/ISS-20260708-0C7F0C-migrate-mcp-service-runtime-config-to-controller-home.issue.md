---
id: "ISS-20260708-0C7F0C"
kind: "governance"
status: "done"
updated_at: "2026-07-08T03:16:13.321Z"
archived_at: "2026-07-08T03:16:13.321Z"
source: "repo-harness-controller-v8"
---

# Migrate MCP service runtime config to controller home

MCP HTTP service-level config, auth tokens, OAuth token store, runtime state, restart/keepalive setup, and public-origin resolution still rely on repo-local .repo-harness/mcp.* files. This blocks fully repository-decoupled controller startup because service identity and selected repository identity remain partially coupled.

## Goals

- Introduce controllerHome-backed MCP service config/runtime paths while preserving repo-local legacy fallback.
- Migrate HTTP transport auth/public-origin/runtime-state reads to controllerHome first, then repo-local fallback for compatibility.
- Update setup/restart/keepalive flows to write service-level config to controllerHome for controller profile.
- Keep repository-scoped tool execution and repo-local runtime storage unchanged.
- Document fallback and migration behavior in current architecture notes.

## Non-goals

- Remove repo-local legacy config without migration.
- Change repository tool behavior or execution storage semantics.
- Rewrite the MCP protocol transport stack.
- Expand test scope beyond targeted type check and affected MCP config tests.

## Acceptance Criteria

- [ ] Controller profile MCP can start from outside any registered repository using controllerHome-backed config/token/runtime state.
- [ ] Existing repo-local .repo-harness/mcp.* config continues to work as fallback and does not break current users.
- [ ] HTTP /health and ChatGPT public origin no longer depend on an arbitrary startup repoRoot when controllerHome is available.
- [ ] setup/restart/keepalive consistently read/write the same service-level config location in controller profile.
- [ ] package:check:type passes; targeted MCP setup/auth/transport tests are updated or added only where necessary.

## GitHub

- Not published.

## Tasks

### T1 — Add controllerHome-backed MCP config paths

- Status: `done`
- Objective: Add non-breaking helper functions for controllerHome MCP config/token/oauth/runtime paths and fallback readers that check controllerHome first, then legacy repo-local paths.
- Depends on: none
- Allowed paths: `src/cli/mcp/auth.ts`, `src/cli/repositories/controller-home.ts`, `tests/**/*.test.ts`
- Checks: `package:check:type`
- Execution hint: selected at runtime

### T2 — Migrate HTTP transport service config reads

- Status: `done`
- Objective: After controllerHome-backed helper functions exist, update src/cli/mcp/transports/http.ts to use controllerHome-backed auth/public-origin/runtime-state paths in controller profile while keeping legacy repoRoot fallback.
- Depends on: none
- Allowed paths: `src/cli/mcp/transports/http.ts`, `tests/**/*.test.ts`
- Checks: `package:check:type`
- Execution hint: selected at runtime

### T3 — Update setup restart keepalive config flow

- Status: `done`
- Objective: After controllerHome-backed helper functions exist, update MCP setup, restart, and keepalive code to read/write service-level config from controllerHome in controller profile and document migration/fallback behavior.
- Depends on: none
- Allowed paths: `src/cli/mcp/setup.ts`, `src/cli/mcp/restart.ts`, `src/cli/mcp/keepalive.ts`, `docs/architecture/current/controller-repository-decoupling.md`, `tests/**/*.test.ts`
- Checks: `package:check:type`
- Execution hint: selected at runtime

## Related Artifacts

- None.
