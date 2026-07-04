# Runtime performance diagnostics

Repo-harness exposes a read-only runtime_performance_diagnostics MCP tool for host-level performance inspection.

It is intended for questions such as:

- Why is repo-harness using CPU while the queue is empty?
- Are there orphan job-worker processes?
- Is the Local Controller actually running even if persisted runtime state is stale?
- Which temporary repo-harness directories are stale cleanup candidates?

The tool returns controller queue state, bounded repo-harness process samples, orphan worker detection, Local Controller process inference, temporary directory accumulation, and a no-side-effect cleanup preview.

The cleanup preview is intentionally non-destructive. Terminating processes or deleting temporary directories must remain a separate explicit operation.
