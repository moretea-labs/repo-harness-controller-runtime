# Open-source release hygiene

Short checklist before publishing source or npm artifacts from this repository.

## Do not ship

- `_ops/`, `.ai/harness` runtime state, controller home checkouts
- `.repo-harness/*.local.json`, tokens, OAuth, grants, plugin runtime JSON
- Personal absolute paths (`/Users/<name>/…`, `/home/<name>/…`)
- Real `repo_*` / `checkout_*` binding ids
- Real Tailscale hostnames or CGNAT addresses bound to a maintainer machine
- Credentials, private keys, `.env` files

## Commands

```bash
# Tracked-file audit (paths + finding class only; match values never printed)
bash scripts/check-open-source-tracked-surface.sh

# Public allowlist export + content scanners
bun run check:public-export

# Combined release-readiness gate for tool surface + hygiene
bash scripts/check-release-readiness.sh
```

Justified historical hits can be listed in `scripts/open-source-audit-allowlist.txt`. Prefer scrubbing new files over expanding the allowlist.

## Package exclusions

`.gitignore` and `.npmignore` exclude runtime/plugin grants, tokens, `_ops`, research/tasks/plans noise, and key material patterns. Re-run the audit after adding new paths under `.repo-harness/` or docs with machine-local examples.
