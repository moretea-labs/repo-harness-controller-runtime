from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if old not in text:
        raise SystemExit(f'anchor not found in {path}: {old[:140]!r}')
    file.write_text(text.replace(old, new, 1))

replace_once(
    'src/runtime/assistant/readiness.ts',
    "import { listAssistantInbox, listAssistantMemory, listAssistantRoutines } from './store';",
    "import { listAssistantInbox, listAssistantMemory, listAssistantRoutines } from './store';\nimport { assistantModelReadiness } from './model-provider';\nimport { listAssistantStandingGrants } from './standing-grants';",
)
replace_once(
    'src/runtime/assistant/readiness.ts',
    "    memoryEntries: number;\n  };",
    "    memoryEntries: number;\n    activeStandingGrants: number;\n  };\n  model: Record<string, unknown>;",
)
replace_once(
    'src/runtime/assistant/readiness.ts',
    "  const memory = listAssistantMemory(repository.canonicalRoot).entries;",
    "  const memory = listAssistantMemory(repository.canonicalRoot).entries;\n  const model = assistantModelReadiness();\n  const standingGrants = listAssistantStandingGrants(controllerHome, repository, { status: 'active', limit: 500 }).grants;",
)
replace_once(
    'src/runtime/assistant/readiness.ts',
    "    ...(memory.length === 0 ? ['Seed assistant memory with communication tone, work keywords, and default safety preferences.'] : []),",
    "    ...(memory.length === 0 ? ['Seed assistant memory with communication tone, work keywords, and default safety preferences.'] : []),\n    ...(model.configured !== true ? ['Configure the optional Assistant model provider for richer mail analysis; deterministic rules remain available.'] : []),",
)
replace_once(
    'src/runtime/assistant/readiness.ts',
    "      memoryEntries: memory.length,\n    },\n    recommendations,",
    "      memoryEntries: memory.length,\n      activeStandingGrants: standingGrants.length,\n    },\n    model,\n    recommendations,",
)

replace_once(
    'src/cli/local-bridge/server.ts',
    "import { approveAssistantActionProposal, listAssistantActionProposals, rejectAssistantActionProposal } from \"../../runtime/assistant/action-proposals\";",
    "import { approveAssistantActionProposal, listAssistantActionProposals, rejectAssistantActionProposal } from \"../../runtime/assistant/action-proposals\";\nimport { assistantModelReadiness } from \"../../runtime/assistant/model-provider\";\nimport { createAssistantStandingGrant, listAssistantStandingGrants, revokeAssistantStandingGrant } from \"../../runtime/assistant/standing-grants\";",
)
local_routes = '''  app.get("/api/assistant/model", (_request, response) => {
    response.json(assistantModelReadiness());
  });

  app.get("/api/assistant/standing-grants", (request, response) => {
    try {
      const repository = requestRepositorySelection(request, options, controllerHome);
      response.json(listAssistantStandingGrants(controllerHome, repository, {
        status: typeof request.query.status === "string" ? request.query.status as any : undefined,
        limit: Number(request.query.limit) || undefined,
      }));
    } catch (error) { response.status(400).json({ error: errorMessage(error) }); }
  });

  app.post("/api/assistant/standing-grants", (request, response) => {
    try {
      const repository = requestRepositorySelection(request, options, controllerHome);
      response.status(201).json({ grant: createAssistantStandingGrant(controllerHome, repository, {
        name: queryString(request.body?.name),
        pluginId: queryString(request.body?.pluginId) ?? "",
        actionId: queryString(request.body?.actionId) ?? "",
        routineIds: Array.isArray(request.body?.routineIds) ? request.body.routineIds : undefined,
        senderAllowlist: Array.isArray(request.body?.senderAllowlist) ? request.body.senderAllowlist : undefined,
        subjectContains: Array.isArray(request.body?.subjectContains) ? request.body.subjectContains : undefined,
        minConfidence: typeof request.body?.minConfidence === "number" ? request.body.minConfidence : undefined,
        maxPerRun: typeof request.body?.maxPerRun === "number" ? request.body.maxPerRun : undefined,
        expiresInDays: typeof request.body?.expiresInDays === "number" ? request.body.expiresInDays : undefined,
        confirmAuthorization: request.body?.confirmAuthorization === true,
        origin: { surface: "local-ui", actor: "assistant-standing-grant-api" },
      }) });
    } catch (error) { response.status(400).json({ error: errorMessage(error) }); }
  });

  app.post("/api/assistant/standing-grants/:grantId/revoke", (request, response) => {
    try {
      const repository = requestRepositorySelection(request, options, controllerHome);
      response.json({ grant: revokeAssistantStandingGrant(controllerHome, repository, {
        grantId: request.params.grantId,
        reason: queryString(request.body?.reason),
        confirmAuthorization: request.body?.confirmAuthorization === true,
        origin: { surface: "local-ui", actor: "assistant-standing-grant-api" },
      }) });
    } catch (error) { response.status(400).json({ error: errorMessage(error) }); }
  });

'''
replace_once('src/cli/local-bridge/server.ts', '  app.get("/api/assistant/proposals", (request, response) => {', local_routes + '  app.get("/api/assistant/proposals", (request, response) => {')

