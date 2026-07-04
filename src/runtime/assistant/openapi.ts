export function assistantOpenApiSchema(baseUrl = 'http://127.0.0.1:8766'): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Repo Harness Local Personal Assistant API',
      version: '0.1.0',
      description: 'High-level ChatGPT Action surface for natural-language intents, routines, inbox, and guarded local execution.',
    },
    servers: [{ url: baseUrl }],
    components: {
      securitySchemes: {
        localControllerToken: {
          type: 'apiKey',
          in: 'header',
          name: 'x-repo-harness-local-token',
        },
      },
    },
    security: [{ localControllerToken: [] }],
    paths: {
      '/api/assistant/readiness': {
        get: {
          operationId: 'getAssistantReadiness',
          summary: 'Summarize which assistant capabilities are live, mock, disabled, or need configuration.',
          responses: { '200': { description: 'Assistant readiness report.' } },
        },
      },
      '/api/assistant/intent': {
        post: {
          operationId: 'submitAssistantIntent',
          summary: 'Submit a natural-language assistant intent or a ChatGPT-planned action list.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    utterance: { type: 'string' },
                    mode: { type: 'string', enum: ['plan_only', 'plan_then_execute', 'execute'] },
                    requestId: { type: 'string' },
                    timezone: { type: 'string' },
                    confirmRoutine: { type: 'boolean' },
                    context: { type: 'object', additionalProperties: true },
                    plan: {
                      type: 'array',
                      items: {
                        type: 'object',
                        required: ['pluginId', 'actionId'],
                        properties: {
                          stepId: { type: 'string' },
                          pluginId: { type: 'string' },
                          actionId: { type: 'string' },
                          arguments: { type: 'object', additionalProperties: true },
                          requestId: { type: 'string' },
                          confirmAuthorization: { type: 'boolean' },
                          confirmationText: { type: 'string' },
                        },
                      },
                    },
                    routine: { type: 'object', additionalProperties: true },
                  },
                },
              },
            },
          },
          responses: { '200': { description: 'Intent plan or submitted execution result.' } },
        },
      },
      '/api/assistant/routines': {
        get: { operationId: 'listAssistantRoutines', summary: 'List saved natural-language routines.', responses: { '200': { description: 'Routine list.' } } },
        post: { operationId: 'createAssistantRoutine', summary: 'Create a routine from a natural-language routine draft.', responses: { '201': { description: 'Created routine.' } } },
      },
      '/api/assistant/routines/{routineId}/run': {
        post: {
          operationId: 'runAssistantRoutineNow',
          summary: 'Run a routine immediately using safe read-only collection steps.',
          parameters: [{ name: 'routineId', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { '202': { description: 'Routine run submitted.' } },
        },
      },
      '/api/assistant/inbox': {
        get: { operationId: 'listAssistantInbox', summary: 'List assistant inbox items and routine outputs.', responses: { '200': { description: 'Inbox items.' } } },
      },
      '/api/assistant/self-test/gmail-read': {
        post: {
          operationId: 'runGmailReadSelfTest',
          summary: 'Submit a read-only Gmail list_messages self-test through the assistant intent layer.',
          requestBody: {
            required: false,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    query: { type: 'string' },
                    maxResults: { type: 'number' },
                    requestId: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: { '202': { description: 'Self-test execution plan submitted.' } },
        },
      },
      '/api/assistant/maintenance/cleanup-preview': {
        post: {
          operationId: 'previewRuntimeCleanup',
          summary: 'Preview stale repo-harness temp, terminal local job, and historical attention cleanup candidates.',
          responses: { '200': { description: 'Cleanup preview; non-destructive.' } },
        },
      },
      '/api/assistant/maintenance/cleanup-apply': {
        post: {
          operationId: 'applyRuntimeCleanup',
          summary: 'Apply safe cleanup candidates. Requires confirmCleanup=true.',
          responses: { '200': { description: 'Cleanup apply result.' } },
        },
      },
      '/api/assistant/memory': {
        get: { operationId: 'listAssistantMemory', summary: 'List local assistant memory entries.', responses: { '200': { description: 'Memory entries.' } } },
        post: { operationId: 'upsertAssistantMemory', summary: 'Save or update a local assistant memory entry.', responses: { '200': { description: 'Saved memory entry.' } } },
      },
    },
  };
}
