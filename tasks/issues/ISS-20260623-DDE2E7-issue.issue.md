---
id: "ISS-20260623-DDE2E7"
kind: "governance"
status: "in_progress"
updated_at: "2026-06-24T07:20:22.522Z"
source: "repo-harness-controller-v8"
---

# 开源发布治理、版本线与分支整理

将当前 repo-harness-controller-runtime 从内部演进工作区整理为可公开发布的 MIT 衍生项目：审计本地/远程分支和标签，区分产品版本与 Controller 协议版本，确认上游许可与代码来源，清理私有信息，完善中英文使用/部署/ChatGPT 连接文档与品牌素材，最后形成安全的 GitHub 开源发布路径。

## Goals

- 建立本地与远程分支、标签、提交差异的可审计清单
- 制定不误导用户的版本策略，明确 v8/v8.1 协议代际与 npm/package 版本的关系
- 满足 MIT 衍生项目的版权、归属和 NOTICE 要求
- 完成开源前敏感信息、绝对路径、内部凭据和运行产物清理
- 提供安装、功能、命令、Grok 反代、Cloudflare 自定义域名、ChatGPT MCP 连接和固定 repoId 的完整教程
- 补齐 README 顶部 banner、架构图和项目宣传文案
- 在验证通过后整理发布分支并准备 GitHub 公开发布

## Non-goals

- 审计阶段不删除本地或远程分支
- 不改写已推送提交历史
- 不在秘密扫描和来源审计通过前将仓库设为公开
- 不删除 AncientTwo 的 MIT 版权声明
- 不承诺 ChatGPT 平台支持跨所有项目的全局固定 repoId；以项目指令和连接器仓库注册能力为准

## Acceptance Criteria

- [ ] 产出分支/标签/远程差异报告并标明可保留、可归档、候选删除项
- [ ] 版本策略文档明确 package 版本、Controller tool-surface 版本和兼容性规则
- [ ] LICENSE 保留原作者 MIT 声明并增加本项目修改归属说明或 NOTICE
- [ ] 秘密与隐私扫描无阻断项，内部绝对路径/令牌/审计日志不进入公开包
- [ ] README 与 docs 覆盖从安装到 ChatGPT 使用的完整闭环
- [ ] README 展示可复用 banner/架构图，资源文件可在 GitHub 正常渲染
- [ ] 所有发布检查通过，并形成公开发布前最终核对清单

## GitHub

- Issue: https://github.com/greysonOuyang/repo-harness-controller-runtime/issues/9
- Repository: `greysonOuyang/repo-harness-controller-runtime`
- Last synced: 2026-06-23T08:48:42.865Z

## Tasks

### T1 — 审计本地与远程 Git 拓扑

- Status: `done`
- Objective: 只读检查 remotes、local/remote branches、tags、merge-base、ahead/behind、已合并分支、孤立分支和当前工作区状态，输出治理报告；不得删除、重命名、rebase、reset 或 push。
- Depends on: none
- Allowed paths: `tasks/reports/**`
- Checks: not defined
- Execution hint: agent / codex
- GitHub: https://github.com/greysonOuyang/repo-harness-controller-runtime/issues/10

### T2 — 审计开源许可、来源与敏感信息

- Status: `done`
- Objective: 确认 Ancienttwo/repo-harness 的 MIT 继承要求，识别复制代码、内部路径、凭据、日志、私有配置和不应公开的历史产物，输出阻断项与修复清单。
- Depends on: none
- Allowed paths: `tasks/reports/**`
- Checks: not defined
- Execution hint: agent / codex
- GitHub: https://github.com/greysonOuyang/repo-harness-controller-runtime/issues/11

### T3 — 制定版本与发布分支策略

