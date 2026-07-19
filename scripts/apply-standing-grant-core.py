from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if old not in text:
        raise SystemExit(f'anchor not found in {path}: {old[:120]!r}')
    file.write_text(text.replace(old, new, 1))

replace_once(
    'src/runtime/execution/jobs/types.ts',
    "  surface: 'mcp' | 'local-ui' | 'mobile-intent' | 'chatgpt-action' | 'assistant-routine' | 'cli' | 'schedule' | 'reconciliation' | 'system';",
    "  surface: 'mcp' | 'local-ui' | 'mobile-intent' | 'chatgpt-action' | 'assistant-routine' | 'standing-grant' | 'cli' | 'schedule' | 'reconciliation' | 'system';",
)
replace_once(
    'src/runtime/evidence/event-ledger.ts',
    "  entityType: 'job' | 'plugin' | 'schedule' | 'occurrence' | 'portfolio' | 'campaign' | 'candidate-finding' | 'release' | 'lease' | 'schedule-decision' | 'assistant-action-proposal';",
    "  entityType: 'job' | 'plugin' | 'schedule' | 'occurrence' | 'portfolio' | 'campaign' | 'candidate-finding' | 'release' | 'lease' | 'schedule-decision' | 'assistant-action-proposal' | 'assistant-standing-grant';",
)
old_deny = """function denyAutomatedWrite(manifest: AssistantPluginManifest, action: AssistantPluginActionDescriptor, origin: AssistantPluginActionExecutionInput['origin']): void {
  if (!['schedule', 'reconciliation', 'system', 'assistant-routine'].includes(origin.surface)) return;
  if (action.readOnly) return;
  throw new Error(`EXTERNAL_EFFECT_AUTHORIZATION_REQUIRED: ${manifest.pluginId}/${action.actionId} cannot run from ${origin.surface}`);
}"""
new_deny = """const STANDING_GRANT_SAFE_ACTIONS = new Set([
  'gmail/create_draft',
  'gmail/archive_message',
  'gmail/mark_message_read',
  'gmail/mark_message_unread',
  'google_tasks/create_task',
]);

function denyAutomatedWrite(manifest: AssistantPluginManifest, action: AssistantPluginActionDescriptor, origin: AssistantPluginActionExecutionInput['origin']): void {
  if (origin.surface === 'standing-grant') {
    const key = `${manifest.pluginId}/${action.actionId}`;
    if (STANDING_GRANT_SAFE_ACTIONS.has(key) && action.confirmation !== 'strong_confirmation') return;
    throw new Error(`STANDING_GRANT_ACTION_NOT_ALLOWED: ${key}`);
  }
  if (!['schedule', 'reconciliation', 'system', 'assistant-routine'].includes(origin.surface)) return;
  if (action.readOnly) return;
  throw new Error(`EXTERNAL_EFFECT_AUTHORIZATION_REQUIRED: ${manifest.pluginId}/${action.actionId} cannot run from ${origin.surface}`);
}"""
replace_once('src/runtime/plugins/store.ts', old_deny, new_deny)

