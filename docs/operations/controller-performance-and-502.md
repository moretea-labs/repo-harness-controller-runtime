# Controller Performance and 502 Troubleshooting

This guide covers slow MCP calls, repeated reconnects, proxy `502` responses and Local Controller UI stalls.

## What a 502 Means

A `502` is normally emitted by the HTTPS tunnel or reverse proxy when it cannot obtain a valid response from the local MCP process. It is not proof that an accepted durable Job failed. Check the Job or Run record before retrying a write operation.

## Runtime Protections

The MCP HTTP runtime now uses:

- one shared Controller context across sessions;
- one global pool of at most 64 retained MCP sessions across all three HTTP paths;
- 15-minute idle expiry, a 30-minute SSE lease and a two-hour absolute session lifetime;
- DELETE cleanup and same-client reconnect supersession;
- oldest-safe stream-only eviction under capacity pressure, while active POST work remains protected;
- at most 8 simultaneous session initializations;
- at most 4 active POST requests per session and 32 globally;
- `429`/`503` overload responses with `Retry-After`;
- a 1 MB MCP request-body limit;
- 65-second keep-alive and 70-second header timeout;
- periodic transport cleanup during runtime and full cleanup on shutdown.
- an isolated stable-ingress child process so long-lived proxy sockets do not share the Supervisor control event loop.

These limits prevent reconnect storms and long-running clients from causing unbounded memory, file scanning or open-transport growth.

## Health Check

Call `GET /health` on the local MCP endpoint. The response includes:

- tool-surface identity and schema version;
- active and maximum session counts;
- initializing, active POST and active SSE stream counts;
- available capacity, utilization, evictable/protected counts and oldest stream/POST ages;
- close-reason counters for DELETE, supersession, lease/lifetime expiry and capacity eviction;
- overload rejection count;
- authentication configuration status.

A growing `rejectedOverload` value with no matching capacity-eviction or close activity means clients are submitting protected work faster than the Controller can accept it. A pool full of stream-only sessions should now self-recover. Retrying with backoff is preferable to increasing every limit.

Call `GET /ready` separately. A 503 from `/ready` with `/health` still returning 200 means the process is live but cannot safely admit another initialize. `sessionCapacity.recoveryRecommended=false` preserves active work and waits; `true` allows the Supervisor's bounded recovery policy after the configured stall limit.

## Diagnostic Order

1. Confirm the local process answers `/health` directly on `127.0.0.1`.
2. Confirm the public tunnel points to the current local port and protocol.
3. Compare tool-surface headers with the expected Controller profile.
4. Inspect active Jobs and Runs instead of repeating a potentially accepted mutation.
5. Check whether a heavy named check or repository command is already running.
6. Compare `sessions.active`, `capacityAvailable`, `evictable`, `protected`, `oldestStreamAgeMs` and close counters. A full stream-only pool without eviction indicates a regression.
7. Restart only after `/ready` recommends bounded recovery or liveness fails, and only after durable state has been inspected; do not delete `.ai/harness` to recover from a connection problem.

## Slow Local UI

The dashboard uses one shared state poller regardless of browser-tab count. Snapshot requests are reused for a short window, and historical Agent Jobs/Edit Sessions are limited before their JSON files are parsed. If the UI remains slow, inspect exceptionally large Issue files or unbounded event logs rather than deleting workflow state.

## Safe Cleanup

Safe source-distribution exclusions:

- `node_modules/`;
- `.git/` when producing a portable source archive;
- `.codegraph/`;
- `.ai/` runtime state in a clean distribution archive;
- `_ops/`, coverage, logs and temporary package files.

Do not remove source, tests, architecture documents, task history or workflow templates merely to reduce archive size.
