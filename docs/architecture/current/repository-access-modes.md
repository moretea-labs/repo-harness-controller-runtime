# Repository access modes

repo-harness exposes two user-selectable permission levels for repository work:

- `request` — the default. Read-only work and bounded Direct Control edits may proceed, while elevated local effects ask for approval.
- `full_access` — permits normal local work inside the selected repository without repeated approval prompts.

The mode is repository-scoped. It is not a machine-wide sandbox bypass.

## Safety boundary

`full_access` automatically permits:

- reading and writing files in the selected repository;
- repository-scoped local commands;
- dependency changes;
- local Git operations;
- registered checks and verification.

It does **not** automatically permit:

- paths outside the selected repository;
- external network access;
- Git push or other remote writes;
- deployments, publishing, or destructive actions;
- raw secret, token, private-key, or credential access;
- bypassing managed controller policy.

Those effects continue to require approval or remain denied by the existing hard policy.

## Storage

The repository default is stored under controller-owned runtime state:

```text
<controllerHome>/repositories/<repoId>/controller/access-policy.json
```

The setting is not written to the repository and is not committed to Git. A missing or malformed file safely falls back to `request`.

Each durable WorkContract captures its effective `accessMode` in `constraints`. Changing the repository default affects new work; an existing task keeps its captured mode.

## MCP tools

The controller core toolset exposes:

- `repository_access_get`
- `repository_access_set`

Enabling Full Access requires both:

```json
{
  "mode": "full_access",
  "confirm_authorization": true,
  "confirmation_text": "enable-full-access"
}
```

Downgrading to Request is also an explicit write action:

```json
{
  "mode": "request",
  "confirm_authorization": true
}
```

## Per-task override

`rh_work` already accepts a generic `constraints` object. A caller may select a mode for one task without changing the repository default:

```json
{
  "operation": "start",
  "objective": "Refactor the local controller routing",
  "constraints": {
    "accessMode": "full_access"
  }
}
```

Both camelCase and snake_case are accepted inside constraints:

```json
{
  "constraints": {
    "access_mode": "request"
  }
}
```

The response includes `accessMode`, `accessModeLabel`, and `accessModeDescription`, and a created work summary includes the captured mode.

## Decision matrix

| Effect | Request | Full Access |
| --- | --- | --- |
| Read selected repository | allow | allow |
| Bounded Direct Control edit | allow | allow |
| General repository/workspace write | request | allow |
| Repository-scoped local command | request | allow |
| Dependency change | request | allow |
| Local Git write | request | allow |
| External network | request | request |
| Remote write / push | request | request |
| Destructive effect | strong confirmation | strong confirmation |
| Raw secrets or credentials | deny | deny |
| Outside-repository path | request | request |

## Compatibility

Existing callers that do not send an access mode retain the previous safe behavior because the default is `request`. Existing approval fields and hard authorization checks remain in force.