replace_once(
    'src/runtime/gateway/mcp/runtime-tools.ts',
    "import { approveAssistantActionProposal, getAssistantActionProposal, listAssistantActionProposals, rejectAssistantActionProposal } from '../../assistant/action-proposals';",
    "import { approveAssistantActionProposal, getAssistantActionProposal, listAssistantActionProposals, rejectAssistantActionProposal } from '../../assistant/action-proposals';\nimport { assistantModelReadiness } from '../../assistant/model-provider';\nimport { createAssistantStandingGrant, listAssistantStandingGrants, revokeAssistantStandingGrant } from '../../assistant/standing-grants';",
)
definitions = '''  definition('assistant_model_readiness', 'Read the optional bounded Assistant model provider configuration without returning secrets.', {
    repo_id: repoId,
  }),
  definition('assistant_standing_grants', 'List scoped, expiring Assistant Standing Grants.', {
    repo_id: repoId,
    status: { type: 'string', enum: ['active', 'revoked', 'expired'] },
    limit: { type: 'number' },
  }),
  definition('assistant_standing_grant_create', 'Create an explicitly authorized Standing Grant for a hardcoded low-risk action.', {
    repo_id: repoId,
    name: { type: 'string' },
    plugin_id: { type: 'string' },
    action_id: { type: 'string' },
    routine_ids: { type: 'array', items: { type: 'string' } },
    sender_allowlist: { type: 'array', items: { type: 'string' } },
    subject_contains: { type: 'array', items: { type: 'string' } },
    min_confidence: { type: 'number' },
    max_per_run: { type: 'number' },
    expires_in_days: { type: 'number' },
    confirm_authorization: { type: 'boolean' },
  }, ['plugin_id', 'action_id', 'confirm_authorization'], false),
  definition('assistant_standing_grant_revoke', 'Revoke a Standing Grant with explicit authorization.', {
    repo_id: repoId,
    grant_id: { type: 'string' },
    reason: { type: 'string' },
    confirm_authorization: { type: 'boolean' },
  }, ['grant_id', 'confirm_authorization'], false),
'''
replace_once('src/runtime/gateway/mcp/runtime-tools.ts', "  definition('assistant_action_proposals'", definitions + "  definition('assistant_action_proposals'")
cases = '''      case 'assistant_model_readiness': {
        return result(assistantModelReadiness());
      }
      case 'assistant_standing_grants': {
        const repository = selected(ctx, args);
        return result(listAssistantStandingGrants(ctx.controllerHome, repository, {
          status: typeof args.status === 'string' ? args.status as any : undefined,
          limit: typeof args.limit === 'number' ? args.limit : undefined,
        }));
      }
      case 'assistant_standing_grant_create': {
        const repository = selected(ctx, args);
        return result({ grant: createAssistantStandingGrant(ctx.controllerHome, repository, {
          name: typeof args.name === 'string' ? args.name : undefined,
          pluginId: String(args.plugin_id ?? '').trim(),
          actionId: String(args.action_id ?? '').trim(),
          routineIds: Array.isArray(args.routine_ids) ? args.routine_ids.map(String) : undefined,
          senderAllowlist: Array.isArray(args.sender_allowlist) ? args.sender_allowlist.map(String) : undefined,
          subjectContains: Array.isArray(args.subject_contains) ? args.subject_contains.map(String) : undefined,
          minConfidence: typeof args.min_confidence === 'number' ? args.min_confidence : undefined,
          maxPerRun: typeof args.max_per_run === 'number' ? args.max_per_run : undefined,
          expiresInDays: typeof args.expires_in_days === 'number' ? args.expires_in_days : undefined,
          confirmAuthorization: args.confirm_authorization === true,
          origin: { surface: 'mcp', actor: 'assistant_standing_grant_create' },
        }) });
      }
      case 'assistant_standing_grant_revoke': {
        const repository = selected(ctx, args);
        return result({ grant: revokeAssistantStandingGrant(ctx.controllerHome, repository, {
          grantId: String(args.grant_id ?? '').trim(),
          reason: typeof args.reason === 'string' ? args.reason : undefined,
          confirmAuthorization: args.confirm_authorization === true,
          origin: { surface: 'mcp', actor: 'assistant_standing_grant_revoke' },
        }) });
      }
'''
replace_once('src/runtime/gateway/mcp/runtime-tools.ts', "      case 'assistant_action_proposals': {", cases + "      case 'assistant_action_proposals': {")
replace_once(
    'src/cli/mcp/toolset-names.ts',
    "  'assistant_action_proposals',",
    "  'assistant_model_readiness',\n  'assistant_standing_grants',\n  'assistant_standing_grant_create',\n  'assistant_standing_grant_revoke',\n  'assistant_action_proposals',",
)
print('Applied Assistant model readiness and Standing Grant API integration.')
