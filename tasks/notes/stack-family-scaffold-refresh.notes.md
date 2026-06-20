# Stack-family Scaffold Refresh

Updated the repo-harness scaffold guidance from product/domain plan labels to
stack-family routing. The durable public codes remain A-K, but they now select
frontend shell, backend/runtime boundary, deployment target, data authority, and
sidecar family.

Key decisions:

- Keep `repo-harness` canonical and `repo-harness-skill` as the compatibility
  trigger/runtime fallback.
- Treat `project-initializer` as a retired migration input only, not an active
  skill root or public alias.
- Expose scaffold as `repo-harness-scaffold` for new project/module creation;
  existing repo adoption stays on init/migrate/upgrade/repair.
- Prefer Astro SSR/content shells, Vite 8 rich client surfaces, shared
  Bun/Hono monorepos, Cloudflare web/edge delivery, and VPS-hosted agent
  runtimes when Node APIs, local tools, long-lived processes, or heavier
  sidecars are required.
- Keep D1 opt-in. Prefer Postgres/Supabase for durable authority and
  SQLite/Turso/libSQL, including Turso Sync for new local-first sync work, for
  lightweight or local-first cases.
