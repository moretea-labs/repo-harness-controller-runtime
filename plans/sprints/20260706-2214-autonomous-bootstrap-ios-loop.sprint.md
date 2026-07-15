---
title: "Autonomous Repository Bootstrap and iOS Loop Sprint"
kind: "sprint"
created_at: "2026-07-06T14:14:05.841Z"
source: "repo-harness-mcp"
---
# Sprint: Autonomous Repository Bootstrap and iOS Loop

> **Status**: Draft

## Objective

Make repo-harness capable of bootstrapping trusted local non-Git project directories, selecting the latest sibling source tree, registering it, and running autonomous local goal/iOS review loops with clear fallback behavior.

## Tasks

### 1. Latest source diagnosis

Implement a read-only diagnosis action that compares sibling directories and recommends the latest usable source tree. It must detect empty/stale registered paths and identify richer source directories such as TinyMoments 1.7.

Checks:
- missing/empty registered directory test
- richer sibling source test
- no mutation in diagnosis mode

### 2. Repository bootstrap action

Implement a structured action for local project bootstrap:
- validate canonical path
- deny sensitive paths
- detect project markers
- initialize Git when absent
- optionally create .gitignore and initial commit
- register repository
- optionally disable/update stale registration

Checks:
- non-Git Xcode project bootstrap test
- sensitive path denial test
- nested Git denial test
- idempotent re-run test

### 3. TinyMoments replacement workflow

Implement workflow support for replacing stale TinyMoments registration with TinyMoments 1.7 when diagnosis evidence supports it. The workflow must preserve audit history and avoid destructive deletion.

Checks:
- stale registered repo replacement test
- display-name conflict test
- no duplicate same-path registration test

### 4. Autonomous schedule execution

Make active schedule occurrences dispatch from the local daemon without requiring ChatGPT-triggered execution. Record per-occurrence dispatch, local job id, terminal status, failure classification, and retry/backoff state.

Checks:
- active schedule dispatch test
- shadow schedule no-mutation test
- failed operation classification test

### 5. Staged iOS smoke review

Implement or harden a staged iOS smoke review status model covering project discovery, scheme selection, build, simulator preparation, install, launch, screenshot, and logs.

Checks:
- discovery-only success test
- build failure reports build stage test
- screenshot artifact path recorded test when available

### 6. DeepSeek fallback handoff

Use the existing DeepSeek handoff preparation path when ChatGPT tool calls or local agent dispatch are blocked. The fallback must be bounded and not call external services unless locally configured.

Checks:
- handoff packet includes objective, repo id, last safe evidence, blocked tool name, and next safe action
- no external model call in prepare-only mode

## Stage Gates

1. Diagnosis and bootstrap tests pass.
2. TinyMoments replacement workflow passes tests.
3. Schedule execution tests pass.
4. iOS staged smoke model tests pass.
5. DeepSeek prepare-only fallback tests pass.

## Done

PulseMetronomeApp and TinyMoments 1.7 can be onboarded through structured actions; TinyMoments latest-source selection is explicit; active loops are daemon-owned and observable; iOS review stages are clear; DeepSeek fallback packets are available for blocked paths.
