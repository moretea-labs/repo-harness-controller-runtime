# Technology Stack Reference

This reference describes scaffold stack families, not product categories. Pick
the plan by frontend shell, backend/runtime boundary, deployment target, data
authority, and sidecar needs. Product domains such as finance, CRM, Web3,
healthcare, commerce, and internal operations are overlays on these stacks.

## Quick Decision Tree

### Core Plans (A-F)

```text
Start -> What stack boundary changes the scaffold most?
|
|-- Astro SSR/content/docs shell?
|   `-- Plan A: Astro-first SSR/content shell
|
|-- Rich client-only React app?
|   `-- Plan B: Vite 8 client-only app shell
|
|-- One React webapp needs public SEO/SSR plus a client-heavy workspace?
|   `-- Plan C: TanStack Start + Vite + Cloudflare Workers
|
|-- Shared frontend/backend contracts in one repo?
|   `-- Plan D: Bun workspace monorepo with Hono gateway
|
|-- Cloudflare web/edge delivery is the primary deployment shape?
|   `-- Plan E: Workers SSR/static assets/R2/KV/Queues/DO plus external SQL
|
|-- Mobile or realtime companion surface?
|   `-- Plan F: Expo Router / React Native New Architecture
|
`-- Need a sidecar/runtime family?
    `-- Choose Custom Presets (G-K)
```

### Custom Presets (G-K)

Use these as sidecar/runtime families, not domain presets:

- Plan G: Python research/data/agent sidecar
- Plan H: Go high-concurrency or financial sidecar
- Plan I: Local-first or lightweight SQL stack
- Plan J: Rust native/performance sidecar
- Plan K: Fully custom stack-family composition

## Default Policy

- Do not default to Next.js. If a React webapp needs public SEO/SSR plus an
  authenticated workspace, prefer TanStack Start + Vite on Cloudflare Workers
  first.
- Prefer a shared monorepo over disconnected frontend/backend repos. Use Bun
  workspaces by default; add Turborepo only when repo scale needs orchestration.
- Prefer Cloudflare for web and edge delivery: Workers for TanStack Start SSR
  webapps, Pages only for static/client-only assets or content shells, and R2,
  KV, Queues, Durable Objects, and Hyperdrive where they fit.
- Do not default to D1. Use Postgres/Supabase for durable authority and
  SQLite/Turso/libSQL for lightweight, local-first, edge, or embedded workloads.
- Keep agent runtimes on VPS when they need stable Node APIs, local tools,
  long-lived processes, heavier sidecars, or predictable filesystem/process
  behavior. Put them behind a Hono gateway.
- Treat MCP servers, model providers, and agent frameworks as tool/runtime
  layers. They do not own product authority.
- Treat object storage, queues, Redis, vector stores, ClickHouse,
  Temporal/Inngest/BullMQ/Trigger.dev, and OpenTelemetry as opt-in capability
  boundaries, not mandatory defaults.

## Plan A: Astro-first SSR/content shell

Use when the main shell is SSR, docs, content, SEO, public product pages, or a
mostly-static app with small interactive islands.

Default stack:

- Astro + TypeScript
- Astro content collections for docs/blog/reference material
- React islands only where interaction justifies the runtime
- Cloudflare Pages/Workers or Node adapter depending on SSR/runtime needs
- Postgres/Supabase or SQLite/Turso by workload

Avoid turning Plan A into the dense agent console. If the product needs heavy
interactive state, add Plan B/D surfaces in the same monorepo.

## Plan B: Vite 8 client-only app shell

Use when the core surface is a dense, interactive React app that does not need
crawler-visible SSR landing HTML.

Default stack:

- Vite 8 + React + TypeScript
- TanStack Router + TanStack Query
- shadcn/Radix-style components + Tailwind CSS
- Zustand/Jotai only for local UI state that is not server cache
- Postgres/Supabase for durable authority, or SQLite/Turso for lightweight cases

