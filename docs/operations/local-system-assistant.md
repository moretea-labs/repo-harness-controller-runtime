# Local System Assistant

`local_system` is a controller-scoped plugin for occasional Mac diagnostics, opening applications, and bounded file operations. It does not require a registered Git repository and never creates a synthetic Repository Registry entry.

## Supported actions

- Read bounded CPU, process, memory, and memory-pressure snapshots.
- Inspect one process by PID.
- Open a macOS application by name or bundle ID.
- Reveal an authorized file in Finder or open it with the default application.
- List directories, read text, create directories, copy, move, and rename files below authorized roots.

## Safety boundaries

- No arbitrary shell, `sudo`, file deletion, or Accessibility-based clicking.
- A directory must first be authorized with `authorize_target` and an expiring `target_key`; grants are capped at 24 hours.
- File paths are relative to the authorized root.
- Lexical traversal and symlink escape are both rejected.
- Copy, move, and rename never overwrite existing destinations.
- Diagnostics, directory listings, and text reads need no confirmation. Target authorization, opening applications, and file writes use normal authorization.

## Using it from ChatGPT

No `repo_id` is required:

```text
List the local_system plugin capabilities.
Show current CPU and memory pressure.
Open Xcode.
Authorize ~/Documents/Reports as reports for 60 minutes.
Read summary.txt from reports.
```

ChatGPT uses the existing `list_plugins`, `get_plugin`, and `plugin_action_execute` tools. No new MCP tool or reconnect is required.

Plugin state, jobs, target grants, and evidence live under `controllerHome/system/`, outside the Repository Registry.

## iOS automation notes

The iOS smoke review now waits for Simulator readiness, uses build-specific DerivedData, selects the application product deterministically, waits after launch, and records simulator ownership. Supported cleanup policies are:

- `keep`
- `shutdown_on_success`
- `shutdown_always`

Only a simulator started by the current work is eligible for automatic shutdown. Screenshots and logs produce readable Artifact references.
