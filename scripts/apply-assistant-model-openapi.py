from pathlib import Path

path = Path('src/runtime/assistant/openapi.ts')
text = path.read_text()
anchor = "      '/api/assistant/proposals': {"
if anchor not in text:
    raise SystemExit('OpenAPI proposal anchor not found')
routes = '''      '/api/assistant/model': {
        get: {
          operationId: 'getAssistantModelReadiness',
          summary: 'Read bounded Assistant model readiness without returning secrets.',
          responses: { '200': { description: 'Assistant model readiness.' } },
        },
      },
      '/api/assistant/standing-grants': {
        get: {
          operationId: 'listAssistantStandingGrants',
          summary: 'List scoped, expiring Standing Grants.',
          responses: { '200': { description: 'Standing Grants.' } },
        },
        post: {
          operationId: 'createAssistantStandingGrant',
          summary: 'Create an explicitly authorized Standing Grant for a hardcoded low-risk action.',
          requestBody: {
            required: true,
            content: { 'application/json': { schema: {
              type: 'object', required: ['pluginId', 'actionId', 'confirmAuthorization'],
              properties: {
                name: { type: 'string' }, pluginId: { type: 'string' }, actionId: { type: 'string' },
                routineIds: { type: 'array', items: { type: 'string' } },
                senderAllowlist: { type: 'array', items: { type: 'string' } },
                subjectContains: { type: 'array', items: { type: 'string' } },
                minConfidence: { type: 'number', minimum: 0, maximum: 1 },
                maxPerRun: { type: 'integer', minimum: 1, maximum: 50 },
                expiresInDays: { type: 'integer', minimum: 1, maximum: 365 },
                confirmAuthorization: { type: 'boolean' },
              },
            } } },
          },
          responses: { '201': { description: 'Standing Grant created.' } },
        },
      },
      '/api/assistant/standing-grants/{grantId}/revoke': {
        post: {
          operationId: 'revokeAssistantStandingGrant',
          summary: 'Revoke a Standing Grant with explicit authorization.',
          parameters: [{ name: 'grantId', in: 'path', required: true, schema: { type: 'string' } }],
          requestBody: { required: true, content: { 'application/json': { schema: {
            type: 'object', required: ['confirmAuthorization'],
            properties: { reason: { type: 'string' }, confirmAuthorization: { type: 'boolean' } },
          } } } },
          responses: { '200': { description: 'Standing Grant revoked.' } },
        },
      },
'''
path.write_text(text.replace(anchor, routes + anchor, 1))
print('Applied Assistant model and Standing Grant OpenAPI integration.')