This is the default shell for runtime consoles, internal tools, admin surfaces,
dashboards, and agent-visible app state. If the same product needs public
landing SEO/SSR and authenticated workspace routes, use Plan C instead of
scaffolding separate `apps/marketing` and `apps/web` frontend deploys.

## Plan C: TanStack Start Workers webapp

Use when the React webapp itself needs public SEO/SSR and an authenticated or
browser-heavy app workspace in one frontend deployment.

Default stack:

- TanStack Start + Vite + React
- React + TanStack Query + typed route/server contracts
- Cloudflare Workers with `@cloudflare/vite-plugin`, Worker assets,
  `wrangler.jsonc`, and `wrangler deploy`
- `/` as SSR/prerender-capable landing route with title/meta/OG/canonical
- `/app` as route-level client-only boundary with `ssr: false`; lazy-load
  browser-only/WebGL components inside the client route
- One deployable frontend component under `apps/web`
- Next.js is not the default recommendation

If Start + Workers fails a thin scaffold gate, evaluate Vike or React Router
Framework Mode as an explicit fallback. Do not make the fallback a default
`apps/marketing` + `apps/web` split. If SSR is only for marketing/docs/content,
use Plan A instead. If backend authority is substantial, use Plan D and keep the
gateway explicit.

## Plan D: Shared frontend/backend monorepo

Use when frontend, backend, contracts, workers, and sidecars should evolve
together.

Default stack:

- Bun workspaces
- Apps: one `apps/web` frontend by default; API, Agent, MCP, Expo companion, or
  admin surfaces only when they own separate runtime authority
- Services: Hono gateways, workers, and sidecars
- Packages: contracts, UI, data access, tool adapters, test fixtures
- Optional Turborepo only when build graph orchestration is worth the cost

This is the preferred shape for AI-native systems that need shared contracts
between UI, gateway, tool adapters, approvals, artifacts, and sidecars.

## Plan E: Cloudflare edge web stack

Use when the web delivery shape is Cloudflare-first.

Default stack:

- Cloudflare Workers for TanStack Start/Vite SSR webapps
- Cloudflare Pages for static/client-only assets or content shells only
- R2 for object storage
- KV for small edge lookup data
- Queues for async work
- Durable Objects for coordination/stateful edge primitives
- Hyperdrive where Cloudflare-to-Postgres connectivity matters
- Postgres/Supabase or SQLite/Turso for SQL authority

D1 is opt-in only. Do not choose it by default for cost-sensitive or agent-heavy
workloads. Agent runtimes that need Node compatibility, local tools, long-lived
workers, or heavier sidecars should run on VPS behind the Hono gateway.

## Plan F: Mobile/realtime companion

Use when the scaffold needs a mobile surface or realtime media companion.

Default stack:

- Expo Router + React Native New Architecture
- NativeWind when Tailwind-style styling is useful
- TanStack Query + bounded local state
- Shared Hono/API boundary or Supabase/Postgres backend
- Explicit realtime, voice, media, and permission boundaries when needed

## Plan G: Python research/data/agent sidecar

Use for research pipelines, data work, eval jobs, model-framework code, and
Python-owned agent runtimes.

Default stack:

- `uv`
- FastAPI or Pydantic AI
- DuckDB + Polars
- Artifact storage and reproducible run outputs
- Hono gateway owns app-facing auth, run IDs, tools, approvals, and telemetry

Plan G still enables the factor-lab scaffold for research workflows. For pure
product finance domains, prefer treating finance as a domain overlay rather
than assuming Plan G is required.

## Plan H: Go high-concurrency or financial sidecar

Use when a narrow sidecar needs high concurrency, market data handling,
FIX/RFQ-style adapters, fan-out, infra integration, or operational simplicity.

Default stack:

- Go/Gin or narrow Go workers
- Hono gateway for product-facing contracts and auth
- Postgres/Supabase for durable authority
- Queues/streams only when the capability needs them

Go works well next to TypeScript because it can stay behind a clear HTTP/MCP
boundary without taking over app authority.