- Status: `done`
- Objective: 基于 Git 拓扑和许可审计，区分 npm/package 语义版本、Controller tool-surface v8/v8.1、文档代际和分支命名，给出降号或不降号的决策以及 release/main/feature 的收敛方案。
- Depends on: `T1`, `T2`
- Allowed paths: `tasks/reports/**`, `docs/versioning.md`
- Checks: not defined
- Execution hint: agent / codex
- GitHub: https://github.com/greysonOuyang/repo-harness-controller-runtime/issues/12

### T4 — 重构开源 README 与完整使用文档

- Status: `running`
- Objective: 完善中英文 README、安装、命令、功能、Controller、Grok 反代、Cloudflare 自定义域名、ChatGPT MCP 连接、repoId 固定绑定和故障排查教程；去除内部化叙述。
- Depends on: `T3`
- Allowed paths: `README.md`, `README.zh-CN.md`, `docs/**`, `examples/**`
- Checks: `check:type`
- Execution hint: agent / codex
- GitHub: https://github.com/greysonOuyang/repo-harness-controller-runtime/issues/13

### T5 — 制作开源品牌与 Banner 资源

- Status: `done`
- Objective: 设计适合 GitHub README 和社交分享的项目 banner、简洁架构图和可编辑源文件，避免使用第三方受限素材。
- Depends on: `T3`
- Allowed paths: `assets/**`, `docs/images/**`, `README.md`, `README.zh-CN.md`
- Checks: not defined
- Execution hint: agent / codex
- GitHub: https://github.com/greysonOuyang/repo-harness-controller-runtime/issues/14

### T6 — 实施开源元数据与发布安全修复

- Status: `blocked`
- Objective: 根据审计结果修正 package 元数据、LICENSE/NOTICE、公开包清单、gitignore、示例配置和敏感信息泄漏点，保持 Controller 行为兼容。
- Depends on: `T2`, `T3`
- Allowed paths: `package.json`, `LICENSE`, `NOTICE`, `README.md`, `README.zh-CN.md`, `.gitignore`, `.npmignore`, `docs/**`, `assets/**`, `scripts/**`, `src/**`, `tests/**`
- Checks: `check:type`, `check:ci`, `check:release`
- Execution hint: agent / codex
- GitHub: https://github.com/greysonOuyang/repo-harness-controller-runtime/issues/15

### T7 — 安全收敛分支并准备 GitHub 公开发布

- Status: `running`
- Objective: 在所有审计和修复通过后，建立明确的发布候选分支/标签，合并经验证改动，生成最终公开发布核对表；任何分支删除必须单独列出并在获得明确批准后执行。
- Depends on: `T4`, `T5`, `T6`
- Allowed paths: `tasks/reports/**`, `docs/**`, `.github/**`
- Checks: `check:ci`, `check:release`
- Execution hint: agent / codex
- GitHub: https://github.com/greysonOuyang/repo-harness-controller-runtime/issues/16

### T8 — 清理 Git 跟踪运行文件、残留 Worktree 与版本分支

- Status: `planned`
- Objective: 在 T6 发布安全修复集成后，审计并解除所有运行日志、Controller 状态、真实 repository binding、jobs、edit sessions、artifacts、local bridge 和临时 worktree 文件的 Git 跟踪；保留本地运行文件但从当前版本树删除。清理仅属于已结束 Run 的残留 worktree 和 controller 临时分支，收敛 main/release/feature 关系，并将当前树中的删除通过普通提交同步到远端。不得改写历史、force push、删除活跃 worktree 或删除未合并的唯一提交。
- Depends on: `T6`
- Allowed paths: `.gitignore`, `.npmignore`, `.ai/harness/mcp/audit.log`, `.ai/harness/repository.json`, `.ai/harness/**`, `tasks/reports/**`, `docs/**`, `.github/**`
- Checks: `check:ci`, `check:release`
- Execution hint: agent / codex

## Related Artifacts

- `package.json`
- `LICENSE`
- `README.md`
- `README.zh-CN.md`
- `docs/repo-harness-chatgpt-mcp-setup.md`
- `docs/repo-harness-chatgpt-controller.md`
- `docs/repo-harness-chatgpt-bridge-v8.md`
