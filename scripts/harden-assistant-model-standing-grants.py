from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if old not in text:
        raise SystemExit(f'anchor not found in {path}: {old[:140]!r}')
    file.write_text(text.replace(old, new, 1))

# Custom endpoints may only receive the dedicated Assistant model key.
replace_once(
    'src/runtime/assistant/model-provider.ts',
    "function positiveInteger(value: unknown, fallback: number, max: number): number {\n  return Number.isInteger(value) && Number(value) > 0 ? Math.min(max, Number(value)) : fallback;\n}\n\n",
    "",
)
old_credential = """function configuredCredential(env: NodeJS.ProcessEnv, endpoint?: string): { value?: string; source?: string } {
  const deepSeekEndpoint = endpoint?.includes('api.deepseek.com') === true;
  const candidates: Array<[string, string | undefined]> = [
    ['REPO_HARNESS_ASSISTANT_MODEL_API_KEY', env.REPO_HARNESS_ASSISTANT_MODEL_API_KEY],
    ...(deepSeekEndpoint
      ? [['REPO_HARNESS_DEEPSEEK_API_KEY', env.REPO_HARNESS_DEEPSEEK_API_KEY], ['DEEPSEEK_API_KEY', env.DEEPSEEK_API_KEY], ['OPENAI_API_KEY', env.OPENAI_API_KEY]]
      : [['OPENAI_API_KEY', env.OPENAI_API_KEY], ['REPO_HARNESS_DEEPSEEK_API_KEY', env.REPO_HARNESS_DEEPSEEK_API_KEY], ['DEEPSEEK_API_KEY', env.DEEPSEEK_API_KEY]]) as Array<[string, string | undefined]>,
  ];
  const found = candidates.find(([, value]) => value?.trim());
  return found ? { value: found[1]!.trim(), source: `env:${found[0]}` } : {};
}"""
new_credential = """function configuredCredential(env: NodeJS.ProcessEnv, endpoint?: string): { value?: string; source?: string } {
  let host: string | undefined;
  try { host = endpoint ? new URL(endpoint).hostname.toLowerCase() : undefined; } catch { host = undefined; }
  const candidates: Array<[string, string | undefined]> = [
    ['REPO_HARNESS_ASSISTANT_MODEL_API_KEY', env.REPO_HARNESS_ASSISTANT_MODEL_API_KEY],
    ...(host === 'api.openai.com'
      ? [['OPENAI_API_KEY', env.OPENAI_API_KEY]]
      : host === 'api.deepseek.com'
        ? [['REPO_HARNESS_DEEPSEEK_API_KEY', env.REPO_HARNESS_DEEPSEEK_API_KEY], ['DEEPSEEK_API_KEY', env.DEEPSEEK_API_KEY]]
        : []) as Array<[string, string | undefined]>,
  ];
  const found = candidates.find(([, value]) => value?.trim());
  return found ? { value: found[1]!.trim(), source: `env:${found[0]}` } : {};
}"""
replace_once('src/runtime/assistant/model-provider.ts', old_credential, new_credential)
replace_once(
    'src/runtime/assistant/model-provider.ts',
    "    const context = { sender: senderAddress(message.from), subject: message.subject };",
    "    const context = { sender: senderAddress(message.from), subject: message.subject, protected: protectedMessage(message) };",
)

# Proposal context carries a protected-message bit set by trusted local code.
replace_once(
    'src/runtime/assistant/action-proposals.ts',
    "  context?: { sender?: string; subject?: string };",
    "  context?: { sender?: string; subject?: string; protected?: boolean };",
)
replace_once(
    'src/runtime/assistant/action-proposals.ts',
    "  context?: { sender?: string; subject?: string };",
    "  context?: { sender?: string; subject?: string; protected?: boolean };",
)
replace_once(
    'src/runtime/assistant/action-proposals.ts',
    "        subject: typeof proposal.context.subject === 'string' ? proposal.context.subject.slice(0, 1_000) : undefined,",
    "        subject: typeof proposal.context.subject === 'string' ? proposal.context.subject.slice(0, 1_000) : undefined,\n        protected: proposal.context.protected === true,",
)

