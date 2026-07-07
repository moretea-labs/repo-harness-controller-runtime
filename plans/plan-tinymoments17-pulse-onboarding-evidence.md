---
title: "Execution Notes: TinyMoments 1.7 and PulseMetronome Onboarding"
kind: "plan"
created_at: "2026-07-06T14:19:08.873Z"
source: "repo-harness-mcp"
---
# Execution Notes: TinyMoments 1.7 and PulseMetronome Onboarding

## Findings

- `/Users/greyson/DevProjects/TinyMoments` appears stale or empty from the external filesystem snapshot: only `.ai` is visible and `.git` is not visible through the read-only grant.
- `/Users/greyson/DevProjects/TinyMoments 1.7` contains the complete project tree: `App`, `Widget`, `Shared`, `Tests`, `Resources`, `Package.swift`, `TinyMoments.xcodeproj`, `build.sh`, `archive.sh`, and release notes.
- `TinyMoments 1.7/RELEASE_LOGO_WIDGET_LINKS_V1_7.md` states that the internal milestone is V1.7 and build is 7, with logo integration, widget URL fallback, iPhone-only release checks, privacy manifest, no ads, no membership, and no third-party SDKs.
- `/Users/greyson/DevProjects/PulseMetronomeApp` contains `PulseMetronome.xcodeproj`, `PulseMetronome`, `build.sh`, and `scripts/review_static.sh`, but no `.git` metadata.
- `PulseMetronomeApp/build.sh` uses scheme `PulseMetronome` and builds through `xcodebuild`.

## Decision

Treat `TinyMoments 1.7` as the latest TinyMoments source tree. The stale `TinyMoments` registration should be superseded or replaced after repo-harness adds a structured local project bootstrap/replacement action.

Treat `PulseMetronomeApp` as a valid local iOS project that needs Git initialization and registration through the same structured bootstrap action.

## Required repo-harness capability

Implement local project bootstrap and latest-source diagnosis before mutating these directories. The action must be auditable, deny sensitive paths, detect project markers, initialize Git if missing, optionally create `.gitignore` and an initial commit, register the repository, and optionally supersede stale registration without deleting user files.

## Interim action

Do not manually copy or mutate these project directories through arbitrary shell commands. Use the new structured action once implemented.
