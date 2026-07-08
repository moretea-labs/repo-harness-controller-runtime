# repo-harness V5 Verification Record

Date: 2026-06-21

## Release baseline

- Source baseline: repo-harness V4 (`1.0.0`, `controller-progress-ledger-v4`)
- V5 package version: `1.1.0`
- Controller fingerprint: `controller-execution-closure-v5`
- Default ChatGPT Connector name: `repo-harness-controller-v5`
- Controller schema: `7`

## Verified V5 capabilities

- One explicit current execution Issue drives the ready queue.
- Default `focus_only` Issue-creation policy blocks uncontrolled Issue proliferation and exact duplicate active titles.
- Project governance detects multiple active Issues, terminal focus, dead cancelled dependencies, stale superseded dependencies, retryable failed attempts, pending review/acceptance, unclosed work, and unarchived history.
- Safe reconciliation rewires declared superseded replacements, restores Tasks blocked only by failed attempts, closes completed Issues, clears terminal focus, and selects a sole active Issue.
- Failed, unknown, or cancelled Runs remain immutable attempt history while the durable Task returns to a retryable state unless a real blocker exists.
- Project, Issue, and Task progress is derived from five evidence gates rather than lifecycle-label estimates.
- Named checks execute from safe repository configuration and persist their real output under `.ai/harness/checks/controller/`.
- Verification requires a succeeded implementation Run, integrated isolated work, actual named-check results, and explicit acceptance-criterion evidence.
- The local Controller exposes direct launch, retry, verify, accept, request-changes, cancel, dependency repair, reconciliation, focus, archive, and restore actions.
- Current work and archived history are separated while retaining Issue, Task, Run, verification, GitHub, and worklog evidence.
- Project-wide dispatch is scoped to an explicit/current Issue instead of walking every historical Issue.
- V3 and V4 default Connector names are recognized during V5 Connector migration.

## Type verification

```bash
npm run check:type
```

Result:

```text
tsc --noEmit: passed
```

## Controller and MCP regression

```bash
bun test --timeout 30000 \
  tests/cli/controller-execution-v5.test.ts \
  tests/cli/controller-progress-v4.test.ts \
  tests/cli/local-bridge.test.ts \
  tests/cli/mcp-controller.test.ts \
  tests/cli/mcp-setup.test.ts
```

Result:

```text
43 pass
0 fail
331 expect() calls
```

This suite exercises the current-Issue policy, readiness truth, governance reconciliation, evidence-gate progress, archive separation, direct local Controller actions, persisted check evidence, MCP execution/verification/acceptance, worktree integration, Connector migration, and optional GitHub surfaces.

## Bootstrap and workflow-contract regression

```bash
bun test --timeout 30000 \
  tests/bootstrap-files.test.ts \
  tests/workflow-contract.test.ts
```

Result:

```text
25 pass
0 fail
575 expect() calls
```

## README and release-surface regression

```bash
bun test --timeout 40000 tests/readme-dx.test.ts
```

Result:

```text
8 pass
0 fail
142 expect() calls
```

## Bundle verification

```bash
bun build \
  src/cli/index.ts \
  src/cli/mcp/server.ts \
  src/cli/local-bridge/server.ts \
  src/cli/controller/progress.ts \
  src/cli/controller/governance.ts \
  src/cli/controller/project-state.ts \
  src/cli/controller/check-runner.ts \
  --outdir /tmp/repo-harness-v5-build \
  --target bun \
  --external commander
```

Result:

```text
468 modules bundled successfully
```

## Runtime smoke verification

A temporary repository was used to exercise the real V5 state path:

```text
create Issue
-> automatic current focus
-> duplicate/proliferation guard
-> readiness-approved queue
-> succeeded implementation Run
-> persisted named-check evidence
-> Verification Gate
-> explicit acceptance
-> 5/5 evidence gates
-> governance focus closeout
-> archive separation
```

Result:

```text
ok: true
readinessScore: 100 with one dispatchable Task
gates: 5/5 evidence gates complete
archiveCount: 1
governance health after archive: healthy
```

The generated dashboard HTML was also parsed as JavaScript after Bun transpilation, and its static Chinese UI text remained readable while token `<` escaping remained intact.

## Broad-suite limitation

A broad `bun test` run reached pre-existing process-heavy `architecture-queue` and `capability-config` integration tests. Individual assertions reported pass when given a longer timeout, but the packaging container's Bun runner retained child processes and did not complete the whole test command cleanly. Those scripts are outside the V5 Controller execution-and-closure change set.

The release claim is therefore limited to the passing type check, focused Controller/MCP suites, bootstrap/workflow-contract suites, README/release-surface suite, bundle verification, and runtime smoke recorded above. No claim is made that every pre-existing repository test completed in this container.
