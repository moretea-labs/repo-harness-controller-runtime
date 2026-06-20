# Controller Workflow Reference

The primary workflow is `Issue -> Task -> Run -> Review -> Verification Gate -> Done`. Tasks may use local Codex/Claude Runs or visible GitHub Copilot cloud sessions. Use dynamic Task operations when the plan changes after execution starts. The PRD/Sprint/Codex Goal chain remains a compatibility and large-product planning layer, not the default unit of execution. See `docs/repo-harness-chatgpt-controller.md`.
