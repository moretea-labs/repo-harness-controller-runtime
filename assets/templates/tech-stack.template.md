<!-- Generation: Populate from Q2 (Project Type) tech stack selection -->
# {{PROJECT_NAME}} - 技术栈

## 架构概览

| 层级 | 技术选型 | 版本 | 选择理由 |
|------|----------|------|----------|
{{TECH_STACK_TABLE_DETAILED}}

## 关键依赖

### 核心框架
{{CORE_DEPENDENCIES}}

{{#IF WEBAPP_RENDERING_MODEL_ENABLED}}
## Webapp Rendering Model

{{WEBAPP_RENDERING_TECH_STACK_SECTION}}

### Boundary Rules

- Use one deployable frontend component under `apps/web` for SaaS webapps that need public SEO/SSR plus an authenticated workspace.
- `/` should be SSR/prerender-capable when public landing SEO matters.
- `/app` should be client-only when it contains browser-only, WebGL, tenant workspace, or authenticated runtime state.
- TanStack Start on Cloudflare deploys through Workers and `wrangler deploy`; Pages/static deploy is for client-only or content/static surfaces.
- Keep backend Workers separate only when they own API, Agent, MCP, queue, storage, or sidecar runtime authority.

{{/IF}}
{{#IF AI_NATIVE_PROFILE_ENABLED}}
## AI-Native Profile

{{AI_NATIVE_TECH_STACK_SECTION}}

### Boundary Rules

- AG-UI is the user-visible event transport, not a replacement for app-domain contracts.
- Bun/Hono owns the app-facing agent gateway unless an existing backend already owns that boundary.
- Python, Go, and Rust sidecars stay behind MCP tools or narrow HTTP jobs; they do not own the UI protocol.
- A2UI is experimental payload/schema material unless the product explicitly chooses it.
- OpenTelemetry GenAI spans and event names are prepared as local conventions while upstream semantic conventions remain moving.

{{/IF}}
### 开发工具
{{DEV_TOOLS}}

## 部署方案 / Deployment
{{DEPLOYMENT_PLAN}}

## 成本预估 / Cost Estimation

| 服务 Service | 免费层 Free Tier | 月成本 (1K MAU) | 月成本 (10K MAU) |
|--------------|------------------|-----------------|------------------|
{{COST_ESTIMATION_TABLE}}

---
*Generated: {{DATE}}*
*Plan: {{PLAN_TYPE}}*
