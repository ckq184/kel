export type TaskExecutionMode = 'host' | 'container';

export function buildTaskWorkspacePatch(input: {
  currentChatJid: string;
  currentExecutionMode?: TaskExecutionMode | null;
  targetChatJid: string;
  targetExecutionMode?: TaskExecutionMode | null;
}): Record<string, TaskExecutionMode | string> {
  const fields: Record<string, TaskExecutionMode | string> = {};
  if (input.targetChatJid !== input.currentChatJid) {
    fields.chat_jid = input.targetChatJid;
  }
  if (
    input.targetExecutionMode &&
    input.targetExecutionMode !== input.currentExecutionMode
  ) {
    fields.execution_mode = input.targetExecutionMode;
  }
  return fields;
}
