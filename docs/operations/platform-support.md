# Platform Support

This document defines what the project currently supports. It is intentionally narrower than “the code contains Windows branches.” A platform is called supported only when the installation path, primary workflow, and release checks are covered.

## Support matrix

| Platform | Status | Recommended use |
| --- | --- | --- |
| macOS | Supported | Full local Controller, repository adoption, MCP, Direct Edit, agents, browser tooling, and release checks. |
| Modern Linux | Supported | Full local Controller workflow. A system with Bash, Git, Node.js, and standard process tools is expected. |
| WSL2 on Windows | Supported and recommended for Windows | Run the Linux workflow inside WSL2. Keep the repository inside the WSL filesystem for predictable permissions and performance. |
| Native Windows | Preview | PowerShell installation, CLI loading, doctor, repository registration/inspection, and the portable runtime paths are supported. Shell-heavy workflow helpers remain limited. |

## Required environment

All installations require:

- Git available on `PATH`;
- Node.js 20.10 or newer, because the published `repo-harness` launcher is a Node executable;
- either npm, which ships with Node.js, or Bun 1.0 or newer as the package installer;
- a writable user home directory.

Bun is recommended for development and the full test suite, but it is not the only supported package installer.

The following dependencies are optional and enable additional capabilities:

- Codex or Claude CLI for delegated implementation;
- GitHub CLI (`gh`) for GitHub Issue, Project, and cloud-agent operations;
- Tailscale Funnel or `cloudflared` for a stable public HTTPS `/mcp` endpoint;
- Playwright browser dependencies for browser automation;
- CodeGraph for additional repository navigation;
- Google Workspace credentials for Gmail or Calendar plugins.

## Native Windows scope

The native PowerShell path is release-tested for:

- prerequisite checks and CLI package installation;
- `repo-harness --version` and command loading;
- `repo-harness doctor`;
- repository registry operations;
- Windows path, process, junction, and command handling covered by the portable test suite;
- the default MCP facade and bounded repository operations that do not depend on Bash helpers.

The following are not yet claimed as complete native Windows workflows:

- Bash-owned repository migration and hook scripts;
- `scripts/controller-runtime.sh` lifecycle commands;
- the full source-release Bash gate;
- automatic CodeGraph configuration;
- every external agent CLI and tunnel combination.

For those workflows, use WSL2. The native installer intentionally skips Bash skill synchronization and automatic CodeGraph setup instead of failing the whole installation.

## WSL2 guidance

Install Git, Node.js, and optionally Bun inside WSL2, then clone repositories under the Linux home directory, for example `~/src/project`. Avoid running one checkout alternately from Windows and WSL because file modes, symlinks, line endings, and runtime paths can diverge.

The Windows host can still provide the browser and ChatGPT client. The Controller and MCP process run inside WSL2; expose only the MCP endpoint through a controlled HTTPS tunnel.

## Verification boundary

The repository contains a `windows-latest` smoke workflow covering the PowerShell dry run, installer contracts, native-Windows policy behavior, and portable Node tests. That smoke workflow is evidence for the bounded native scope above; it is not evidence that every Bash- or provider-dependent integration works natively.
