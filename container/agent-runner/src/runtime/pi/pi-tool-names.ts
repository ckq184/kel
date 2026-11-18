/**
 * Claude-style tool names (what the product config and the UI use) → Pi names.
 * Shared by the session setup (allow-list translation, Claude → Pi) and the
 * event mapping (UI names, Pi → Claude) so the two directions cannot drift.
 */
export const CLAUDE_TO_PI_TOOL_ALIASES: Readonly<Record<string, string>> = {
  Bash: 'bash',
  Read: 'read',
  Write: 'write',
  Edit: 'edit',
  Glob: 'find',
  Grep: 'grep',
  Task: 'Agent',
  TaskOutput: 'get_subagent_result',
  TaskStop: 'steer_subagent',
};

/**
 * Built-ins whose Pi name differs from the name the Web and Feishu UIs key
 * their labels and styles on. Sub-agent tools (Task / Agent …) are left out on
 * purpose: UI logic keyed on `Task` has its own semantics and is not remapped.
 */
const UI_NAMED_BUILTINS = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'];

const PI_TO_UI_TOOL_NAMES = new Map(
  UI_NAMED_BUILTINS.map((uiName) => [
    CLAUDE_TO_PI_TOOL_ALIASES[uiName],
    uiName,
  ]),
);

/** Name to put on stream events for a Pi tool; unmapped names pass through. */
export function toUiToolName(piToolName: string): string {
  return PI_TO_UI_TOOL_NAMES.get(piToolName) ?? piToolName;
}
