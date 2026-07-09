# repo-harness iOS Simulator Development Assistant

This document describes the structured iOS development assistant surface for trusted local Swift and SwiftUI repositories.

## Goals

The assistant helps ChatGPT and local supervisors run a safe development loop:

1. inspect Xcode readiness,
2. list available iOS Simulators,
3. discover repository-bounded Xcode projects and schemes,
4. build into `.repo-harness/ios/DerivedData`,
5. boot a simulator with authorization,
6. install and launch a simulator app with authorization,
7. capture screenshots into `.repo-harness/ios/screenshots`,
8. collect bounded logs into `.repo-harness/ios/logs`.

## Safety boundaries

The tool surface intentionally does not expose destructive or publishing actions:

- no real-device deployment by default,
- no signing certificate, provisioning profile, or Keychain mutation,
- no App Store Connect upload,
- no `xcodebuild archive` or `-exportArchive`,
- no `xcrun simctl erase`, `delete`, or `shutdown all`,
- no arbitrary shell command parameters,
- no writing outside `.repo-harness/ios/**` for build artifacts, logs, and screenshots.

## Tool groups

Readonly tools:

- `ios_xcode_status`
- `ios_simulators_list`
- `ios_project_discover`
- `ios_schemes_list`
- `ios_simulator_log_tail`

Authorized local app control:

- `ios_simulator_boot`
- `ios_app_install`
- `ios_app_launch`
- `ios_ui_smoke_test`

Workspace-write artifact tools:

- `ios_app_build`
- `ios_simulator_screenshot`

## Typical UI review loop

```text
ios_xcode_status
→ ios_simulators_list
→ ios_project_discover
→ ios_schemes_list
→ ios_simulator_boot(confirm_authorization=true)
→ ios_app_build
→ ios_app_install(confirm_authorization=true)
→ ios_app_launch(confirm_authorization=true)
→ ios_simulator_screenshot
→ ChatGPT reviews the screenshot artifact and proposes UI fixes
```

## Plugin surface (`ios`)

The same workflow is also exposed as a controller plugin via `list_plugins` /
`get_plugin` / `plugin_action_execute`:

| Action | Purpose |
| --- | --- |
| `discover_project` | Discover workspace/project/Package.swift/Info.plist |
| `list_schemes` | List schemes for the discovered container |
| `build` | `xcodebuild` into bounded DerivedData |
| `launch_simulator` | Boot a simulator |
| `capture_screenshot` | Capture a screenshot artifact |
| `smoke_review` | **Composite staged review** (recommended) |

### Staged `smoke_review`

`ios.smoke_review` runs these stages independently and keeps earlier evidence if
a later stage fails:

1. `project_discovery`
2. `scheme_selection`
3. `build`
4. `simulator_preparation`
5. `install`
6. `launch`
7. `screenshot`
8. `logs`

Result shape:

- `overallStatus`: `passed` | `failed`
- `blockedStage` + `blockedRepairHint` when failed
- `stages[]` with per-stage status, command evidence, artifacts, repair hints
- `artifacts[]` screenshot/log paths

Plugin screenshots/logs are written under controller runtime artifact storage:

```text
$CONTROLLER_HOME/repositories/<repoId>/artifacts/ios/{screenshots,logs,build-reports}/
```

Repository-local MCP tools still use `.repo-harness/ios/**` for backward
compatibility.

### Troubleshooting

| Stage | Common fix |
| --- | --- |
| `project_discovery` | Add `.xcodeproj` / `.xcworkspace` or `Package.swift` |
| `scheme_selection` | Share a scheme in Xcode or pass `scheme` |
| `build` | Fix compile errors; inspect stage `stdout`/`stderr` |
| `simulator_preparation` | Install a simulator runtime; pass `udid` |
| `install` / `launch` | Confirm bundle id and built `.app` under DerivedData |
| `screenshot` / `logs` | Ensure simulator is booted and not stuck |

Screenshots are intentionally stored under bounded artifact roots so they can be referenced without exposing arbitrary local paths.