# Rule fallback never creates executable placeholder drafts or archive proposals for protected messages.
replace_once(
    'src/runtime/assistant/routine-runtime.ts',
    "function senderAddress(value: string): string | undefined {\n  return value.match(/<([^>]+@[^>]+)>/)?.[1] ?? value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}/i)?.[0];\n}\n\nfunction proposalsFor",
    "function senderAddress(value: string): string | undefined {\n  return value.match(/<([^>]+@[^>]+)>/)?.[1] ?? value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}/i)?.[0];\n}\n\nfunction protectedMessageSummary(message: GmailMessageSummary): boolean {\n  return /(security|authentication|password|login|billing|invoice|incident|production|quota|permission|dependabot|安全|登录|账单|故障|告警|权限)/i\n    .test(`${message.subject} ${message.snippet}`);\n}\n\nfunction proposalsFor",
)
replace_once(
    'src/runtime/assistant/routine-runtime.ts',
    "        executable: Boolean(to),\n        context: { sender: to ?? message.from, subject: message.subject },",
    "        executable: false,\n        context: { sender: to ?? message.from, subject: message.subject, protected: protectedMessageSummary(message) },",
)
replace_once(
    'src/runtime/assistant/routine-runtime.ts',
    "        context: { sender: message.from, subject: message.subject },\n        arguments: { title:",
    "        context: { sender: message.from, subject: message.subject, protected: protectedMessageSummary(message) },\n        arguments: { title:",
)
replace_once(
    'src/runtime/assistant/routine-runtime.ts',
    "    if (/(newsletter|digest|marketing|unsubscribe|推广|营销|周报)/i.test(text)) {",
    "    if (/(newsletter|digest|marketing|unsubscribe|推广|营销|周报)/i.test(text) && !protectedMessageSummary(message)) {",
)
replace_once(
    'src/runtime/assistant/routine-runtime.ts',
    "        context: { sender: message.from, subject: message.subject },\n        arguments: { message_id:",
    "        context: { sender: message.from, subject: message.subject, protected: false },\n        arguments: { message_id:",
)

# Grants require an explicit scope; draft automation requires a sender allowlist.
replace_once(
    'src/runtime/assistant/standing-grants.ts',
    "  if (!grantId || !pluginId || !actionId || !expiresAt) return undefined;",
    "  if (!grantId || !pluginId || !actionId || !expiresAt || !isStandingGrantEligibleAction(pluginId, actionId)) return undefined;",
)
old_create = """  if (!isStandingGrantEligibleAction(pluginId, actionId)) {
    throw new Error(`ASSISTANT_STANDING_GRANT_ACTION_NOT_ALLOWED: ${pluginId}/${actionId}`);
  }
  return withControllerLock"""
new_create = """  if (!isStandingGrantEligibleAction(pluginId, actionId)) {
    throw new Error(`ASSISTANT_STANDING_GRANT_ACTION_NOT_ALLOWED: ${pluginId}/${actionId}`);
  }
  const routineIds = uniqueStrings(input.routineIds, 100);
  const senderAllowlist = uniqueStrings(input.senderAllowlist, 100).map(normalizeEmailRule);
  const subjectContains = uniqueStrings(input.subjectContains, 50);
  if (routineIds.length === 0 && senderAllowlist.length === 0 && subjectContains.length === 0) {
    throw new Error('ASSISTANT_STANDING_GRANT_SCOPE_REQUIRED');
  }
  if (pluginId === 'gmail' && actionId === 'create_draft' && senderAllowlist.length === 0) {
    throw new Error('ASSISTANT_STANDING_GRANT_SENDER_SCOPE_REQUIRED');
  }
  return withControllerLock"""
replace_once('src/runtime/assistant/standing-grants.ts', old_create, new_create)
replace_once(
    'src/runtime/assistant/standing-grants.ts',
    "        routineIds: uniqueStrings(input.routineIds, 100),\n        senderAllowlist: uniqueStrings(input.senderAllowlist, 100).map(normalizeEmailRule),\n        subjectContains: uniqueStrings(input.subjectContains, 50),",
    "        routineIds,\n        senderAllowlist,\n        subjectContains,",
)
replace_once(
    'src/runtime/assistant/standing-grants.ts',
    "  if (grant.status !== 'active') return false;",
    "  if (grant.status !== 'active' || !isStandingGrantEligibleAction(grant.pluginId, grant.actionId)) return false;",
)
replace_once(
    'src/runtime/assistant/standing-grants.ts',
    "  if (proposal.confidence < grant.constraints.minConfidence) return false;",
    "  if (proposal.confidence < grant.constraints.minConfidence) return false;\n  if (proposal.context?.protected === true && proposal.actionId === 'archive_message') return false;",
)
old_list = """  const store = readStore(repository.canonicalRoot);
  let changed = false;
  store.grants = store.grants.map((grant) => {
    const next = expireGrant(grant);
    if (next.status !== grant.status) changed = true;
    return next;
  });
  if (changed) writeStore(repository.canonicalRoot, store);
  const limit"""
