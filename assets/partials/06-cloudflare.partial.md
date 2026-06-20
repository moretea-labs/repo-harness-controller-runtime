## Cloudflare Deployment (Concise Index)

Choose runtime:
- `Workers` for TanStack Start/Vite SSR webapps, API/webhook/edge logic, and Worker assets
- `Pages` for static/client-only assets or content shells that do not need Worker SSR
- `Containers` for Python/ML or heavy dependencies

Recommended combinations:
- Public landing + authenticated workspace: one `apps/web` Worker (`/` SSR, `/app` client-only)
- Client-only frontend: `Pages` or Worker static assets by explicit deploy target
- Frontend + backend runtime: `apps/web` Worker plus separate API/Agent/MCP Workers only when those own authority
- Full edge stack: Workers + R2/KV/Queues/Durable Objects plus explicit SQL authority
- AI app: `Workers + AI Gateway + Workers AI + Vectorize`

TanStack Start on Cloudflare uses `@cloudflare/vite-plugin`, `wrangler.jsonc`,
Worker assets, and `wrangler deploy`; do not use `wrangler pages deploy` for the
Start SSR app.

Deep docs:
- `docs/reference-configs/harness-overview.md`
