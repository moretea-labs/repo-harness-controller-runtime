# Architecture Drift Request: 20260529-094323-assets-hooks-assets-hooks-prompt-guard-sh

> **Status**: Superseded
> **Detected**: 2026-05-29T09:43:23+0800
> **Severity**: high
> **Change Type**: workflow-surface
> **File**: `assets/hooks/prompt-guard.sh`
> **Functional Block**: `assets/hooks`
> **Capability ID**: `runtime-harness-hook-adapters`
> **Matched Prefix**: `assets/hooks`
> **Architecture Domain**: `runtime-harness`
> **Architecture Capability**: `hook-adapters`
> **Architecture Module**: `docs/architecture/modules/runtime-harness/hook-adapters.md`
> **Workstream Directory**: `tasks/workstreams/runtime-harness/hook-adapters`
> **Contract Files**: `AGENTS.md`, `CLAUDE.md`
> **Contract Sync Required**: true
> **Spawn Recommended**: true

## Required Follow-up

- Read root `AGENTS.md` / `CLAUDE.md`.
- If functional block is not `root`, read its local `AGENTS.md` / `CLAUDE.md`.
- Decide whether this change affects module boundaries, entrypoints, dependency rules, runtime paths, or verification commands.
- For substantial changes, write a snapshot under `docs/architecture/snapshots/`.
- When a visual explains the boundary better than prose, add or update a Mermaid fenced block in the relevant architecture module or snapshot Markdown first; that Markdown is the semantic source for LLM readers.
- When a human-readable rendering is useful, generate a matching `$mermaid` architecture HTML file under `docs/architecture/diagrams/` and link it back to the Markdown semantic source.
- Treat `mermaid` as an external installed skill dependency at `~/.codex/skills/mermaid`; do not copy, vendor, or inline its templates into this repo.
- If this starts or advances durable execution, run `scripts/workstream-sync.sh ensure --block "assets/hooks" --request "docs/architecture/requests/20260529-094323-assets-hooks-assets-hooks-prompt-guard-sh.md"`.
- After the snapshot or diagram is produced, run `scripts/context-contract-sync.sh sync-latest` so the local architecture contract block links to the latest artifacts.

## Event Fields

```json
{
  "ts": "2026-05-29T09:43:23+0800",
  "file_path": "assets/hooks/prompt-guard.sh",
  "severity": "high",
  "functional_block": "assets/hooks",
  "capability_id": "runtime-harness-hook-adapters",
  "matched_prefix": "assets/hooks",
  "architecture_domain": "runtime-harness",
  "architecture_capability": "hook-adapters",
  "architecture_module": "docs/architecture/modules/runtime-harness/hook-adapters.md",
  "workstream_dir": "tasks/workstreams/runtime-harness/hook-adapters",
  "contract_agents": "AGENTS.md",
  "contract_claude": "CLAUDE.md",
  "change_type": "workflow-surface",
  "request_file": "docs/architecture/requests/20260529-094323-assets-hooks-assets-hooks-prompt-guard-sh.md",
  "spawn_recommended": true,
  "contract_sync_required": true
}
```

## Archive Resolution

- Status: Superseded
- Archived: 2026-06-12T03:29:06+0800
- Artifacts:
- `docs/architecture/requests/runtime-harness-hook-adapters.md`
- Note: Merged into architecture queue card by triage --before 2026-06-01.
