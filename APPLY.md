# Apply instructions

This package is a sandbox-generated implementation package for the generic personal-assistant triage, rules, and daily reporting runtime.

It includes the previous generic triage runtime plus a new reporting/rules layer:

- `src/runtime/personal-assistant/triage-runtime.ts`
- `src/runtime/personal-assistant/reporting-runtime.ts`
- `tests/runtime/personal-assistant-triage-runtime.test.ts`
- `tests/runtime/personal-assistant-reporting-runtime.test.ts`
- `docs/personal-assistant-triage-runtime.md`
- `docs/personal-assistant-reporting-runtime.md`
- `config/personal-assistant/default-rules.example.json`

## Apply

```bash
cd /Users/greyson/DevProjects/repo-harness-controller-runtime

git checkout -b feat/personal-assistant-rules-reporting

git apply --check ~/Downloads/repo-harness-personal-assistant-rules-reporting-20260705.patch
git apply --3way ~/Downloads/repo-harness-personal-assistant-rules-reporting-20260705.patch

bun install
npm run check:type
bun test tests/runtime/personal-assistant-triage-runtime.test.ts tests/runtime/personal-assistant-reporting-runtime.test.ts tests/runtime/personal-assistant-plugin-runtime.test.ts
```

## Commit

```bash
git status
git add src/runtime/personal-assistant/triage-runtime.ts \
  src/runtime/personal-assistant/reporting-runtime.ts \
  tests/runtime/personal-assistant-triage-runtime.test.ts \
  tests/runtime/personal-assistant-reporting-runtime.test.ts \
  docs/personal-assistant-triage-runtime.md \
  docs/personal-assistant-reporting-runtime.md \
  config/personal-assistant/default-rules.example.json

git commit -m "feat(personal-assistant): add rules and daily reporting runtime"
```

## Follow-up integration prompt

Wire connector output into the new runtime:

- Gmail search/read results become `AssistantItem` with `source="gmail"` and `kind="email"`.
- Calendar events become `AssistantItem` with `source="calendar"` and `kind="calendar_event"`.
- GitHub Dependabot, issue, and PR notifications become `AssistantItem` with `source="github"`.
- The scheduled daily brief calls `buildDailyAssistantBrief` and renders `renderBriefMarkdown`.
- Remote writes execute only after a confirmation gate accepts the proposed action IDs.
