## Cloudflare Deployment Notes

Use Cloudflare-native patterns for cloudflare-enabled plans:
- Workers for TanStack Start/Vite SSR webapps, API, webhook, and edge logic; deploy Start with `wrangler deploy`, not `wrangler pages deploy`
- Pages only for static/client-only assets or content shells that do not need Worker SSR
- One `apps/web` Worker for public landing plus `/app` workspace; split API/Agent/MCP Workers only when they own separate authority
- Keep edge vs node constraints explicit and prefer platform primitives over custom infra

---
