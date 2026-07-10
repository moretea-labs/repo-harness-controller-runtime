# 发布 npm 包

公开包名为 `@moretea-labs/repo-harness-controller`，安装后提供两个稳定命令：`repo-harness` 和 `repo-harness-hook`。

## 发布通道

- RC 使用 `1.4.0-rc.1` 这类版本和 npm `next` dist-tag。
- 稳定版使用 `1.4.0` 这类版本和 npm `latest` dist-tag。
- npm 包版本可以带 RC 后缀，但 `assets/skill-version.json` 保持对应的核心工作流版本。

用户安装当前 RC：

```bash
npm install -g @moretea-labs/repo-harness-controller@next
repo-harness --version
```

## 本地发布门禁

在干净 checkout 中执行：

```bash
npm ci --ignore-scripts
npm run check:release-readiness
npm pack --dry-run --json
```

门禁会检查包身份、直接依赖许可证声明、公开文档、tracked 文件卫生、MCP 兼容性、公开导出，以及隔离 tarball 安装。

## 首次发布与 npm 组织权限

首次发布必须使用能够管理 `@moretea-labs` scope 的 npm 账号。发布前先登录并确认身份：

```bash
npm login
npm whoami
npm access ls-packages @moretea-labs
npm run release:rc
```

不要为了绕过权限改发到个人 scope。若组织 scope 不存在或当前账号没有权限，应先创建 npm 组织或授予成员权限。

## Trusted Publishing

首个包存在后，在 npm 为 GitHub 仓库 `moretea-labs/repo-harness-controller-runtime` 和 workflow `release-rc.yml` 配置 Trusted Publishing。该 workflow 只能手动触发，必须输入精确确认值 `PUBLISH_RC`，通过 OIDC 获取发布身份，运行完整发布门禁，并且只允许带 RC 后缀的版本发布到 `next`。

仓库中不保存 npm token。Controller Home 运行时文件、OAuth 材料、本地 Job、密钥和生成 worktree 都不能进入 npm 包或公开源码导出。

## 发布后验证

发布完成后创建对应 Git tag，再执行验证：

```bash
npm view @moretea-labs/repo-harness-controller dist-tags --json
git tag v1.4.0-rc.1
git push origin v1.4.0-rc.1
npm run check:release-published
```

验证 RC 时不要移动 `latest`。只有稳定版决策完成后，才应明确执行 npm dist-tag 提升。
