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

Screenshots are intentionally stored under repository-local `.repo-harness/ios/screenshots` so they can be referenced as bounded artifacts without exposing arbitrary local paths.