## Plan I: Local-first or lightweight SQL stack

Use when the main constraint is local-first state, embedded data, edge-light SQL,
or sync ownership.

Default stack:

- SQLite or Turso/libSQL
- Turso Sync for new local-first sync work; explicit replication, conflict, and
  ownership contracts
- Loro/CRDT only when collaborative document state requires it
- Hono or existing app API boundary

Keep local-first document state separate from TanStack Query server cache and
from UI chrome state.

## Plan J: Rust native/performance sidecar

Use when community-proven Rust strengths matter enough to justify the team cost.

Default stack:

- Rust for parsers, indexing, sandboxing, native kernels, and low-latency tools
- MCP tools or narrow HTTP jobs behind Hono
- OpenTUI/Ink or Vite IDE surface only when the sidecar has a user-visible tool
  workflow

Rust should stay a sidecar/kernel until the team is confident maintaining it as
the primary product runtime.

## Plan K: Fully custom composition

Use when the stack cannot be expressed as A-J plus overlays. A good custom plan
still states:

- frontend shell
- gateway/runtime boundary
- data authority
- deployment target
- sidecar languages and protocols
- observability and approval boundaries

## AI-Native Scaffold Profiles

AI-native scaffold selection is an overlay on the A-K stack-family catalog, not
a new lettered plan.

| Profile | Use case | Default boundary |
|---------|----------|------------------|
| `none` | Normal app | Use the selected A-K family unchanged |
| `chat-agent` | AI chat, RAG, or help assistant | assistant-ui or AI SDK stream over the existing API |
| `collaborative-editor` | AI-aware documents, CMS, or knowledge workspace | Vite app + editor primitives + explicit sync contracts |
| `runtime-console` | Trace/replay/prompt playground/approval console | assistant-ui + AG-UI + Bun/Hono gateway |
| `product-copilot` | In-app copilot | CopilotKit or assistant-ui headless + AG-UI business actions |
| `workflow-agent` | Workflow/DAG builder | React Flow/xyflow + Monaco + AG-UI workflow events |
| `generative-ui-agent` | Agent-generated forms/cards/tables | Safe React registry; A2UI remains experimental |
| `browser-agent` | Browser automation/RPA workbench | AG-UI browser-run events with Playwright/Browserbase/Stagehand worker |
| `research-agent` | Evidence/report workspace | assistant-ui + artifacts + optional Python research pipeline |
| `coding-agent` | Repo/PR/DevOps agent | assistant-ui + Monaco/diff/terminal panels + optional MCP tools |
| `enterprise-agent-platform` | Multi-tenant agent platform | Astro docs shell + Vite app surfaces + Hono gateway |
| `voice-agent` | Realtime voice or call assistant | WebRTC/media boundary with AG-UI side-channel |
| `sidecar-kernel` | Python/Go/Rust kernels | Bun/Hono gateway with MCP or narrow HTTP sidecars |

Generated structure overlays currently exist for:

- `assets/project-structures/ai-native-runtime-console.txt`
- `assets/project-structures/ai-native-product-copilot.txt`
- `assets/project-structures/ai-native-collaborative-editor.txt`
- `assets/project-structures/ai-native-sidecar-kernel.txt`

## AI Runtime Defaults

- assistant-ui is the default React chat/agent UI runtime.
- AI SDK is useful for provider abstraction, simple tool streaming, and UI
  stream helpers. It is not the whole orchestration layer by itself.
- AG-UI is the event protocol for complex runtime UIs that need runs, tools,
  shared state, interrupts, approvals, replay, artifacts, or multimodal updates.
- Bun/Hono owns the app-facing agent gateway unless an existing backend already
  owns that boundary.
- OpenAI Agents SDK, Mastra, LangGraph, Pydantic AI, or a custom runner should
  be selected only when the product needs multi-step state, handoffs, memory,
  evals, approvals, or durable execution.
- MCP tools and sidecars stay behind contracts. They should not become product
  authority.