new_list = """  const store = readStore(repository.canonicalRoot);
  const grants = store.grants.map(expireGrant);
  const limit"""
replace_once('src/runtime/assistant/standing-grants.ts', old_list, new_list)
replace_once(
    'src/runtime/assistant/standing-grants.ts',
    "    grants: store.grants\n      .filter",
    "    grants\n      .filter",
)
replace_once(
    'src/runtime/assistant/standing-grants.ts',
    "        applied += 1;\n        results.push({",
    "        applied += 1;\n        byId.set(approved.proposalId, approved);\n        results.push({",
)

# Security regression coverage.
test = Path('tests/runtime/assistant-model-standing-grants.test.ts')
text = test.read_text()
text = text.replace(
    "import { analyzeAssistantMessages, assistantModelReadiness } from '../../src/runtime/assistant/model-provider';",
    "import { analyzeAssistantMessages, assistantModelReadiness, resolveAssistantModelConfig } from '../../src/runtime/assistant/model-provider';",
    1,
)
anchor = "  test('falls back safely when model output is unavailable or malformed', async () => {"
custom_test = """  test('does not forward vendor API keys to a custom model endpoint', () => {
    const config = resolveAssistantModelConfig({
      REPO_HARNESS_ASSISTANT_MODEL_PROVIDER: 'openai-compatible',
      REPO_HARNESS_ASSISTANT_MODEL_ENDPOINT: 'https://model.example.test/v1/chat/completions',
      REPO_HARNESS_ASSISTANT_MODEL: 'mail-model',
      OPENAI_API_KEY: 'must-not-be-forwarded',
    });
    expect(config.configured).toBe(false);
    expect(config.credentialSource).toBeUndefined();
    const dedicated = resolveAssistantModelConfig({
      REPO_HARNESS_ASSISTANT_MODEL_PROVIDER: 'openai-compatible',
      REPO_HARNESS_ASSISTANT_MODEL_ENDPOINT: 'https://model.example.test/v1/chat/completions',
      REPO_HARNESS_ASSISTANT_MODEL: 'mail-model',
      REPO_HARNESS_ASSISTANT_MODEL_API_KEY: 'dedicated-key',
    });
    expect(dedicated.configured).toBe(true);
    expect(dedicated.credentialSource).toBe('env:REPO_HARNESS_ASSISTANT_MODEL_API_KEY');
  });

"""
if anchor not in text:
    raise SystemExit('custom model endpoint test anchor missing')
text = text.replace(anchor, custom_test + anchor, 1)
old_safety = """    expect(() => createAssistantStandingGrant(controllerHome, repo, {
      pluginId: 'gmail', actionId: 'archive_message', confirmAuthorization: false,
      origin: { surface: 'mcp', actor: 'test' },
    })).toThrow('AUTHORIZATION_REQUIRED');"""
new_safety = """    expect(() => createAssistantStandingGrant(controllerHome, repo, {
      pluginId: 'gmail', actionId: 'archive_message', senderAllowlist: ['news@example.com'], confirmAuthorization: false,
      origin: { surface: 'mcp', actor: 'test' },
    })).toThrow('AUTHORIZATION_REQUIRED');
    expect(() => createAssistantStandingGrant(controllerHome, repo, {
      pluginId: 'gmail', actionId: 'archive_message', confirmAuthorization: true,
      origin: { surface: 'mcp', actor: 'test' },
    })).toThrow('SCOPE_REQUIRED');
    expect(() => createAssistantStandingGrant(controllerHome, repo, {
      pluginId: 'gmail', actionId: 'create_draft', routineIds: ['routine-1'], confirmAuthorization: true,
      origin: { surface: 'mcp', actor: 'test' },
    })).toThrow('SENDER_SCOPE_REQUIRED');"""
replace_once('tests/runtime/assistant-model-standing-grants.test.ts', old_safety, new_safety)
replace_once(
    'tests/runtime/assistant-model-standing-grants.test.ts',
    "        pluginId: 'gmail', actionId, confirmAuthorization: true,",
    "        pluginId: 'gmail', actionId, senderAllowlist: ['news@example.com'], confirmAuthorization: true,",
)
print('Hardened model credentials, grant scopes, protected messages, and duplicate application.')
