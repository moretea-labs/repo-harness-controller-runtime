# MCP tool exposure profiles

Controller MCP uses one stable default schema so ChatGPT can reliably read, edit, run checks, use Git, delegate to local Agents, operate Campaigns, capture iOS evidence, and recover from failures without a permission switch hiding tools.

## Profiles

| Toolset | CLI | Behavior |
| --- | --- | --- |
| **advanced** (default) | `--toolset advanced` | Stable repair-capable surface, capped at 128 tools. Includes the five `rh_*` facades plus high-value repository, Direct Edit, command, Git, Work/Job, Agent, Campaign, plugin, browser, iOS, artifact, and recovery tools. |
| **core** | `--toolset core` | Compatibility label for the same stable default schema. It does not reduce capability or require reconnecting. |
| **full** | `--toolset full` | Every historical legacy and runtime definition. Use only for old integrations or deep compatibility diagnosis because the much larger schema can reduce tool-selection quality. |

Configure via CLI flags, `REPO_HARNESS_MCP_TOOLSET`, or Controller Home MCP config. Empty/default controller configuration resolves to `advanced`.

## Single source of truth

`src/cli/mcp/toolset-names.ts` owns the dependency-free stable name list. `src/cli/mcp/toolset.ts` joins that list with the actual definition registry and returns one exposure snapshot containing:

- expected and actual tool names/counts;
- missing, unexpected, and duplicate names;
- schema fingerprint;
- readiness.

MCP `tools/list`, call validation, `/health`, `controller_ready`, `rh_status`, Connector freshness, and the Local Controller UI derive from this contract. Readiness cannot be `ready` while required tools are missing.

## Three-layer tool contract

The current implementation separates orchestration from capability without deleting product functions:

1. **Workflow facade:** `rh_status`, `rh_access`, `rh_inbox`, `rh_context`, and `rh_work` are the preferred ChatGPT control-plane entry points.
2. **Typed atomic tools:** repository inspection, Direct Edit, command, Git, Work/Job, Issue/Task, Campaign, plugin, browser, iOS, artifact, and recovery handlers remain public because their schemas preserve operation-specific validation and evidence.
3. **Internal handlers and capability registry:** capabilities are grouped as `controller`, `repository-core`, `git`, `issue-task`, `campaign`, `browser`, `ios`, `plugin`, `evidence`, and `runtime-maintenance`. `rh_status`, `rh_context`, and `controller_capabilities` expose this metadata.

The MCP transport currently publishes a static stable schema. It does **not** support loading a domain schema only after ChatGPT selects that domain. Therefore capability grouping improves selection and documentation, but it must not be described as dynamic tool loading. A future transport-level implementation may reduce the discovered schema while retaining the same internal handlers.

Capability metadata changes do not change `tools/list`; restart the Controller to load new code, but reconnect/rescan ChatGPT only when tool names or input schemas change.

## Permissions

Request/Full Access is an execution-policy decision below tool discovery. Switching access mode does not change the schema, does not require an MCP restart, and does not require reconnecting ChatGPT.

Remote writes, destructive actions, outside-repository paths, and secret access remain independently gated.

## Guidance

- Prefer `rh_status`, `rh_access`, `rh_context`, `rh_work`, and `rh_inbox` for normal orchestration.
- Use first-class Direct Edit, command, Git, `quick_agent_session`, Campaign, iOS, plugin, and artifact tools when the facade is not the shortest reliable path.
- Keep the stable surface unique and at or below 128 tools.
- Add new public tools only when they unlock a real end-to-end workflow; otherwise route capabilities through an existing facade or plugin action.

## Related checks

```bash
bun test tests/cli/mcp-tool-exposure-profiles.test.ts
bun test tests/cli/connector-freshness.test.ts
bun test tests/runtime/facade-mcp-surface.test.ts
bun run check:mcp-compatibility
```
