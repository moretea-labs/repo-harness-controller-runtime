export type McpProfileName = 'planner' | 'executor' | 'orchestrator' | 'controller';
export type McpPathIntent = 'read' | 'write';
export type McpAgentRunnerName = 'codex' | 'claude';
/** Controller MCP tools/list exposure profile.
 * - core (default): facade + repository bootstrap/selection only
 * - advanced: supervised controller surface (former large core set)
 * - full: compatibility mode — all legacy + runtime tools
 */
export type McpToolset = 'core' | 'advanced' | 'full';

export interface McpPolicy {
  profile: McpProfileName;
  readGlobs: string[];
  writeGlobs: string[];
  denyGlobs: string[];
  maxFileBytes: number;
  execution: {
    fixedWorkflowCheck: boolean;
    codexRunner: boolean;
    agentRunner: boolean;
    allowedAgents: McpAgentRunnerName[];
    runnerTimeoutMs: number;
    runnerMaxTimeoutMs: number;
  };
}

export interface McpPathDecision {
  ok: boolean;
  relativePath?: string;
  absolutePath?: string;
  reason?: string;
}

export interface McpAuditEntry {
  timestamp: string;
  tool: string;
  status: 'ok' | 'blocked' | 'failed';
  targetPath?: string;
  inputHash?: string;
  error?: string;
}
