from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    if old not in text:
        raise SystemExit(f'anchor not found in {path}: {old[:100]!r}')
    file.write_text(text.replace(old, new, 1))

replace_once(
    'src/runtime/assistant/schedule-binding.ts',
    "    stopConditions: ['external_blocker'],",
    "    stopConditions: [],",
)
replace_once(
    'src/runtime/assistant/schedule-binding.ts',
    "  return { routine: getAssistantRoutine(repository.canonicalRoot, routineId), binding };",
    "  return { routine, binding };",
)

old_block = '''    const proposals = proposalsFor(messages);
    const report = renderReport(messages, proposals, windowStart, windowEnd);
    saveCursor(input.repository.canonicalRoot, {
      schemaVersion: 1,
      routineId: routine.routineId,
      lastSuccessfulAt: windowEnd,
      historyId: stringValue(profile.historyId),
      processedMessageIds: [...messageIds, ...cursor.processedMessageIds].slice(0, 1_000),
      updatedAt: now(),
    });
    run = saveRun(input.repository.canonicalRoot, {'''
new_block = '''    const proposals = proposalsFor(messages);
    const truncated = messageIds.length > messages.length;
    const report = renderReport(messages, proposals, windowStart, windowEnd);
    run = saveRun(input.repository.canonicalRoot, {'''
replace_once('src/runtime/assistant/routine-runtime.ts', old_block, new_block)

old_tail = '''      recommendations: [
        '发送邮件和移入垃圾箱仍需单独明确确认。',
        '可基于行动建议创建草稿、任务或归档审批。',
      ],
      data: { run, messages, proposals },
    });
    return { run, messages, proposals };'''
new_tail = '''      recommendations: [
        ...(truncated ? ['本次达到正文读取上限，下一次将从相同时间窗口继续处理剩余邮件。'] : []),
        '发送邮件和移入垃圾箱仍需单独明确确认。',
        '可基于行动建议创建草稿、任务或归档审批。',
      ],
      data: { run, messages, proposals, truncated },
    });
    saveCursor(input.repository.canonicalRoot, {
      schemaVersion: 1,
      routineId: routine.routineId,
      lastSuccessfulAt: truncated ? windowStart : windowEnd,
      historyId: stringValue(profile.historyId),
      processedMessageIds: [...messages.map((message) => message.id), ...cursor.processedMessageIds].slice(0, 1_000),
      updatedAt: now(),
    });
    return { run, messages, proposals };'''
replace_once('src/runtime/assistant/routine-runtime.ts', old_tail, new_tail)

