import { describe, expect, test } from 'bun:test';
import {
  mcpSessionLookupError,
  sendMcpSessionLookupError,
} from '../../src/cli/mcp/transports/http';

describe('MCP HTTP session recovery', () => {
  test('returns 400 when a non-initialize request omits the session id', () => {
    expect(mcpSessionLookupError(undefined)).toEqual({
      status: 400,
      body: {
        error: 'missing_session',
        message: 'Mcp-Session-Id header is required for this request.',
      },
    });
    expect(mcpSessionLookupError('   ').status).toBe(400);
  });

  test('returns 404 for an unknown or expired session so the client can reinitialize', () => {
    expect(mcpSessionLookupError('expired-session')).toEqual({
      status: 404,
      body: {
        error: 'session_not_found',
        message: 'MCP session not found or expired; initialize a new session.',
      },
    });
  });

  test('marks session lookup errors as non-cacheable', () => {
    let statusCode: number | undefined;
    let body: unknown;
    const headers = new Map<string, string>();
    const response = {
      setHeader(name: string, value: string) {
        headers.set(name, value);
        return response;
      },
      status(value: number) {
        statusCode = value;
        return response;
      },
      json(value: unknown) {
        body = value;
        return response;
      },
    } as unknown as Parameters<typeof sendMcpSessionLookupError>[0];

    sendMcpSessionLookupError(response, 'stale-session');

    expect(statusCode).toBe(404);
    expect(headers.get('Cache-Control')).toBe('no-store');
    expect(body).toEqual({
      error: 'session_not_found',
      message: 'MCP session not found or expired; initialize a new session.',
    });
  });
});
