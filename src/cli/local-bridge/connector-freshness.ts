/**
 * Connector freshness diagnostics for Local Controller GUI and MCP self-test.
 *
 * Distinguishes:
 * - local MCP tool registry / process tool surface
 * - ChatGPT connector tool snapshot (only when connector_tool_names is supplied)
 *
 * Never treat "unable to observe ChatGPT tools" as "missing facade tools".
 * Prefer live MCP /health over a stale mcp.runtime.json snapshot.
 */

import {
  CONTROLLER_SCHEMA_VERSION,
  CONTROLLER_TOOL_SURFACE,
  CONTROLLER_TOOL_SURFACE_VERSION,
  controllerToolSurfaceFingerprint,
} from '../controller/runtime-config';
import { loadMcpLocalConfig, loadMcpRuntimeState, writeMcpRuntimeState } from '../mcp/auth';
import { PREFERRED_FACADE_TOOL_NAMES, DEFAULT_CONTROLLER_TOOL_NAMES } from '../mcp/toolset-names';
import type { PlainStatusTone } from './console-view-models';

export const EXPECTED_FACADE_TOOLS = [...PREFERRED_FACADE_TOOL_NAMES] as const;

/**
 * Interactive development tools included in the stable default schema.
 * The historical core and advanced labels expose the same repair-capable tools.
 */
export const OPTIONAL_INTERACTIVE_DEVELOPMENT_TOOLS = [
  'work_wait',
  'repository_safe_patch_apply',
  'repository_git_create_branch',
  'repository_git_switch_branch',
  'repository_git_commit',
  'get_job',
  'work_get',
] as const;

/** @deprecated Prefer ADVANCED_CONTROLLER_TOOL_NAMES; kept for import stability. */
export const CORE_SURFACE_INTERACTIVE_TOOLS = OPTIONAL_INTERACTIVE_DEVELOPMENT_TOOLS;

export type ConnectorFreshnessStatus =
  | 'local_mcp_updated'
  | 'local_mcp_missing_facade'
  | 'chatgpt_snapshot_missing_facade'
  | 'unable_to_verify_chatgpt_snapshot'
  | 'stale_fingerprint'
  | 'unknown';

export type ConnectorFreshnessSeverity = 'ok' | 'info' | 'warning' | 'error';

export interface ConnectorRuntimeObservation {
  healthy?: boolean;
  toolSurface?: string;
  schemaVersion?: number;
  toolSurfaceVersion?: number;
  toolSurfaceFingerprint?: string;
  toolCount?: number;
  /** Where this observation came from. Live health is preferred over runtime file. */
  source?: 'live_health' | 'runtime_file';
}

export interface EvaluateConnectorFreshnessInput {
  /** Local MCP tools/list or expected/exposed registry names. */
  localToolNames: readonly string[];
  /** Optional ChatGPT connector snapshot. Only set when truly observed. */
  connectorToolNames?: readonly string[] | null;
  expectedFacadeTools?: readonly string[];
  optionalDevelopmentTools?: readonly string[];
  toolSurface?: string;
  schemaVersion?: number;
  toolSurfaceVersion?: number;
  /** Expected fingerprint for the local tool surface (from expectedTools). */
  toolSurfaceFingerprint?: string;
  /** Observed running MCP process surface, if available. */
  runtime?: ConnectorRuntimeObservation | null;
}

export interface ConnectorFreshnessReport {
  status: ConnectorFreshnessStatus;
  severity: ConnectorFreshnessSeverity;
  summary: string;
  missingLocalTools: string[];
  missingConnectorTools: string[];
  expectedFacadeTools: string[];
  observedLocalTools: string[];
  observedConnectorTools?: string[];
  optionalDevelopmentTools: {
    expected: string[];
    present: string[];
    missing: string[];
  };
  toolSurface: string;
  schemaVersion: number;
  toolSurfaceVersion: number;
  toolSurfaceFingerprint: string;
  runtimeFingerprint?: string;
  runtimeHealthy?: boolean;
  fingerprintMatches: boolean | null;
  restartRecommended: boolean;
  reconnectRecommended: boolean;
  suggestedActions: string[];
  howToFix: string[];
  warnings: string[];
  /** GUI chrome */
  connectorLabel: string;
  connectorTone: PlainStatusTone;
  sectionStatusLabel: string;
  sectionDetail: string;
  /** User-facing banner warning (amber/error only; empty for ok/info). */
  bannerWarning?: string;
}