# Extend tests with lifecycle and bounded backlog coverage.
test = Path('tests/runtime/gmail-assistant-routines.test.ts')
text = test.read_text()
text = text.replace(
    "import { parseAssistantScheduleText } from '../../src/runtime/assistant/schedule-binding';",
    "import { bindAssistantRoutineSchedule, parseAssistantScheduleText, updateAssistantRoutineLifecycle } from '../../src/runtime/assistant/schedule-binding';\nimport { getSchedule } from '../../src/runtime/workflow/schedules/store';",
    1,
)
anchor = "  test('collects mock Gmail incrementally and writes a final Assistant Inbox report', async () => {"
new_tests = r'''  test('deleting a Routine disables its durable Schedule and returns the deleted Routine', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'repo-harness-routine-lifecycle-'));
    const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-controller-'));
    tempRoots.push(repoRoot, controllerHome);
    const routine = createAssistantRoutine(repoRoot, {
      name: 'Lifecycle Routine', naturalLanguageGoal: 'read mail daily', scheduleText: '每天 09:00',
      timezone: 'UTC', dataSources: ['gmail'], output: 'assistant_inbox',
      allowedActions: ['gmail.list_messages', 'gmail.get_message'], forbiddenActions: ['gmail.send_message', 'gmail.trash_message'],
    });
    const repository = { repoId: 'repo_lifecycle', canonicalRoot: repoRoot, activeCheckoutId: 'checkout_test' } as any;
    const binding = bindAssistantRoutineSchedule(controllerHome, repository, routine);
    const deleted = updateAssistantRoutineLifecycle(controllerHome, repository, routine.routineId, 'deleted');
    expect(deleted.routine.status).toBe('deleted');
    expect(getSchedule(controllerHome, repository.repoId, binding.scheduleId).enabled).toBe(false);
  });

  test('keeps a fixed cursor window while a Gmail backlog is truncated, then advances after draining it', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'repo-harness-gmail-backlog-'));
    const controllerHome = mkdtempSync(join(tmpdir(), 'repo-harness-controller-'));
    tempRoots.push(repoRoot, controllerHome);
    mkdirSync(join(repoRoot, '.repo-harness', 'plugins'), { recursive: true });
    writeFileSync(join(repoRoot, '.repo-harness', 'plugins', 'gmail.json'), JSON.stringify({ schemaVersion: 1, enabled: true, provider: 'google-workspace' }));
    process.env.REPO_HARNESS_GMAIL_ACCESS_TOKEN = 'valid-token';
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/labels')) return new Response(JSON.stringify({ labels: [{ id: 'INBOX' }] }), { status: 200 });
      if (url.pathname.endsWith('/messages')) {
        return new Response(JSON.stringify({ messages: Array.from({ length: 60 }, (_, index) => ({ id: `message-${index + 1}` })) }), { status: 200 });
      }
      const messageId = decodeURIComponent(url.pathname.split('/').pop() ?? 'unknown');
      return new Response(JSON.stringify({
        id: messageId,
        threadId: `${messageId}-thread`,
        snippet: `Snippet ${messageId}`,
        labelIds: ['INBOX'],
        payload: { headers: [{ name: 'From', value: 'sender@example.com' }, { name: 'Subject', value: `Subject ${messageId}` }], body: {} },
      }), { status: 200 });
    }) as typeof fetch;
    const routine = createAssistantRoutine(repoRoot, {
      name: 'Backlog Routine', naturalLanguageGoal: 'drain Gmail backlog', scheduleText: '每天 09:00', timezone: 'UTC',
      dataSources: ['gmail'], output: 'assistant_inbox', allowedActions: ['gmail.list_messages', 'gmail.get_message'],
      forbiddenActions: ['gmail.send_message', 'gmail.trash_message'],
    });
    const repository = { repoId: 'repo_backlog', canonicalRoot: repoRoot, activeCheckoutId: 'checkout_test' } as any;
    const first = await executeAssistantRoutineRuntime({ controllerHome, repository, routineId: routine.routineId, requestId: 'backlog-1', origin: { surface: 'assistant-routine' } });
    expect(first.messages).toHaveLength(50);
    let cursor = JSON.parse(readFileSync(join(repoRoot, '.repo-harness', 'assistant', 'gmail-cursors.json'), 'utf-8')).cursors[0];
    expect(cursor.lastSuccessfulAt).toBe(first.run.windowStart);
    expect(cursor.processedMessageIds).toHaveLength(50);
    const second = await executeAssistantRoutineRuntime({ controllerHome, repository, routineId: routine.routineId, requestId: 'backlog-2', origin: { surface: 'assistant-routine' } });
    expect(second.messages).toHaveLength(10);
    cursor = JSON.parse(readFileSync(join(repoRoot, '.repo-harness', 'assistant', 'gmail-cursors.json'), 'utf-8')).cursors[0];
    expect(cursor.lastSuccessfulAt).toBe(second.run.windowEnd);
    expect(cursor.processedMessageIds).toHaveLength(60);
  });

'''
if anchor not in text:
    raise SystemExit('test insertion anchor not found')
text = text.replace(anchor, new_tests + anchor, 1)
test.write_text(text)
print('Fixed Routine lifecycle and bounded Gmail backlog handling.')
