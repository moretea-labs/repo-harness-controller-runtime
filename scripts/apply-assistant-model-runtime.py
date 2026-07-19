from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if old not in text:
        raise SystemExit(f'anchor not found in {path}: {old[:140]!r}')
    file.write_text(text.replace(old, new, 1))

replace_once(
    'src/runtime/assistant/routine-runtime.ts',
    "import { addAssistantInboxItem, getAssistantRoutine, touchAssistantRoutineRun } from './store';",
    "import { addAssistantInboxItem, getAssistantRoutine, touchAssistantRoutineRun } from './store';\nimport { analyzeAssistantMessages, type AssistantModelAnalysis } from './model-provider';\nimport { applyAssistantStandingGrants, type StandingGrantExecutionResult } from './standing-grants';",
)
replace_once(
    'src/runtime/assistant/routine-runtime.ts',
    "  proposedActions: number;\n  summary?: string;",
    "  proposedActions: number;\n  autoSubmittedActions?: number;\n  analysis?: {\n    usedModel: boolean;\n    provider: AssistantModelAnalysis['provider'];\n    model?: string;\n    promptVersion: string;\n    fallbackReason?: string;\n    warnings: string[];\n  };\n  summary?: string;",
)
replace_once(
    'src/runtime/assistant/routine-runtime.ts',
    "        executable: Boolean(to),\n        arguments: to ?",
    "        executable: Boolean(to),\n        context: { sender: to ?? message.from, subject: message.subject },\n        arguments: to ?",
)
replace_once(
    'src/runtime/assistant/routine-runtime.ts',
    "        reason: `Create a task from “${message.subject}”.`, confidence: 0.8,\n        arguments:",
    "        reason: `Create a task from “${message.subject}”.`, confidence: 0.8,\n        context: { sender: message.from, subject: message.subject },\n        arguments:",
)
replace_once(
    'src/runtime/assistant/routine-runtime.ts',
    "        reason: `Archive candidate: “${message.subject}”.`, confidence: 0.7,\n        arguments:",
    "        reason: `Archive candidate: “${message.subject}”.`, confidence: 0.7,\n        context: { sender: message.from, subject: message.subject },\n        arguments:",
)
replace_once(
    'src/runtime/assistant/routine-runtime.ts',
    "function renderReport(messages: GmailMessageSummary[], proposals: AssistantActionProposalInput[], windowStart: string, windowEnd: string): string {",
    "function renderReport(\n  messages: GmailMessageSummary[],\n  proposals: AssistantActionProposalInput[],\n  windowStart: string,\n  windowEnd: string,\n  analysis: AssistantModelAnalysis,\n  standingGrantResults: StandingGrantExecutionResult[],\n): string {",
)
replace_once(
    'src/runtime/assistant/routine-runtime.ts',
    "    `读取邮件：${messages.length} 封；重要候选：${important.length} 封；行动建议：${proposals.length} 项。`,\n    '',",
    "    `读取邮件：${messages.length} 封；重要候选：${important.length} 封；行动建议：${proposals.length} 项；自动提交：${standingGrantResults.filter((entry) => entry.status === 'submitted').length} 项。`,\n    `分析方式：${analysis.usedModel ? `${analysis.provider}${analysis.model ? ` (${analysis.model})` : ''}` : 'deterministic rules'}.`,\n    ...(analysis.summary ? ['', '模型摘要：', analysis.summary] : []),\n    '',",
)
replace_once(
    'src/runtime/assistant/routine-runtime.ts',
    "    ...(proposals.length > 0 ? proposals.slice(0, 20).map((proposal) => `- ${proposal.reason}`) : ['- 暂无。']),\n  ];",
    "    ...(proposals.length > 0 ? proposals.slice(0, 20).map((proposal) => `- ${proposal.reason}`) : ['- 暂无。']),\n    '',\n    '自动执行结果：',\n    ...(standingGrantResults.length > 0\n      ? standingGrantResults.slice(0, 20).map((entry) => `- ${entry.status}: ${entry.proposalId}${entry.reason ? ` — ${entry.reason}` : ''}`)\n      : ['- 没有匹配 Standing Grant。']),\n    ...(analysis.warnings.length > 0 ? ['', '分析警告：', ...analysis.warnings.map((warning) => `- ${warning}`)] : []),\n  ];",
)
replace_once(
    'src/runtime/assistant/routine-runtime.ts',
    "    const proposalInputs = proposalsFor(messages);\n    const proposals = createAssistantActionProposals(input.controllerHome, input.repository, { routineId: routine.routineId, runId, proposals: proposalInputs });",
    "    const modelAnalysis = await analyzeAssistantMessages({ messages, routineGoal: routine.naturalLanguageGoal });\n    const proposalInputs = modelAnalysis.usedModel ? modelAnalysis.proposals : proposalsFor(messages);\n    const proposals = createAssistantActionProposals(input.controllerHome, input.repository, { routineId: routine.routineId, runId, proposals: proposalInputs });\n    const standingGrantApplication = applyAssistantStandingGrants(input.controllerHome, input.repository, { routineId: routine.routineId, runId, proposals });\n    const analysis: AssistantModelAnalysis = {\n      ...modelAnalysis,\n      warnings: [...modelAnalysis.warnings, ...standingGrantApplication.warnings],\n    };",
)
replace_once(
    'src/runtime/assistant/routine-runtime.ts',
    "    const report = renderReport(messages, proposals, windowStart, windowEnd);",
    "    const report = renderReport(messages, proposalInputs, windowStart, windowEnd, analysis, standingGrantApplication.results);",
)
replace_once(
    'src/runtime/assistant/routine-runtime.ts',
    "      proposedActions: proposals.length,\n      summary: report,",
    "      proposedActions: proposals.length,\n      autoSubmittedActions: standingGrantApplication.results.filter((entry) => entry.status === 'submitted').length,\n      analysis: {\n        usedModel: analysis.usedModel,\n        provider: analysis.provider,\n        model: analysis.model,\n        promptVersion: analysis.promptVersion,\n        fallbackReason: analysis.fallbackReason,\n        warnings: analysis.warnings,\n      },\n      summary: report,",
)
replace_once(
    'src/runtime/assistant/routine-runtime.ts',
    "      summary: `读取 ${messages.length} 封新邮件，生成 ${proposals.length} 项只读行动建议。`,",
    "      summary: `读取 ${messages.length} 封新邮件，生成 ${proposals.length} 项行动建议，自动提交 ${standingGrantApplication.results.filter((entry) => entry.status === 'submitted').length} 项。`,",
)
replace_once(
    'src/runtime/assistant/routine-runtime.ts',
    "      jobIds: [],\n      recommendations: [",
    "      jobIds: standingGrantApplication.results.flatMap((entry) => entry.executionJobId ? [entry.executionJobId] : []),\n      recommendations: [",
)
replace_once(
    'src/runtime/assistant/routine-runtime.ts',
    "        '可基于行动建议创建草稿、任务或归档审批。',\n      ],\n      data: { run, messages, proposals, truncated },",
    "        '可基于行动建议创建草稿、任务或归档审批。',\n        ...(analysis.fallbackReason ? ['模型分析不可用，本次已安全回退到规则引擎。'] : []),\n      ],\n      data: { run, messages, proposals, truncated, analysis, standingGrantResults: standingGrantApplication.results },",
)
replace_once(
    'src/runtime/assistant/routine-runtime.ts',
    "): Promise<{ run: AssistantRoutineRun; messages: GmailMessageSummary[]; proposals: AssistantActionProposal[] }> {",
    "): Promise<{\n  run: AssistantRoutineRun;\n  messages: GmailMessageSummary[];\n  proposals: AssistantActionProposal[];\n  analysis?: AssistantModelAnalysis;\n  standingGrantResults?: StandingGrantExecutionResult[];\n}> {",
)
replace_once(
    'src/runtime/assistant/routine-runtime.ts',
    "    return { run, messages, proposals };",
    "    return { run, messages, proposals, analysis, standingGrantResults: standingGrantApplication.results };",
)
print('Applied Assistant model and Standing Grant Routine Runtime integration.')
