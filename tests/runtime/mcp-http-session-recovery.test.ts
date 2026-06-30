import { describe, expect, test } from 'bun:test';
import {
  mcpRequestError,
  mcpSessionLookupError,
  sendMcpRequestError,
  sendMcpSessionLookupError,
} from '../../src/cli/mcp/transports/http';

describe('MCP HTTP session recovery', () => {
  test('returns 400 when a non-initialize request omits the session id', () => {
    expect(mcpSessionLookupError(undefined)).toEqual({
      status: 400,
      body: {
        error: 'missing_session',
        code: 'MCP_SESSION_REQUIRED',
        message: 'Mcp-Session-Id header is required for this request.',
        recoverable: true,
        action: 'reinitialize',
      },
    });
    expect(mcpSessionLookupError('   ').status).toBe(400);
  });

  test('returns 404 for an unknown or expired session so the client can reinitialize', () => {
    expect(mcpSessionLookupError('expired-session')).toEqual({
      status: 404,
      body: {
        error: 'session_not_found',
        code: 'MCP_SESSION_EXPIRED',
        message: 'MCP session not found or expired; initialize a new session.',
        recoverable: true,
        action: 'reinitialize',
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
    expect(headers.get('Mcp-Session-Reset')).toBe('reinitialize');
    expect(headers.get('x-repo-harness-session-reset')).toBe('reinitialize');
    expect(body).toEqual({
      error: 'session_not_found',
      code: 'MCP_SESSION_EXPIRED',
      message: 'MCP session not found or expired; initialize a new session.',
      recoverable: true,
      action: 'reinitialize',
    });
  });

  test('keeps a valid session reusable after an isolated request failure', () => {
    expect(mcpRequestError(new Error('temporary failure'))).toEqual({
      status: 500,
      body: {
        error: 'request_failed',
        code: 'MCP_REQUEST_FAILED',
        message: 'temporary failure',
        recoverable: true,
        sessionPreserved: true,
        action: 'retry',
      },
    });

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
    } as unknown as Parameters<typeof sendMcpRequestError>[0];

    sendMcpRequestError(response, new Error('temporary failure'));

    expect(statusCode).toBe(500);
    expect(headers.get('Cache-Control')).toBe('no-store');
    expect(headers.get('x-repo-harness-session-preserved')).toBe('true');
    expect(body).toEqual(mcpRequestError(new Error('temporary failure')).body);
  });
});