replace_once(
    'src/runtime/assistant/action-proposals.ts',
    "  evidenceMessageIds: string[];\n  reason: string;",
    "  evidenceMessageIds: string[];\n  context?: { sender?: string; subject?: string };\n  reason: string;",
)
replace_once(
    'src/runtime/assistant/action-proposals.ts',
    "  executionJobId?: string;\n  rejectionReason?: string;",
    "  executionJobId?: string;\n  standingGrantId?: string;\n  rejectionReason?: string;",
)
replace_once(
    'src/runtime/assistant/action-proposals.ts',
    "  evidenceMessageIds: string[];\n  reason: string;\n  confidence?: number;",
    "  evidenceMessageIds: string[];\n  context?: { sender?: string; subject?: string };\n  reason: string;\n  confidence?: number;",
)
replace_once(
    'src/runtime/assistant/action-proposals.ts',
    "      evidenceMessageIds: [...new Set(proposal.evidenceMessageIds)].slice(0, 50),\n      reason: proposal.reason,",
    "      evidenceMessageIds: [...new Set(proposal.evidenceMessageIds)].slice(0, 50),\n      context: proposal.context ? {\n        sender: typeof proposal.context.sender === 'string' ? proposal.context.sender.slice(0, 500) : undefined,\n        subject: typeof proposal.context.subject === 'string' ? proposal.context.subject.slice(0, 1_000) : undefined,\n      } : undefined,\n      reason: proposal.reason,",
)
replace_once(
    'src/runtime/assistant/action-proposals.ts',
    "  input: { proposalId: string; requestId: string; confirmationText?: string; origin?: { surface: 'mcp' | 'local-ui'; actor: string } },",
    "  input: {\n    proposalId: string;\n    requestId: string;\n    confirmationText?: string;\n    origin?: { surface: 'mcp' | 'local-ui' | 'standing-grant'; actor: string };\n    standingGrantId?: string;\n  },",
)
replace_once(
    'src/runtime/assistant/action-proposals.ts',
    "    proposal.status = 'approved';\n    proposal.executionJobId = submitted.job.jobId;",
    "    proposal.status = 'approved';\n    proposal.executionJobId = submitted.job.jobId;\n    proposal.standingGrantId = input.standingGrantId;",
)
replace_once(
    'src/runtime/assistant/action-proposals.ts',
    "      data: { executionJobId: proposal.executionJobId, pluginId: proposal.pluginId, actionId: proposal.actionId },",
    "      data: {\n        executionJobId: proposal.executionJobId,\n        pluginId: proposal.pluginId,\n        actionId: proposal.actionId,\n        standingGrantId: proposal.standingGrantId,\n        surface: input.origin?.surface ?? 'local-ui',\n      },",
)

replace_once(
    'src/runtime/assistant/model-provider.ts',
    "function configuredCredential(env: NodeJS.ProcessEnv): { value?: string; source?: string } {\n  const candidates: Array<[string, string | undefined]> = [\n    ['REPO_HARNESS_ASSISTANT_MODEL_API_KEY', env.REPO_HARNESS_ASSISTANT_MODEL_API_KEY],\n    ['OPENAI_API_KEY', env.OPENAI_API_KEY],\n    ['REPO_HARNESS_DEEPSEEK_API_KEY', env.REPO_HARNESS_DEEPSEEK_API_KEY],\n    ['DEEPSEEK_API_KEY', env.DEEPSEEK_API_KEY],\n  ];",
    "function configuredCredential(env: NodeJS.ProcessEnv, endpoint?: string): { value?: string; source?: string } {\n  const deepSeekEndpoint = endpoint?.includes('api.deepseek.com') === true;\n  const candidates: Array<[string, string | undefined]> = [\n    ['REPO_HARNESS_ASSISTANT_MODEL_API_KEY', env.REPO_HARNESS_ASSISTANT_MODEL_API_KEY],\n    ...(deepSeekEndpoint\n      ? [['REPO_HARNESS_DEEPSEEK_API_KEY', env.REPO_HARNESS_DEEPSEEK_API_KEY], ['DEEPSEEK_API_KEY', env.DEEPSEEK_API_KEY], ['OPENAI_API_KEY', env.OPENAI_API_KEY]]\n      : [['OPENAI_API_KEY', env.OPENAI_API_KEY], ['REPO_HARNESS_DEEPSEEK_API_KEY', env.REPO_HARNESS_DEEPSEEK_API_KEY], ['DEEPSEEK_API_KEY', env.DEEPSEEK_API_KEY]]) as Array<[string, string | undefined]>,\n  ];",
)
replace_once(
    'src/runtime/assistant/model-provider.ts',
    "  const credential = configuredCredential(env);\n  const timeoutMs",
    "  const timeoutMs",
)
replace_once(
    'src/runtime/assistant/model-provider.ts',
    "  const model = modelOverride || (deepSeekConfigured ? env.REPO_HARNESS_DEEPSEEK_MODEL?.trim() || 'deepseek-chat' : undefined);\n  if (!endpoint || !model) {",
    "  const model = modelOverride || (deepSeekConfigured ? env.REPO_HARNESS_DEEPSEEK_MODEL?.trim() || 'deepseek-chat' : undefined);\n  const credential = configuredCredential(env, endpoint);\n  if (!endpoint || !model) {",
)
replace_once(
    'src/runtime/assistant/model-provider.ts',
    "      const credential = configuredCredential(env);",
    "      const credential = configuredCredential(env, config.endpoint);",
)
print('Applied Standing Grant core and model credential integration.')
