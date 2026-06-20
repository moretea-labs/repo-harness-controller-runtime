# Architecture Drift Request: 20260529-020654-ai-harness-policy-json-ai-harness-policy-json

> **Status**: Resolved
> **Detected**: 2026-05-29T02:06:54+0800
> **Severity**: high
> **Change Type**: workflow-surface
> **File**: `.ai/harness/policy.json`
> **Functional Block**: `.ai/harness/policy.json`
> **Capability ID**: `workflow-engine-contract-assets`
> **Matched Prefix**: `.ai/harness/policy.json`
> **Architecture Domain**: `workflow-engine`
> **Architecture Capability**: `contract-assets`
> **Architecture Module**: `docs/architecture/modules/workflow-engine/contract-assets.md`
> **Workstream Directory**: `tasks/workstreams/workflow-engine/contract-assets`
> **Contract Files**: `AGENTS.md`, `CLAUDE.md`
> **Contract Sync Required**: true
> **Spawn Recommended**: true

## Required Follow-up

- Read root `AGENTS.md` / `CLAUDE.md`.
- If functional block is not `root`, read its local `AGENTS.md` / `CLAUDE.md`.
- Decide whether this change affects module boundaries, entrypoints, dependency rules, runtime paths, or verification commands.
- For substantial changes, write a snapshot under `docs/architecture/snapshots/`.
- When a visual explains the boundary better than prose, add or update a Mermaid fenced block in the relevant architecture module or snapshot Markdown first; that Markdown is the semantic source for LLM readers.
- When a human-readable rendering is useful, generate a matching `$diagram-design` architecture HTML file under `docs/architecture/diagrams/` and link it back to the Markdown semantic source.
- Treat `diagram-design` as an external installed skill dependency at `~/.codex/skills/diagram-design`; do not copy, vendor, or inline its templates into this repo.
- If this starts or advances durable execution, run `scripts/workstream-sync.sh ensure --block ".ai/harness/policy.json" --request "docs/architecture/requests/20260529-020654-ai-harness-policy-json-ai-harness-policy-json.md"`.
- After the snapshot or diagram is produced, run `scripts/context-contract-sync.sh sync-latest` so the local architecture contract block links to the latest artifacts.

## Event Fields

```json
{
  "ts": "2026-05-29T02:06:54+0800",
  "file_path": ".ai/harness/policy.json",
  "severity": "high",
  "functional_block": ".ai/harness/policy.json",
  "capability_id": "workflow-engine-contract-assets",
  "matched_prefix": ".ai/harness/policy.json",
  "architecture_domain": "workflow-engine",
  "architecture_capability": "contract-assets",
  "architecture_module": "docs/architecture/modules/workflow-engine/contract-assets.md",
  "workstream_dir": "tasks/workstreams/workflow-engine/contract-assets",
  "contract_agents": "AGENTS.md",
  "contract_claude": "CLAUDE.md",
  "change_type": "workflow-surface",
  "request_file": "docs/architecture/requests/20260529-020654-ai-harness-policy-json-ai-harness-policy-json.md",
  "spawn_recommended": true,
  "contract_sync_required": true
}
```

## Archive Resolution

- Status: Resolved
- Archived: 2026-05-29T02:16:45+0800
- Artifacts:
- `docs/architecture/modules/workflow-engine/contract-assets.md`
- `tasks/workstreams/workflow-engine/contract-assets/cleanup-script-policy.md`
- `assets/AGENTS.md`
- `assets/CLAUDE.md`
- Note: cleanup_script stays within workflow-engine contract assets; file-prefix workstream sync is now supported.
