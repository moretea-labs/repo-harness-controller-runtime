import type { McpToolDefinition } from './tools';

export type ControllerCapabilityGroup = 'core' | 'repository' | 'workflow' | 'git' | 'runtime' | 'plugins' | 'admin' | 'legacy';

export interface CapabilityGroupSnapshot {
  group: ControllerCapabilityGroup;
  toolNames: string[];
  definitions: McpToolDefinition[];
}

export interface ToolDefinitionCacheOptions {
  maxSessions?: number;
  maxEntriesPerSession?: number;
}

const CORE_TOOL_NAMES = new Set(['rh_context', 'rh_access', 'work_submit', 'work_get', 'work_list', 'controller_ready']);

export function controllerCapabilityGroupForTool(name: string): ControllerCapabilityGroup {
  if (CORE_TOOL_NAMES.has(name)) return 'core';
  if (name.startsWith('repository_git_') || name.startsWith('git_')) return 'git';
  if (name.startsWith('repository_')) return 'repository';
  if (name.startsWith('plugin_') || name === 'list_plugins') return 'plugins';
  if (name.startsWith('runtime_') || name.startsWith('controller_')) return 'runtime';
  if (name.startsWith('work_') || name.startsWith('session_') || name.startsWith('approval_') || name.startsWith('result_')) return 'workflow';
  if (name.startsWith('admin_') || name.startsWith('campaign_')) return 'admin';
  return 'legacy';
}

export function groupControllerToolDefinitions(definitions: readonly McpToolDefinition[]): CapabilityGroupSnapshot[] {
  const grouped = new Map<ControllerCapabilityGroup, McpToolDefinition[]>();
  for (const definition of definitions) {
    const group = controllerCapabilityGroupForTool(definition.name);
    const entries = grouped.get(group) ?? [];
    entries.push(definition);
    grouped.set(group, entries);
  }
  return [...grouped.entries()].map(([group, entries]) => ({ group, toolNames: entries.map((entry) => entry.name), definitions: entries }));
}

export class SessionToolDefinitionCache {
  private readonly sessions = new Map<string, Map<string, readonly McpToolDefinition[]>>();
  private readonly maxSessions: number;
  private readonly maxEntriesPerSession: number;

  constructor(options: ToolDefinitionCacheOptions = {}) {
    this.maxSessions = Math.max(1, options.maxSessions ?? 32);
    this.maxEntriesPerSession = Math.max(1, options.maxEntriesPerSession ?? 16);
  }

  getOrCreate(sessionId: string, cacheKey: string, factory: () => readonly McpToolDefinition[]): readonly McpToolDefinition[] {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = new Map();
      this.sessions.set(sessionId, session);
      this.trimSessions();
    } else {
      this.sessions.delete(sessionId);
      this.sessions.set(sessionId, session);
    }
    const cached = session.get(cacheKey);
    if (cached) {
      session.delete(cacheKey);
      session.set(cacheKey, cached);
      return cached;
    }
    const created = Object.freeze([...factory()]);
    session.set(cacheKey, created);
    while (session.size > this.maxEntriesPerSession) {
      const oldest = session.keys().next().value;
      if (oldest === undefined) break;
      session.delete(oldest);
    }
    return created;
  }

  invalidateSession(sessionId: string): void { this.sessions.delete(sessionId); }
  clear(): void { this.sessions.clear(); }
  get sessionCount(): number { return this.sessions.size; }

  private trimSessions(): void {
    while (this.sessions.size > this.maxSessions) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
  }
}
