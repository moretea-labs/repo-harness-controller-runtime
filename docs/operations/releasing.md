# Releasing the npm package

The public package identity is `@moretea-labs/repo-harness-controller`. It installs two stable command names: `repo-harness` and `repo-harness-hook`.

## Release channels

- Release candidates use versions such as `1.4.0-rc.1` and the npm `next` dist-tag.
- Stable releases use versions such as `1.4.0` and the npm `latest` dist-tag.
- The package version may carry an RC suffix, while `assets/skill-version.json` keeps the matching core workflow version.

Users install the current RC with:

```bash
npm install -g @moretea-labs/repo-harness-controller@next
repo-harness --version
```

## Local release gate

From a clean checkout, run:

```bash
npm ci --ignore-scripts
npm run check:release-readiness
npm pack --dry-run --json
```

The gate validates package identity, direct dependency notices, public documentation, tracked-file hygiene, MCP compatibility, the public export, and an isolated tarball installation.

## First publication and npm ownership

The first publication requires an npm account that controls the `@moretea-labs` scope. Authenticate locally and confirm the identity before publishing:

```bash
npm login
npm whoami
npm access ls-packages @moretea-labs
npm run release:rc
```

Do not publish from a personal scope as a fallback. If the organization scope does not exist or the account lacks permission, create or grant the npm organization membership first.

## Trusted Publishing

After the first package exists, configure npm Trusted Publishing for the GitHub repository `moretea-labs/repo-harness-controller-runtime` and workflow `release-rc.yml`. The workflow is manual-only, requires the exact confirmation value `PUBLISH_RC`, requests an OIDC token, runs the complete release gate, and publishes only an RC version with the `next` tag.

No npm token is stored in the repository. Repository secrets, Controller Home runtime files, OAuth material, local jobs, and generated worktrees must never enter the package or public source export.

## Post-publication verification

After publication, create the matching Git tag and run:

```bash
npm view @moretea-labs/repo-harness-controller dist-tags --json
git tag v1.4.0-rc.1
git push origin v1.4.0-rc.1
npm run check:release-published
```

Do not move `latest` while validating an RC. Promote a tested version deliberately with npm dist-tag commands only after the stable release decision.