const DEFAULT_HOW_TO_FIX = [
  '重启 controller：npm run controller:restart',
  '检查状态：npm run controller:status',
  '在 ChatGPT 中刷新/重连 MCP Connector',
  '重新打开 Local Controller UI',
  '若仍异常，运行 console smoke / connector status 自检',
] as const;

function uniqueSorted(names: readonly string[]): string[] {
  return [...new Set(names.map((name) => String(name).trim()).filter(Boolean))].sort();
}

function missingFrom(expected: readonly string[], observed: readonly string[]): string[] {
  const set = new Set(observed);
  return expected.filter((name) => !set.has(name));
}

function runtimeFingerprintMatches(
  runtime: ConnectorRuntimeObservation | null | undefined,
  expected: {
    toolSurface: string;
    schemaVersion: number;
    toolSurfaceVersion: number;
    toolSurfaceFingerprint: string;
  },
): boolean | null {
  if (!runtime) return null;
  // Dead/stale runtime snapshots (healthy=false) must not be treated as "fingerprint mismatch".
  // Only a healthy observation can confirm tool-surface freshness.
  if (runtime.healthy !== true) return null;
  if (
    runtime.toolSurface === undefined
    && runtime.schemaVersion === undefined
    && runtime.toolSurfaceVersion === undefined
    && runtime.toolSurfaceFingerprint === undefined
  ) {
    return null;
  }
  return (
    runtime.toolSurface === expected.toolSurface
    && runtime.schemaVersion === expected.schemaVersion
    && runtime.toolSurfaceVersion === expected.toolSurfaceVersion
    && runtime.toolSurfaceFingerprint === expected.toolSurfaceFingerprint
  );
}

const LIVE_HEALTH_TIMEOUT_MS = 800;

function localMcpHealthUrl(repoRoot: string): string | null {
  const config = loadMcpLocalConfig(repoRoot);
  const host = (config?.server?.host ?? '127.0.0.1').trim() || '127.0.0.1';
  const port = typeof config?.server?.port === 'number' && config.server.port > 0
    ? config.server.port
    : 8765;
  const normalized = host === '::1' ? '[::1]' : host;
  return `http://${normalized}:${port}/health`;
}

async function fetchJsonHealth(url: string): Promise<Record<string, unknown> | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LIVE_HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return null;
    return await response.json() as Record<string, unknown>;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Prefer live MCP /health. Fall back to mcp.runtime.json only when it claims healthy.
 * Stale stopped snapshots are ignored so GUI does not cry "fingerprint mismatch" after restart.
 */
export async function observeLocalMcpRuntime(
  repoRoot: string,
  opts: { refreshRuntimeFile?: boolean } = {},
): Promise<ConnectorRuntimeObservation | null> {
  const healthUrl = localMcpHealthUrl(repoRoot);
  if (healthUrl) {
    const live = await fetchJsonHealth(healthUrl);
    if (live && live.status === 'ok') {
      const observation: ConnectorRuntimeObservation = {
        healthy: true,
        toolSurface: typeof live.toolSurface === 'string' ? live.toolSurface : undefined,
        schemaVersion: typeof live.schemaVersion === 'number' ? live.schemaVersion : undefined,
        toolSurfaceVersion: typeof live.toolSurfaceVersion === 'number' ? live.toolSurfaceVersion : undefined,
        toolSurfaceFingerprint: typeof live.toolSurfaceFingerprint === 'string' ? live.toolSurfaceFingerprint : undefined,
        toolCount: typeof live.toolCount === 'number' ? live.toolCount : undefined,
        source: 'live_health',
      };
      if (opts.refreshRuntimeFile !== false) {
        try {
          refreshRuntimeFileFromLive(repoRoot, live, observation);
        } catch {
          // Best-effort only; diagnostics must not fail on file write races.
        }
      }
      return observation;
    }
  }

  const file = loadMcpRuntimeState(repoRoot);
  if (!file?.server) return null;
  // Ignore dead snapshots — they commonly lag behind controller:restart.
  if (file.server.healthy !== true) return null;
  return {
    healthy: true,
    toolSurface: file.server.toolSurface,
    schemaVersion: file.server.schemaVersion,
    toolSurfaceVersion: file.server.toolSurfaceVersion,
    toolSurfaceFingerprint: file.server.toolSurfaceFingerprint,
    toolCount: file.server.toolCount,
    source: 'runtime_file',
  };
}

