---
title: "Autonomous Local Repository Bootstrap and iOS Review Loops"
kind: "prd"
created_at: "2026-07-06T14:13:52.692Z"
source: "repo-harness-mcp"
---
# PRD: Autonomous Local Repository Bootstrap and iOS Review Loops

> **Status**: Draft

## Problem

repo-harness can register existing Git repositories and discover iOS projects, but it cannot currently complete trusted personal local workflows when a valid project directory is not yet a Git repository. It also cannot reliably run active goal loops through ChatGPT-triggered tool calls because active scheduling, local agent execution, and iOS smoke testing are not isolated enough from platform-level gating.

Current examples:
- TinyMoments registered path is an empty shell, while TinyMoments 1.7 contains the latest V1.7 source tree.
- PulseMetronomeApp contains an Xcode project and build scripts but has no .git directory.
- Shadow schedules can record would_execute, but active run_agent_goal and trigger paths are not yet reliable enough for unattended improvement loops.

## Goals

1. Add a structured repository bootstrap action for trusted local project directories.
2. Allow safe initialization of non-Git local project directories after explicit authorization and policy checks.
3. Register the initialized repository and make it eligible for normal repo-harness workflows.
4. Support replacing an obsolete registered path with the latest sibling source directory when evidence shows the registered path is empty or stale.
5. Make goal loops autonomous from the local daemon side, with ChatGPT only setting policy, reviewing results, and escalating exceptions.
6. Add staged iOS smoke review: discover, scheme, build, simulator preparation, install, launch, screenshot, logs.
7. Add DeepSeek backup handoff when ChatGPT tool calls are platform-blocked or unavailable.

## Non-goals

- Bypass platform safety checks.
- Initialize repositories in sensitive paths.
- Mutate arbitrary external directories without explicit structured authorization.
- Push to remote repositories automatically.

## Requirements

### Repository bootstrap

Add a structured action such as `repository_bootstrap_local_project` with these inputs:
- absolute local path
- display name
- default branch
- explicit authorization flag
- optional `replace_registered_repo_id`
- optional bootstrap mode: `init_git_only`, `init_git_and_register`, `replace_registration`

The action must:
- canonicalize the path
- deny sensitive paths
- ensure the path is an existing directory
- reject paths with nested unrelated .git directories unless explicitly handled
- detect project markers such as Package.swift, *.xcodeproj, README.md, build scripts, app/source directories
- create .git only when missing
- create or validate .gitignore
- make an initial commit when requested and safe
- register the repository
- optionally disable or update the stale registered repository
- return an audit summary and next actions

### Latest-source selection

Add a helper diagnosis that compares sibling project directories by:
- Git presence
- project markers
- version/release files
- README milestone/version text
- App/Widget/source presence
- file counts and recent marker files

It should recommend the latest source directory without destructive changes.

### Autonomous loops

Add local-daemon-owned execution for schedules so routine active schedule occurrences do not depend on ChatGPT manually triggering a tool call. Each occurrence should record:
- planned operation
- dispatch result
- local job id if any
- terminal status
- failure classification
- whether DeepSeek fallback was prepared

### iOS staged smoke review

Add a single composite status action and/or schedule operation that reports each stage independently:
- project discovery
- scheme selection
- build
- simulator preparation
- install
- launch
- screenshot
- logs

Failures should not collapse into one opaque error. The user should see the exact blocked stage and next repair target.

### DeepSeek fallback

When ChatGPT tool calls are blocked or unavailable, repo-harness should prepare a bounded DeepSeek handoff packet with:
- objective
- repo id
- last safe evidence
- blocked tool name
- next safe action

The external model should not be called automatically unless the user has configured and authorized it locally.

## Acceptance Criteria

- PulseMetronomeApp can be initialized as a Git repository and registered through a structured repo-harness action.
- TinyMoments 1.7 can be selected as the latest TinyMoments source and registered or used to replace the stale TinyMoments registration through a structured action.
- Active local loops can run from the local daemon without requiring ChatGPT to manually trigger every occurrence.
- Goal loop status clearly shows whether it is shadow, active, executing, failed, or waiting for review.
- iOS smoke review reports each stage independently and stores screenshot/log artifacts when available.
- DeepSeek fallback handoff can be generated for platform-blocked actions.
- Tests cover non-Git bootstrap, stale registration replacement, sensitive path denial, sibling latest-source diagnosis, active schedule dispatch, and iOS staged status.
