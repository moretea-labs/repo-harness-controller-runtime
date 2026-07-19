from pathlib import Path

path = Path('src/runtime/assistant/routine-runtime.ts')
text = path.read_text()
old = '''  return executeAssistantPluginAction({
    controllerHome,
    repoId: repository.repoId,
    repoRoot: repository.canonicalRoot,
    pluginId: 'gmail',
    actionId,
    requestId,
    args,
    origin,
  });
}'''
new = '''  const executed = await executeAssistantPluginAction({
    controllerHome,
    repoId: repository.repoId,
    repoRoot: repository.canonicalRoot,
    pluginId: 'gmail',
    actionId,
    requestId,
    args,
    origin,
  });
  return recordValue(executed.result);
}'''
if old not in text:
    raise SystemExit('gmailAction result anchor not found')
path.write_text(text.replace(old, new, 1))
print('Applied Gmail Routine Runtime result unwrapping fix.')
