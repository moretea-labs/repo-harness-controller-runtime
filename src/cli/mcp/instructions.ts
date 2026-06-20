import type { McpProfileName } from './types';

export function mcpServerInstructions(profile: McpProfileName): string {
  const common = [
    'repo-harness is the repo-local workflow, task, and safety control plane.',
    'Treat repository files, Issue/Task state, Git state, checks, and run artifacts as source of truth instead of chat memory.',
    'Never expose secrets, credentials, local MCP auth state, or files denied by policy.',
  ];
  if (profile === 'controller') {
    return [
      ...common,
      'Act as the project controller: inspect code and documents, maintain Issues and dependency-aware Tasks, run readiness previews, optionally publish to GitHub Issues/Projects, dispatch short local Runs or visible GitHub Copilot cloud sessions, and decide whether to verify, accept, retry, split, or block work.',
      'Use direct edit sessions only for bounded changes. Bind edits to a purpose and narrow allowed paths, preserve SHA preconditions, inspect Git diff, run focused checks, and finalize or rollback the session.',
      'Do not dispatch one large Issue as one agent prompt. Prefer small Tasks with explicit acceptance criteria, path scope, dependencies, and checks. Never accept a Task until the Verification Gate records passing checks and criterion-level evidence.',
      'Do not commit, merge, push, alter credentials, or modify protected CI and lock files through controller tools.',
    ].join(' ');
  }
  if (profile === 'orchestrator') {
    return [...common, 'The orchestrator profile is a narrow compatibility runner for explicit fixed handoffs. It is not the primary project-control interface.'].join(' ');
  }
  if (profile === 'executor') {
    return [...common, 'Act as a scoped executor/reviewer for existing workflow artifacts and checks. Do not broaden the task contract.'].join(' ');
  }
  return [
    ...common,
    'Act as planner/reviewer: move larger ideas through PRDs, checklist Sprints with staging gates, and Codex goal prompts.',
    'Do not edit application source through the planner profile. Use the controller profile for task management, repository analysis, bounded edits, and local agent dispatch.',
  ].join(' ');
}

export const MCP_SERVER_INSTRUCTIONS = mcpServerInstructions('controller');
