# repo-harness V6 Verification Record

Date: 2026-06-21

## Release baseline

- Source baseline: repo-harness V5 (`1.1.0`, `controller-execution-closure-v5`)
- V6 package version: `1.2.0`
- Controller fingerprint: `controller-direct-change-v6`
- Default ChatGPT Connector name: `repo-harness-controller-v6`
- Controller schema: `8`

## Verified V6 capabilities

- Known bounded documentation, configuration, and code requests can complete through direct edit sessions without creating an Issue or Task.
- `assess_work_request` returns `direct_edit`, `quick_agent`, or `issue_task` using explicit scope, risk, investigation, parallelism, check, dependency, and protected-path signals.
- `read_repository_file` returns the full-file SHA-256 even for a ranged read.
- Direct edit sessions enforce allowed paths, file-count limits, changed-line limits, unique paths, exact stale-write hashes, and no-op rejection.
- Create, full write, exact replace, and delete operations are applied atomically with rollback backups.
- Every applied session persists a unified patch plus patch SHA-256 and before/after file hashes.
- Named checks execute through the safe Controller check registry and persist real result evidence.
- An edit session must be verified before finalization; failed verification may be rerun or the session may be rolled back.
- Rollback refuses to overwrite files that changed after the edit session applied them.
- Edit-session start, application, verification, finalization, failure, and rollback enter the unified worklog.
- The localhost Controller exposes File Changes as a first-class view with files, patch, checks, verify, finalize, and rollback actions.
- Existing V5 current-focus, governance, retry, five-gate Task evidence, acceptance, closure, and archive behavior remains available for complex work.
- V3, V4, and V5 Connector identities are recognized as legacy defaults during V6 Connector migration.

## Type verification

```bash
npx tsc --noEmit
```

Result:

```text
passed
```

## Controller, MCP, setup, and complex-work regression

```bash
npx bun test --timeout 40000 \
  tests/cli/mcp-controller.test.ts \
  tests/cli/mcp-setup.test.ts \
  tests/cli/controller-execution-v5.test.ts \
  tests/cli/controller-progress-v4.test.ts
```

Result:

```text
37 pass
0 fail
294 expect() calls
```

This suite includes the direct-edit request assessment, SHA-guarded application, persisted patch inspection, real named-check verification, finalization evidence, rollback, MCP tool discovery, Connector migration, local and worktree Agent Runs, Verification Gate, optional GitHub surfaces, V5 governance, and V4 progress/worklog compatibility.

## Local Controller, bootstrap, workflow-contract, and README regression

```bash
npx bun test --timeout 40000 \
  tests/cli/local-bridge.test.ts \
  tests/bootstrap-files.test.ts \
  tests/workflow-contract.test.ts \
  tests/readme-dx.test.ts
```

Result:

```text
41 pass
0 fail
775 expect() calls
```

This suite exercises the File Changes UI/API, edit patch/check/finalization path, token-protected localhost surface, workspace/worktree execution, generated workflow-contract parity, installation surfaces, localized release strings, and documentation contracts.

## Focused regression total

```text
78 pass
0 fail
1069 expect() calls
```

## CLI routing smoke

```bash
npx bun src/cli/index.ts controller assess \
  "Update README installation note" \
  --path README.md \
  --expected-files 1 \
  --expected-lines 10 \
  --json
```

Result:

```text
recommendedMode: direct_edit
issueRequired: false
```

## Bundle verification

```bash
npx bun build \
  src/cli/index.ts \
  src/cli/mcp/server.ts \
  src/cli/local-bridge/server.ts \
  src/cli/controller/progress.ts \
  src/cli/controller/governance.ts \
  src/cli/controller/project-state.ts \
  src/cli/controller/check-runner.ts \
  src/cli/controller/work-mode.ts \
  src/cli/editing/edit-session.ts \
  --outdir /tmp/repo-harness-v6-build \
  --target bun \
  --external commander
```

Result:

```text
469 modules bundled successfully
```

## Direct-edit completion path exercised

A temporary repository was used by the MCP and Local Controller tests to exercise:

```text
assess bounded request
-> ranged repository read with full SHA-256
-> open edit session without Issue/Task
-> exact replacement with SHA precondition
-> persist unified patch
-> inspect patch through MCP and localhost API
-> run a named check
-> record reviewer evidence
-> finalize
-> read final session from File Changes history
```

A separate test exercises apply followed by rollback and confirms the original file content is restored.

## Scope limitation

The release claim is limited to the passing type check, focused Controller/MCP/setup suites, local Controller/bootstrap/workflow/documentation suites, CLI smoke, and bundle verification recorded above. A new claim that every pre-existing process-heavy integration test completed in this packaging container is not made.

## npm tarball verification

```bash
npm pack --ignore-scripts --json --pack-destination /mnt/data
```

The generated archive was inspected for the V6 direct-change documentation, verification record, manifest, edit-session engine, and work-mode classifier. `node_modules` and `package-lock.json` are not present in the package archive.

The packed source was extracted and executed with the verified local dependency set:

```text
repo-harness --version: 1.2.0
```