function refreshRuntimeFileFromLive(
  repoRoot: string,
  live: Record<string, unknown>,
  observation: ConnectorRuntimeObservation,
): void {
  const existing = loadMcpRuntimeState(repoRoot);
  if (!existing) return;
  const now = new Date().toISOString();
  const next = {
    ...existing,
    updatedAt: now,
    status: 'running' as const,
    server: {
      ...existing.server,
      running: true,
      healthy: true,
      lastHealthyAt: now,
      profile: typeof live.profile === 'string' ? live.profile : existing.server.profile,
      toolSurface: observation.toolSurface ?? existing.server.toolSurface,
      schemaVersion: observation.schemaVersion ?? existing.server.schemaVersion,
      toolSurfaceVersion: observation.toolSurfaceVersion ?? existing.server.toolSurfaceVersion,
      toolSurfaceFingerprint: observation.toolSurfaceFingerprint ?? existing.server.toolSurfaceFingerprint,
      runtimeToolSurfaceFingerprint:
        typeof live.runtimeToolSurfaceFingerprint === 'string'
          ? live.runtimeToolSurfaceFingerprint
          : existing.server.runtimeToolSurfaceFingerprint,
      toolset: live.toolset === 'core' || live.toolset === 'advanced' || live.toolset === 'full'
        ? live.toolset
        : existing.server.toolset,
      toolCount: observation.toolCount ?? existing.server.toolCount,
      healthMismatch: undefined,
    },
  };
  // Only rewrite when the snapshot is clearly stale.
  const stale =
    existing.status === 'stopped'
    || existing.server.healthy !== true
    || existing.server.toolSurfaceFingerprint !== observation.toolSurfaceFingerprint;
  if (stale) writeMcpRuntimeState(repoRoot, next);
}

