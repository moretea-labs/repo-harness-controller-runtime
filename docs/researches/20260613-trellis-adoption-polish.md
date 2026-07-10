# Research Note: Trellis Adoption Surface Comparison

> **Date**: 2026-06-13
> **Status**: Applied as docs polish
> **Source**: Trellis upstream `README.md`, repo-harness `README.md`, `docs/reference-configs/harness-overview.md`

## Judgment

Trellis is stronger at adoption packaging: it explains specs, tasks, memory,
quick start, and finish flow before showing internals. repo-harness is stronger
at execution correctness: file-backed authority, contract worktrees, review
evidence, hard edit gates, route evals, heartbeat triage, and rollback surfaces.

Do not reposition repo-harness as a Trellis clone. Borrow the onboarding shape:
show the small repo surfaces first, keep the install path to three steps, and
explain session state as a journal derived from artifacts rather than chat
memory.

## Applied Borrowings

- README now front-loads the adopted-repo surface model:
  `docs/spec.md`, `docs/reference-configs/`, `plans/`, `tasks/contracts/`,
  `tasks/reviews/`, `.ai/harness/checks/`, `.ai/harness/handoff/`, and
  `tasks/current.md`.
- First 5 Minutes now reads as a guided adoption path:
  bootstrap host runtime once, dry-run the target repo contract, then apply and
  verify.
- `harness-overview.md` now includes an Adoption Model that generated repos can
  use as the first onboarding map after `repo-harness update`.

## Not Borrowed

- No generic "let it run" claim. Completion still depends on contract checks,
  review evidence, and explicit acceptance.
- No broad multi-platform expansion. The current product boundary remains
  Claude/Codex adapters plus repo-local workflow files.
- No Trellis implementation code or license surface is copied.
