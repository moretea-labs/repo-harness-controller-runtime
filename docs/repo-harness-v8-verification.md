# repo-harness V8 Verification Record

## Scope

This record covers the V8 changes introduced on top of the user-provided V7 full replacement package dated 2026-06-22.

## Implemented contracts

### Direct Edit

- multi-call `apply_patch` within one session;
- numbered revisions and per-revision patches;
- aggregate localized unified diff;
- SHA-256 stale-write protection;
- `insert_before`, `insert_after`, `prepend`, and `append` operations;
- named savepoints;
- rollback to revision or savepoint;
- failed checks leave the session open for correction;
- finalization no longer represents a human approval step;
- compatibility normalization for V7 edit-session states.

### Execution policy

- ordinary local high-risk Tasks are executable without `approve_risk`;
- local confirmation queue removed for new work;
- destructive authorization is supplied in the same request;
- Task Agent binding removed;
- dispatch-time Agent override added to single-Task and batch launch paths.

### Controller UI

- four top-level destinations: Overview, Work, Activity, Settings;
- Issue -> Task nesting;
- runtime Agent selector per Task;
- Direct Edit revision/savepoint/diff view;
- no approval-queue navigation;
- corrected current-Issue focus endpoint.

### Compatibility and tests

- V7 assertions updated to V8 state names and no-risk-approval semantics;
- added `tests/cli/controller-chatgpt-bridge-v8.test.ts` for:
  - executor-neutral Tasks;
  - high-risk local readiness without approval;
  - multiple edit revisions;
  - savepoint and partial rollback;
  - localized aggregate diff;
  - runtime Agent selection capability;
  - hierarchical Controller UI capability.

## Verification performed in the packaging environment

### Passed

- Safe ZIP extraction and package inventory.
- TypeScript syntax transpilation for all modified source and test files using TypeScript `transpileModule`.
- Targeted source scans for obsolete public `approve_risk` schema fields.
- Targeted source scans for V7 Direct Edit state assertions.
- Dashboard-to-server endpoint cross-check for Issue focus, governance reconciliation, Task launch, snapshot, stream, and edit savepoints.
- Package manifest generation and ZIP integrity check.

### Not executable in this environment

The sandbox does not provide Bun and the uploaded package does not include `node_modules`. Therefore `bun test` and the normal Bun runtime integration suite could not be executed here. This limitation is environmental and is not reported as a passing test.

Run these commands after extraction on the target Mac:

```bash
bun install
bun test tests/cli/controller-chatgpt-bridge-v8.test.ts
bun test tests/cli/controller-execution-first-v7.test.ts
bun test tests/cli/mcp-execution-first-v7.test.ts
bun test tests/cli/mcp-controller.test.ts
bun test tests/cli/local-bridge.test.ts
bun run check:type
bun test
```

## Expected connector refresh

After installing V8, restart MCP and rescan the ChatGPT Connector because the public tool schema and fingerprint changed:

```bash
repo-harness mcp setup chatgpt --repo .
repo-harness mcp keepalive --repo . --profile controller \
  --enable-dev-runner --dev-runner-agents codex,claude --tunnel quick
repo-harness mcp doctor --repo .
```

`controller_capabilities` should report:

```text
toolSurface: controller-chatgpt-bridge-v8
schemaVersion: 10
toolSurfaceVersion: 8
```
