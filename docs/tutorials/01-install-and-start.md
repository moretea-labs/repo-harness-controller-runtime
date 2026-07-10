# Tutorial 1 — Install and Start

## Requirements

- Git
- Node.js 20.10 or newer
- Bun 1.0 or newer
- macOS or Linux for the primary local-controller workflow

## Run from source

```bash
git clone https://github.com/moretea-labs/repo-harness-controller-runtime.git
cd repo-harness-controller-runtime
bun install
bun run src/cli/index.ts doctor
bun run controller:start
bun run controller:status
```

A healthy stack reports the Controller daemon, MCP gateway on `127.0.0.1:8765`, and Local Controller on `127.0.0.1:8766` as ready.

## Register a target repository

```bash
bun run src/cli/index.ts repo register /path/to/your-project --name my-project --json
bun run src/cli/index.ts repo list --json
```

Keep the returned `repoId` and `checkoutId`. Runtime state and logs remain local and must not be committed.

Next: [Connect ChatGPT](02-connect-chatgpt.md).
