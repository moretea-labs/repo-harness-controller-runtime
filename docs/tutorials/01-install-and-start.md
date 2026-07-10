# Tutorial 1: Install and Start

This tutorial installs the CLI, initializes the user-level runtime, checks the host, and registers one repository.

## 1. Choose the platform path

- macOS or Linux: full supported workflow.
- Windows: use WSL2 for the full workflow.
- Native Windows PowerShell: preview support for installation, doctor, repository registration/inspection, and portable controller operations. See [Platform Support](../operations/platform-support.md).

## 2. Install prerequisites

Required on every platform:

- Git;
- Node.js 20.10 or newer;
- npm or Bun 1.0+;
- a writable home directory.

Bun is recommended for source development and the full test suite. Codex, Claude, `gh`, Tailscale, Cloudflare, and browser dependencies are optional and should be installed only for the features that need them.

Check the baseline:

```bash
git --version
node --version
npm --version
```

## 3. Install the CLI

From the package registry, use either installer:

```bash
npm install -g repo-harness
# or
bun add -g repo-harness
```

From source on macOS, Linux, or WSL2:

```bash
git clone https://github.com/moretea-labs/repo-harness-controller-runtime.git
cd repo-harness-controller-runtime
bun install
REPO_HARNESS_DRY_RUN=1 ./install.sh
./install.sh
```

From source in native Windows PowerShell:

```powershell
git clone https://github.com/moretea-labs/repo-harness-controller-runtime.git
Set-Location repo-harness-controller-runtime
.\install.ps1 -DryRun -Runtime auto
.\install.ps1 -Runtime auto
```

Set `REPO_HARNESS_INSTALL_RUNTIME=node` to force npm or `bun` to force Bun.

## 4. Initialize the user runtime

```bash
repo-harness install --no-cli
repo-harness doctor
```

`install --no-cli` configures the user-level repo-harness runtime without reinstalling the package. On native Windows, Bash-owned skill synchronization and automatic CodeGraph setup are skipped; use WSL2 when those features are required.

## 5. Adopt or register a repository

For the full macOS/Linux/WSL2 workflow, preview adoption first:

```bash
repo-harness adopt --repo /path/to/your-project --dry-run
repo-harness adopt --repo /path/to/your-project
```

Native Windows users should start with registration and inspection; run shell-heavy adoption through WSL2:

```powershell
repo-harness repo register C:\path\to\your-project --name my-project --json
repo-harness repo list --json
```

All platforms can register explicitly:

```bash
repo-harness repo register /path/to/your-project --name my-project --json
repo-harness repo list --json
```

Keep the returned `repoId`. It is the stable identity used by ChatGPT and the Controller.

## 6. Confirm readiness

```bash
repo-harness --version
repo-harness doctor
repo-harness repo list --json
```

Runtime state belongs in Controller Home and ignored repository links, not in public source control. Never commit tokens, MCP runtime files, local jobs, logs, or generated worktrees.

Continue with [Tutorial 2: Connect ChatGPT](02-connect-chatgpt.md). Review [Features and Setup Levels](../operations/features.md) before enabling optional integrations. For errors, use [Troubleshooting](../operations/troubleshooting.md).
