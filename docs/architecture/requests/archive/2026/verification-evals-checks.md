# Architecture Queue Card: verification-evals-checks

> **Status**: Resolved
> **Detected**: 2026-05-28T16:18:53+0800
> **Updated**: 2026-05-28T16:18:53+0800
> **Severity**: high
> **Change Type**: workflow-surface
> **File**: `scripts/check-task-workflow.sh`
> **Functional Block**: `scripts/check-task-workflow.sh`
> **Capability ID**: `verification-evals-checks`
> **Matched Prefix**: `scripts/check-task-workflow.sh`
> **Architecture Domain**: `verification`
> **Architecture Capability**: `evals-checks`
> **Architecture Module**: `docs/architecture/modules/verification/evals-checks.md`
> **Workstream Directory**: `tasks/workstreams/verification/evals-checks`
> **Contract Files**: `AGENTS.md`, `CLAUDE.md`
> **Contract Sync Required**: true
> **Spawn Recommended**: true
> **Open Edits**: 1

## Required Follow-up

- Read root `AGENTS.md` / `CLAUDE.md`.
- If functional block is not `root`, read its local `AGENTS.md` / `CLAUDE.md`.
- Decide whether this change affects module boundaries, entrypoints, dependency rules, runtime paths, or verification commands.
- For substantial changes, write a snapshot under `docs/architecture/snapshots/`.
- When a visual explains the boundary better than prose, add or update a Mermaid fenced block in the relevant architecture module or snapshot Markdown first; that Markdown is the semantic source for LLM readers.
- When a human-readable rendering is useful, generate a matching `$mermaid` architecture HTML file under `docs/architecture/diagrams/` and link it back to the Markdown semantic source.
- Treat `mermaid` as an external installed skill dependency at `~/.codex/skills/mermaid`; do not copy, vendor, or inline its templates into this repo.
- If this starts or advances durable execution, run `scripts/workstream-sync.sh ensure --block "scripts/check-task-workflow.sh" --request "docs/architecture/requests/verification-evals-checks.md"`.
- After the snapshot or diagram is produced, run `scripts/context-contract-sync.sh sync-latest` so the local architecture contract block links to the latest artifacts.

## Touched Files

| Last Event | Severity | Change Type | File |
| --- | --- | --- | --- |
| 2026-05-28T16:18:53+0800 | high | workflow-surface | `scripts/check-task-workflow.sh` |

## Event Fields

```json
{
  "ts": "2026-05-28T16:18:53+0800",
  "file_path": "scripts/check-task-workflow.sh",
  "severity": "high",
  "functional_block": "scripts/check-task-workflow.sh",
  "capability_id": "verification-evals-checks",
  "matched_prefix": "scripts/check-task-workflow.sh",
  "architecture_domain": "verification",
  "architecture_capability": "evals-checks",
  "architecture_module": "docs/architecture/modules/verification/evals-checks.md",
  "workstream_dir": "tasks/workstreams/verification/evals-checks",
  "contract_agents": "AGENTS.md",
  "contract_claude": "CLAUDE.md",
  "change_type": "workflow-surface",
  "request_file": "docs/architecture/requests/verification-evals-checks.md",
  "spawn_recommended": true,
  "contract_sync_required": true
}
```

## Archive Resolution

- Status: Resolved
- Archived: 2026-06-12T03:36:04+0800
- Artifacts:
- `docs/architecture/modules/verification/evals-checks.md`
- Note: Required-file checks and focused tests now track architecture-queue.sh.