export function evaluateConnectorFreshness(input: EvaluateConnectorFreshnessInput): ConnectorFreshnessReport {
  const expectedFacadeTools = [...(input.expectedFacadeTools ?? EXPECTED_FACADE_TOOLS)];
  const optionalExpected = [...(input.optionalDevelopmentTools ?? OPTIONAL_INTERACTIVE_DEVELOPMENT_TOOLS)];
  const observedLocalTools = uniqueSorted(input.localToolNames ?? []);
  const connectorProvided = Array.isArray(input.connectorToolNames);
  const observedConnectorTools = connectorProvided
    ? uniqueSorted(input.connectorToolNames ?? [])
    : undefined;

  const toolSurface = input.toolSurface ?? CONTROLLER_TOOL_SURFACE;
  const schemaVersion = input.schemaVersion ?? CONTROLLER_SCHEMA_VERSION;
  const toolSurfaceVersion = input.toolSurfaceVersion ?? CONTROLLER_TOOL_SURFACE_VERSION;
  const toolSurfaceFingerprint = input.toolSurfaceFingerprint
    ?? controllerToolSurfaceFingerprint(observedLocalTools);
  const runtime = input.runtime ?? null;
  const fingerprintMatches = runtimeFingerprintMatches(runtime, {
    toolSurface,
    schemaVersion,
    toolSurfaceVersion,
    toolSurfaceFingerprint,
  });

  const missingLocalTools = missingFrom(expectedFacadeTools, observedLocalTools);
  const missingConnectorTools = observedConnectorTools
    ? missingFrom(expectedFacadeTools, observedConnectorTools)
    : [];
  const optionalPresent = optionalExpected.filter((name) => observedLocalTools.includes(name));
  const optionalMissing = optionalExpected.filter((name) => !observedLocalTools.includes(name));

  const base = {
    expectedFacadeTools,
    observedLocalTools,
    observedConnectorTools,
    missingLocalTools,
    missingConnectorTools,
    optionalDevelopmentTools: {
      expected: optionalExpected,
      present: optionalPresent,
      missing: optionalMissing,
    },
    toolSurface,
    schemaVersion,
    toolSurfaceVersion,
    toolSurfaceFingerprint,
    runtimeFingerprint: runtime?.toolSurfaceFingerprint,
    runtimeHealthy: runtime?.healthy,
    fingerprintMatches,
  };

  if (observedLocalTools.length === 0) {
    return finalize({
      ...base,
      status: 'unknown',
      severity: 'warning',
      summary: '无法读取本地 MCP 工具列表。',
      restartRecommended: true,
      reconnectRecommended: false,
      suggestedActions: [
        '重启 controller/MCP 后重新打开 Local Controller UI',
        '运行 npm run controller:status',
      ],
      howToFix: [...DEFAULT_HOW_TO_FIX],
      warnings: ['本地 MCP 工具列表为空或不可用。'],
      connectorLabel: '未知',
      connectorTone: 'gray',
      sectionStatusLabel: '未知',
      sectionDetail: '无法读取本地 MCP 工具面。',
      bannerWarning: '无法读取本地 MCP 工具列表，请检查 Controller/MCP 是否在运行。',
    });
  }

  if (missingLocalTools.length > 0) {
    return finalize({
      ...base,
      status: 'local_mcp_missing_facade',
      severity: 'error',
      summary: '本地 MCP 工具面仍缺少 facade 工具，需要重启 Controller/MCP。',
      restartRecommended: true,
      reconnectRecommended: false,
      suggestedActions: [
        '重启 controller/MCP：npm run controller:restart',
        '确认 tools/list 包含 rh_status / rh_inbox / rh_context / rh_work',
        '重新运行 connector status / smoke 自检',
      ],
      howToFix: [
        '重启 controller：npm run controller:restart',
        '检查状态：npm run controller:status',
        '确认本地 tools/list 含 rh_status / rh_inbox / rh_context / rh_work',
        '重新打开 Local Controller UI',
        '运行 connector status 自检',
      ],
      warnings: [`本地 MCP 缺少 facade 工具：${missingLocalTools.join(', ')}`],
      connectorLabel: '本地工具缺失',
      connectorTone: 'red',
      sectionStatusLabel: '需重启',
      sectionDetail: `本地 MCP 工具面仍缺少：${missingLocalTools.join(', ')}。需要重启 Controller/MCP。`,
      bannerWarning: '本地 MCP 工具面仍缺少 facade 工具，需要重启 Controller/MCP。',
    });
  }

  if (observedConnectorTools) {
    if (missingConnectorTools.length > 0) {
      return finalize({
        ...base,
        status: 'chatgpt_snapshot_missing_facade',
        severity: 'warning',
        summary: 'ChatGPT 当前连接器快照缺少 facade 工具，请重新连接 MCP。',
        restartRecommended: false,
        reconnectRecommended: true,
        suggestedActions: [
          '在 ChatGPT 中重新连接 / 刷新 MCP Connector',
          '确认 tools/list 重新加载后可见 rh_status / rh_inbox / rh_context / rh_work',
          '可选：向 controller_capabilities 传入 connector_tool_names 复核',
        ],
        howToFix: [
          '确认本地 MCP 已更新（本状态表示本地 facade 已存在）',
          '在 ChatGPT 中刷新/重连 MCP Connector',
          '重新打开对话并检查工具列表是否含 rh_*',
          '重新打开 Local Controller UI',
          '若仍异常，运行 connector check 并传入 connector_tool_names',
        ],
        warnings: [`ChatGPT 连接器快照缺少：${missingConnectorTools.join(', ')}`],
        connectorLabel: '需重连 Connector',
        connectorTone: 'amber',
        sectionStatusLabel: '快照过期',
        sectionDetail: `ChatGPT 当前连接器快照缺少 facade 工具：${missingConnectorTools.join(', ')}。请重新连接 MCP。`,
        bannerWarning: 'ChatGPT 当前连接器快照缺少 facade 工具，请重新连接 MCP。',
      });
    }

    return finalize({
      ...base,
      status: 'local_mcp_updated',
      severity: 'ok',
      summary: 'Facade 工具已可用。',
      restartRecommended: false,
      reconnectRecommended: false,
      suggestedActions: [],
      howToFix: [],
      warnings: optionalMissing.length
        ? [`可选交互开发工具未全部暴露：${optionalMissing.join(', ')}`]
        : [],
      connectorLabel: 'Facade 可用',
      connectorTone: 'green',
      sectionStatusLabel: '正常',
      sectionDetail: 'ChatGPT facade tools are available（rh_status / rh_inbox / rh_context / rh_work）。',
    });
  }

  // No ChatGPT snapshot. Local facade tools are present.
  if (fingerprintMatches === false) {
    return finalize({
      ...base,
      status: 'stale_fingerprint',
      severity: 'warning',
      summary: '本地 MCP 进程工具面指纹与当前代码期望不一致，建议重启 Controller/MCP。',
      restartRecommended: true,
      reconnectRecommended: true,
      suggestedActions: [
        '重启 controller/MCP：npm run controller:restart',
        '重启后若 ChatGPT 仍看不到 rh_*，再重连 Connector',
        '运行 npm run controller:status 确认健康',
      ],
      howToFix: [...DEFAULT_HOW_TO_FIX],
      warnings: [
        '运行中的 MCP 进程工具面可能过期（指纹/版本不匹配）。这不等于已确认 ChatGPT 缺少工具。',
      ],
      connectorLabel: '需重启 MCP',
      connectorTone: 'amber',
      sectionStatusLabel: '进程可能过期',
      sectionDetail:
        '本地代码已包含 facade 工具，但运行中的 MCP 进程指纹/版本与期望不一致。请重启 Controller/MCP；若 ChatGPT 里仍不可见 rh_*，再重连 Connector。',
      bannerWarning:
        '本地 MCP 进程工具面可能过期，建议重启 Controller/MCP。GUI 无法据此断言 ChatGPT 已缺少 facade 工具。',
    });
  }

  // Local OK, ChatGPT unknown → info, not "missing".
  return finalize({
    ...base,
    status: 'unable_to_verify_chatgpt_snapshot',
    severity: 'info',
    summary: '本地 MCP 已更新，但无法从 GUI 确认 ChatGPT 当前工具快照。',
    restartRecommended: false,
    reconnectRecommended: false,
    suggestedActions: [
      '如果 ChatGPT 对话里看不到 rh_status / rh_inbox / rh_context / rh_work，请重连 MCP Connector',
      '可选：调用 controller_capabilities 并传入 connector_tool_names 做精确核对',
    ],
    howToFix: [
      '本地 MCP 工具面已包含 rh_*（无需仅为“未确认”而重启）',
      '若 ChatGPT 里看不到 rh_status / rh_inbox / rh_context / rh_work，请重连 MCP Connector',
      '重连后重新打开对话并检查工具列表',
      '重新打开 Local Controller UI',
      '可选：向 /api/console/connector/check 传入 connector_tool_names 精确核对',
    ],
    warnings: [],
    connectorLabel: '本地已更新 · 未确认 ChatGPT',
    connectorTone: 'blue',
    sectionStatusLabel: '未确认',
    sectionDetail:
      '本地 MCP 工具面已更新。GUI 无法直接确认 ChatGPT 当前连接器快照；如果你在 ChatGPT 里看不到 rh_access / rh_status / rh_inbox / rh_context / rh_work，说明连接器快照确实陈旧，可重新加载连接器。',
    // No scary banner — this is informational, not a confirmed missing-tools state.
  });
}

