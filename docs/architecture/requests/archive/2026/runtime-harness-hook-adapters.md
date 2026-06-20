# Architecture Queue Card: runtime-harness-hook-adapters

> **Status**: Resolved
> **Detected**: 2026-05-28T15:47:40+0800
> **Updated**: 2026-05-29T09:44:46+0800
> **Severity**: high
> **Change Type**: workflow-surface
> **File**: `.ai/hooks/session-start-context.sh`
> **Functional Block**: `.ai/hooks`
> **Capability ID**: `runtime-harness-hook-adapters`
> **Matched Prefix**: `.ai/hooks`
> **Architecture Domain**: `runtime-harness`
> **Architecture Capability**: `hook-adapters`
> **Architecture Module**: `docs/architecture/modules/runtime-harness/hook-adapters.md`
> **Workstream Directory**: `tasks/workstreams/runtime-harness/hook-adapters`
> **Contract Files**: `AGENTS.md`, `CLAUDE.md`
> **Contract Sync Required**: true
> **Spawn Recommended**: true
> **Open Edits**: 9

## Required Follow-up

- Read root `AGENTS.md` / `CLAUDE.md`.
- If functional block is not `root`, read its local `AGENTS.md` / `CLAUDE.md`.
- Decide whether this change affects module boundaries, entrypoints, dependency rules, runtime paths, or verification commands.
- For substantial changes, write a snapshot under `docs/architecture/snapshots/`.
- When a visual explains the boundary better than prose, add or update a Mermaid fenced block in the relevant architecture module or snapshot Markdown first; that Markdown is the semantic source for LLM readers.
- When a human-readable rendering is useful, generate a matching `$mermaid` architecture HTML file under `docs/architecture/diagrams/` and link it back to the Markdown semantic source.
- Treat `mermaid` as an external installed skill dependency at `~/.codex/skills/mermaid`; do not copy, vendor, or inline its templates into this repo.
- If this starts or advances durable execution, run `scripts/workstream-sync.sh ensure --block ".ai/hooks" --request "docs/architecture/requests/runtime-harness-hook-adapters.md"`.
- After the snapshot or diagram is produced, run `scripts/context-contract-sync.sh sync-latest` so the local architecture contract block links to the latest artifacts.

## Touched Files

| Last Event | Severity | Change Type | File |
| --- | --- | --- | --- |
| 2026-05-29T09:44:46+0800 | high | workflow-surface | `.ai/hooks/session-start-context.sh` |
| 2026-05-29T09:44:30+0800 | high | workflow-surface | `assets/hooks/session-start-context.sh` |
| 2026-05-29T09:43:39+0800 | high | workflow-surface | `assets/hooks/prompt-guard.sh` |
| 2026-05-29T09:43:31+0800 | high | workflow-surface | `.ai/hooks/prompt-guard.sh` |
| 2026-05-29T00:42:38+0800 | high | workflow-surface | `.ai/hooks/lib/workflow-state.sh` |
| 2026-05-28T22:47:36+0800 | high | workflow-surface | `.ai/hooks/hook-input.sh` |
| 2026-05-28T22:27:05+0800 | high | workflow-surface | `.ai/hooks/worktree-guard.sh` |
| 2026-05-28T22:26:48+0800 | high | workflow-surface | `.ai/hooks/pre-edit-guard.sh` |
| 2026-05-28T15:48:16+0800 | high | workflow-surface | `assets/hooks/hook-input.sh` |

## Event Fields

```json
{
  "ts": "2026-05-29T09:44:46+0800",
  "file_path": ".ai/hooks/session-start-context.sh",
  "severity": "high",
  "functional_block": ".ai/hooks",
  "capability_id": "runtime-harness-hook-adapters",
  "matched_prefix": ".ai/hooks",
  "architecture_domain": "runtime-harness",
  "architecture_capability": "hook-adapters",
  "architecture_module": "docs/architecture/modules/runtime-harness/hook-adapters.md",
  "workstream_dir": "tasks/workstreams/runtime-harness/hook-adapters",
  "contract_agents": "AGENTS.md",
  "contract_claude": "CLAUDE.md",
  "change_type": "workflow-surface",
  "request_file": "docs/architecture/requests/runtime-harness-hook-adapters.md",
  "spawn_recommended": true,
  "contract_sync_required": true
}
```

## Archive Resolution

- Status: Resolved
- Archived: 2026-06-12T03:36:04+0800
- Artifacts:
- `docs/architecture/modules/runtime-harness/hook-adapters.md`
- Note: Post-edit hook architecture recording now routes through architecture-queue.sh with advisory semantics.
