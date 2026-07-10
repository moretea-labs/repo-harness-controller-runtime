# Tutorial 3 — Complete the First Repository Task

Start with a small, reversible change such as updating one documentation paragraph.

1. Ask ChatGPT to call `rh_status` and `rh_context` for the target repository.
2. Describe the desired result, allowed files, and the check that should pass.
3. Let `rh_work` choose a bounded direct edit for small work or a durable Task/Agent path for broader work.
4. Review the changed files and verification evidence.
5. Use `rh_inbox` when approval, clarification, or a blocked decision is waiting.

Example request:

```text
Use repo-harness on my registered repository. Update one README paragraph only, keep the change under 20 lines, run the documentation check, and show me the reviewed diff before finalization.
```

A successful first task leaves durable evidence, does not expose arbitrary shell input, and does not commit runtime logs, credentials, worktrees, or Controller state.
