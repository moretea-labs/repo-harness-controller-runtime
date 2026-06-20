# Install Scripts Get Started Notes

- Decision: the no-Node install path is implemented as OS-specific installer scripts, not as a claimed prebuilt binary download.
- Rationale: the current CLI entrypoints use `#!/usr/bin/env bun`, so the truthful installer boundary is "ensure Bun, install `repo-harness` with Bun, verify `repo-harness --version`."
- Tradeoff: the README mirrors the CodeGraph-style copyable install block, but the package-manager fallback explicitly says the npm path still needs Bun on `PATH`.
