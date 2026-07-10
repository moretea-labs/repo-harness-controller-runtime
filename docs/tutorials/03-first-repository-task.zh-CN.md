# 教程 3：完成第一个仓库任务

先选择一个小而可回滚的任务，例如只修改 README 的一段说明。

1. 让 ChatGPT 对目标仓库调用 `rh_status` 和 `rh_context`。
2. 说明期望结果、允许修改的文件和需要通过的检查。
3. 小改动由 `rh_work` 选择受限 Direct Edit；范围更大的工作才进入持久 Task 或 Agent 路径。
4. 审查变更文件和验证证据。
5. 出现审批、澄清或阻塞决定时使用 `rh_inbox`。

示例请求：

```text
使用 repo-harness 修改我已注册的仓库。只更新 README 的一个段落，变更不超过 20 行，运行文档检查，并在完成前展示审查后的 diff。
```

成功的首个任务应留下持久证据，不开放任意 shell 输入，也不会提交运行日志、凭据、worktree 或 Controller 状态。
