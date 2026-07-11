# Repository access modes

repo-harness keeps two user-selectable execution policies:

- `full_access` — the default for a personal local controller. Normal work inside the selected repository can read, edit, run bounded local commands and checks, and perform local Git operations without repeated approval prompts.
- `request` — keeps the same MCP tool schema, but asks before elevated local side effects.

Access mode controls **execution approval only**. It never changes `tools/list`, never hides Direct Edit, Git, Agent, iOS, browser, plugin, or recovery tools, and never requires an MCP restart or ChatGPT reconnect.

## Hard safety boundary

Neither mode bypasses the controller's hard boundaries. These remain separately authorized or denied:

- paths outside the selected repository;
- external network effects;
- Git push and other remote writes;
- deployments, publishing, destructive cleanup, and irreversible operations;
- raw secrets, tokens, private keys, and credentials;
- controller policy bypass.

`full_access` is therefore repository-local autonomy, not unrestricted host access.

## Storage and defaults

The repository policy is stored under controller-owned state:

```text
<controllerHome>/repositories/<repoId>/controller/access-policy.json
```

The setting is not written into the repository. When no policy file exists, the personal-controller default is `full_access` without creating a file. A malformed existing policy fails closed to `request`.

Each durable `WorkContract` captures the effective `accessMode` in `constraints` when work starts. Changing the repository default affects new work only; an existing task keeps its immutable snapshot.

## MCP and Local Controller UI

The stable MCP schema always includes:

- `rh_access`;
- `repository_access_get`;
- `repository_access_preview`;
- `repository_access_set`.

Changing a mode requires explicit authorization:

```json
{
  "operation": "set",
  "mode": "request",
  "confirm_authorization": true
}
```

No magic confirmation phrase is required for repository-local Full Access. The result explicitly reports:

```json
{
  "reconnectRequired": false,
  "schemaRefreshRequired": false,
  "toolSchemaStable": true
}
```

The Local Controller UI uses the same controllerHome policy and explains that switching mode changes approval behavior only.

## Per-work override

`rh_work` may override the repository default for one work item:

```json
{
  "operation": "start",
  "objective": "Refactor controller routing",
  "constraints": {
    "accessMode": "request",
    "workspaceMode": "current"
  }
}
```

Both camelCase and snake_case are accepted inside constraints. The effective mode is captured in the created WorkContract.

## Decision matrix

| Effect | Request | Full Access |
| --- | --- | --- |
| Read selected repository | allow | allow |
| Direct Edit / safe patch | allow | allow |
| General repository write | request | allow |
| Repository-scoped local command | request | allow |
| Dependency change | request | allow |
| Local Git write | request | allow |
| Registered checks | allow | allow |
| External network | request | request |
| Remote write / push | request | request |
| Destructive effect | explicit approval | explicit approval |
| Raw secrets or credentials | deny | deny |
| Outside-repository path | explicit grant | explicit grant |

## Compatibility

The legacy `core`, `advanced`, and `full` labels remain accepted. `core` and `advanced` resolve to the same stable, repair-capable schema. `full` exposes every historical compatibility tool and is intended only for legacy integrations and deep diagnostics.
