# repo-harness V6 Direct Change First

V6 changes the default Controller behavior for known, bounded work. A small documentation, configuration, or code change should produce an actual repository patch, check evidence, and a final result without first creating an Issue.

Local files remain authoritative. GitHub remains an optional collaboration plugin.

## Work-mode decision

Before creating durable work, use `assess_work_request` or the equivalent CLI command:

```bash
repo-harness controller assess \
  --description "Update the installation note" \
  --path README.md \
  --expected-files 1 \
  --expected-lines 10
```

The assessment returns one of three modes:

| Mode | Use when | Issue required |
| --- | --- | --- |
| `direct_edit` | Exact files are known and the change is bounded | No |
| `quick_agent` | The work is bounded but exact edits still need one scoped agent pass | The caller does not create one; the current Local Job implementation creates a scoped investigation Issue/Task for the Run |
| `issue_task` | Investigation, dependencies, parallelism, high risk, protected paths, or broad changes are required | Yes |

Current routing thresholds are intentionally conservative:

- direct edit: known paths, at most five files, at most 500 estimated changed lines;
- Issue/Task: high risk, investigation, parallelism, long-running checks, dependency graph, more than eight files, more than 1,200 changed lines, or protected/release-sensitive paths;
- otherwise: one bounded quick-agent session.

The assessment is guidance, not permission escalation. Repository policy and immutable deny rules still apply.

## Direct-edit transaction

The normal direct path is:

```text
read_repository_file
  -> begin_edit_session
  -> apply_patch
  -> get_edit_session_diff
  -> verify_edit_session
  -> finalize_edit_session
```

Failure or rejection before finalization can use:

```text
rollback_edit_session
```

`issue_id` and `task_id` are optional links. They should be supplied only when the patch belongs to an existing complex execution line.

### 1. Read with a stale-write guard

`read_repository_file` returns:

- the requested line range;
- the full-file SHA-256;
- total line count and range metadata;
- redaction metadata.

The SHA-256 is calculated over the complete UTF-8 file, even when only a line range is returned. `write`, `replace`, and `delete` operations must provide this hash as `expected_sha256`.

### 2. Open a bounded session

`begin_edit_session` records:

- purpose;
- optional Issue/Task links;
- allowed path patterns;
- maximum files;
- maximum changed lines;
- requested named checks;
- base Git revision when available.

Session state is stored under:

```text
.ai/harness/edit-sessions/<EDIT-ID>/session.json
```

### 3. Apply atomic operations

`apply_patch` supports:

- `create`;
- full-content `write`;
- exact-text `replace`;
- `delete`.

The engine rejects:

- stale hashes;
- paths outside the session scope;
- duplicate paths in one application;
- no-op edits;
- file-count or changed-line limit violations;
- policy-denied paths.

Applied files receive rollback backups. A failure during the transaction restores already-applied operations.

### 4. Persist the real patch

After application, the Controller writes a unified patch to:

```text
.ai/harness/edit-sessions/<EDIT-ID>/changes.patch
```

The session records the patch SHA-256, file-level before/after hashes, operation type, and changed-line estimate. `get_edit_session_diff` and the local **文件变更 / File Changes** view read this persisted artifact; they do not infer success from an Issue status.

### 5. Verify actual checks

`verify_edit_session` executes named checks from the safe Controller check registry. Results include:

- check ID;
- real command result;
- pass/fail state;
- execution timestamp;
- retained artifact path when available;
- reviewer and note.

A session with no named checks still requires an explicit reviewer record. Verification also confirms that applied files still match their recorded after-hashes.

### 6. Finalize or roll back

Only a `verified` session can be finalized. Finalization records the reviewer, final note, files, patch hash, checks, and timestamps in the unified worklog.

Rollback is allowed only before finalization and only when files still match the applied hashes. This prevents a rollback from overwriting later unrelated work.

## Status model

```text
open
  -> applied
  -> verified
  -> finalized
```

Alternative paths:

```text
applied -> verification_failed -> verified
applied | verified | verification_failed -> rolled_back
```

## Controller surface

V6 promotes direct changes to a primary Controller area:

- recent edit sessions;
- open/applied/verified/finalized/rolled-back state;
- changed files and line estimates;
- requested and completed checks;
- persisted unified patch;
- verify, finalize, and rollback actions;
- linked worklog events.

Issue/Task execution remains available for complex work, but it is no longer the only visible unit of delivery.

## MCP V6 surface

The V6 fingerprint is:

```text
controller-direct-change-v6
```

New or expanded direct-change tools include:

```text
assess_work_request
read_repository_file
begin_edit_session
apply_patch
list_edit_sessions
get_edit_session
get_edit_session_diff
verify_edit_session
finalize_edit_session
rollback_edit_session
```

The default ChatGPT Connector name is:

```text
repo-harness-controller-v6
```

Recreate or rescan the Connector after upgrading if `controller_capabilities` reports an older fingerprint.

## Completion rule

For a direct change, these are not completion:

- an Issue was created;
- an edit session was opened;
- a patch was proposed but not applied;
- files changed but no patch/check evidence was recorded.

A completed direct change must report:

- changed files;
- persisted patch and hash;
- checks and reviewer evidence;
- final session status;
- rollback availability or finalization.

For complex work, V5's Issue/Task/Run/Verification/Acceptance closure remains mandatory.