function finalize(
  report: Omit<ConnectorFreshnessReport, never>,
): ConnectorFreshnessReport {
  return report;
}

/**
 * Build local tool names from the in-process controller registry (not ChatGPT).
 * Uses expectedTools when provided; otherwise falls back to the stable default exposure.
 */
export function localControllerToolNames(expectedTools?: readonly string[]): string[] {
  if (expectedTools && expectedTools.length > 0) return uniqueSorted(expectedTools);
  return uniqueSorted([...DEFAULT_CONTROLLER_TOOL_NAMES]);
}

export function buildLocalConnectorStatus(input: {
  expectedTools: readonly string[];
  connectorToolNames?: readonly string[] | null;
  runtime?: ConnectorRuntimeObservation | null;
}): ConnectorFreshnessReport {
  const expectedTools = uniqueSorted(input.expectedTools);
  const fingerprint = controllerToolSurfaceFingerprint(expectedTools);
  return evaluateConnectorFreshness({
    localToolNames: expectedTools,
    connectorToolNames: input.connectorToolNames,
    expectedFacadeTools: EXPECTED_FACADE_TOOLS,
    optionalDevelopmentTools: OPTIONAL_INTERACTIVE_DEVELOPMENT_TOOLS,
    toolSurface: CONTROLLER_TOOL_SURFACE,
    schemaVersion: CONTROLLER_SCHEMA_VERSION,
    toolSurfaceVersion: CONTROLLER_TOOL_SURFACE_VERSION,
    toolSurfaceFingerprint: fingerprint,
    runtime: input.runtime,
  });
}

/**
 * Repo-aware status: probes live MCP /health, then falls back to healthy runtime file only.
 */
export async function buildLocalConnectorStatusForRepo(input: {
  repoRoot: string;
  expectedTools: readonly string[];
  connectorToolNames?: readonly string[] | null;
  refreshRuntimeFile?: boolean;
}): Promise<ConnectorFreshnessReport> {
  const runtime = await observeLocalMcpRuntime(input.repoRoot, {
    refreshRuntimeFile: input.refreshRuntimeFile,
  });
  return buildLocalConnectorStatus({
    expectedTools: input.expectedTools,
    connectorToolNames: input.connectorToolNames,
    runtime,
  });
}
