# Architecture Drift Request: 20260528-161911-assets-workflow-contract-v1-json-assets-workflow-contract-v1-json

> **Status**: Superseded
> **Detected**: 2026-05-28T16:19:11+0800
> **Severity**: high
> **Change Type**: workflow-surface
> **File**: `assets/workflow-contract.v1.json`
> **Functional Block**: `assets/workflow-contract.v1.json`
> **Capability ID**: `workflow-engine-contract-assets`
> **Matched Prefix**: `assets/workflow-contract.v1.json`
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
- When a visual explains the boundary better than prose, generate one standalone `$mermaid` architecture HTML file under `docs/architecture/diagrams/`.
- Treat `mermaid` as an external installed skill dependency at `~/.codex/skills/mermaid`; do not copy, vendor, or inline its templates into this repo.
- If this starts or advances durable execution, run `scripts/workstream-sync.sh ensure --block "assets/workflow-contract.v1.json" --request "docs/architecture/requests/20260528-161911-assets-workflow-contract-v1-json-assets-workflow-contract-v1-json.md"`.
- After the snapshot or diagram is produced, run `scripts/context-contract-sync.sh sync-latest` so the local architecture contract block links to the latest artifacts.

## Event Fields

```json
{
  "ts": "2026-05-28T16:19:11+0800",
  "file_path": "assets/workflow-contract.v1.json",
  "severity": "high",
  "functional_block": "assets/workflow-contract.v1.json",
  "capability_id": "workflow-engine-contract-assets",
  "matched_prefix": "assets/workflow-contract.v1.json",
  "architecture_domain": "workflow-engine",
  "architecture_capability": "contract-assets",
  "architecture_module": "docs/architecture/modules/workflow-engine/contract-assets.md",
  "workstream_dir": "tasks/workstreams/workflow-engine/contract-assets",
  "contract_agents": "AGENTS.md",
  "contract_claude": "CLAUDE.md",
  "change_type": "workflow-surface",
  "request_file": "docs/architecture/requests/20260528-161911-assets-workflow-contract-v1-json-assets-workflow-contract-v1-json.md",
  "spawn_recommended": true,
  "contract_sync_required": true
}
```

## Archive Resolution

- Status: Superseded
- Archived: 2026-06-12T03:29:02+0800
- Artifacts:
- `docs/architecture/requests/workflow-engine-contract-assets.md`
- Note: Merged into architecture queue card by triage --before 2026-06-01.
