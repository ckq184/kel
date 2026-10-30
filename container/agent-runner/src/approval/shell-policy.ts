import type { ApprovalPolicy } from './policy.js';

/**
 * Shell command classifier for the approval gate.
 *
 * Translates the security-rules prompt into deterministic runtime checks:
 * red-line commands (destructive, credential tampering, exfiltration,
 * persistence, remote code execution) and yellow-line commands (sudo, global
 * installs, docker, firewall, service management) that run but are
 * audit-logged. Everything else is `pass` — the tool-name policy decides.
 *
 * This is pattern matching, not parsing: obfuscated commands escalate to red
 * (fail-closed), and the classifier only needs to be sound for the deny path,
 * never complete. Mode/action configuration comes from the approval policy.
 */

export type ShellPolicyMode = 'off' | 'audit' | 'enforce';

export interface ShellPolicyConfig {
  /** `off` disables classification; `audit` allows red lines but logs them;
   * `enforce` (default) triggers `redAction` on red-line matches. */
  mode?: ShellPolicyMode;
  /** Red-line outcome in enforce mode. Default `ask` (suspends for the user). */
  redAction?: 'ask' | 'deny';
}

export function resolveShellPolicy(
  policy: ApprovalPolicy | undefined,
): Required<Pick<ShellPolicyConfig, 'mode' | 'redAction'>> {
  const shell = policy?.shell;
  return {
    mode: shell?.mode ?? 'enforce',
    redAction: shell?.redAction ?? 'ask',
  };
}

export type ShellVerdict =
  | { level: 'pass' }
  | { level: 'yellow'; reasons: string[] }
  | { level: 'red'; reasons: string[] };

interface Category {
  name: string;
  level: 'red' | 'yellow';
  patterns: RegExp[];
}

// Order matters only for reason reporting; red beats yellow regardless.
const CATEGORIES: Category[] = [
  {
    name: 'remote_code_execution',
    level: 'red',
    patterns: [
      /\b(?:curl|wget|fetch)\b[^|;]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/i,
      /\|\s*(?:sudo\s+)?(?:ba)?sh\b/i,
      /\beval\b[^;]*(?:\$\(|`)/,
      /\bbase64\b[^\n|;]*\|\s*(?:sudo\s+)?(?:ba)?sh\b/i,
      /\bprintf\b[^\n|;]*\|\s*(?:sudo\s+)?(?:ba)?sh\b/i,
    ],
  },
  {
    // Browser automation driven from bash executes page-context JS that the
    // tool-name policy never sees. The observed red-team bypass ran
    // `browser-use <<'PY' ... PY` heredocs (TASK-D §6.1). Match the browser-use
    // binary at command position — quoted occurrences (grep 'browser-use') are
    // argument text, not invocations; agent-browser eval/js are the page-JS
    // subcommands, read-only ones (open/snapshot) stay at the tool-name layer.
    name: 'browser_automation',
    level: 'red',
    patterns: [
      /(?:^|[\s;&|(`$])browser-use\b/i,
      /\bagent-browser\s+(?:eval|js)\b/i,
    ],
  },
  {
    name: 'destructive',
    level: 'red',
    patterns: [
      /\brm\b[^;\n|]*\s(?:\/|\/\*|~|~\/\*|~\/|\$HOME\/?\*?|\/(?:usr|etc|var|boot|bin|sbin|lib|lib64|opt|root|dev|proc|sys)(?:\/[^\s]*)?)(?:\s|$)/,
      /\bmkfs(?:\.\w+)?\b/i,
      /\bdd\b[^;\n|]*\bof=\s*\/dev\/(?:sd|nvme|vd|hd|mmcblk)/i,
      /\bwipefs\b/i,
      /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, // fork bomb
      />\s*\/dev\/(?:sd|nvme|vd|hd)[a-z0-9]*\b/i,
    ],
  },
  {
    name: 'credential_tampering',
    level: 'red',
    patterns: [
      /authorized_keys/i,
      /\bsshd_config\b/i,
      /\b(?:usermod|useradd|adduser)\b[^;\n|]*\b(?:-u|--uid|-G|--groups)\b/i,
      /\/etc\/(?:passwd|shadow)\b/i,
      /\.gnupg\b/i,
      /\bgpg\b[^;\n|]*--delete-secret/i,
      /\bcp\b[^;\n|]*\/etc\/(?:passwd|shadow)\b/i,
    ],
  },
  {
    name: 'exfiltration',
    level: 'red',
    patterns: [
      // Network tools combined with credential-looking payloads/files.
      /\b(?:curl|wget|nc|ncat|netcat|scp|rsync|ssh)\b[^;\n]*(?:api[_-]?key|apikey|token|password|passwd|secret|private[_-]?key|id_rsa|\.env\b|credentials|mnemonic|seed[- _]?phrase|助记词|私钥)/i,
      /\b(?:cat|less|more|head|tail|base64|printenv|env)\b[^;\n|]*(?:id_rsa|\.env\b|credentials\.json|\.gnupg)[^;\n|]*\|\s*(?:curl|wget|nc|ncat|netcat|ssh)\b/i,
      /\b(?:curl|wget)\b[^;\n|]*--data(?:-binary)?\b[^;\n|]*(?:@\.?\.?\/?\.env|@.*credential|@.*secret)/i,
      /\b(?:api[_-]?key|apikey|token|password|passwd|secret|private[_-]?key|credentials)\b[^;\n]*\|\s*(?:curl|wget|nc|ncat|netcat|ssh)\b/i,
    ],
  },
  {
    name: 'persistence',
    level: 'red',
    patterns: [
      /\bcrontab\b\s*(?:-e|-l|-r|-u|-)?/i,
      /\bcrontab\b\s+(?:&&|;)/i,
      />\s*\/etc\/crontab\b/i,
      /\buseradd\b/i,
      /\busermod\b/i,
      /\bsystemctl\b[^;\n|]*\b(?:enable|link|add-wants|add-requires)\b/i,
      /\/etc\/(?:rc\.local|systemd\/system\/[^;\n|]*\.service)/i,
      /\bschtasks\b/i,
      /\bat\s+\d{1,2}:\d{2}\b/i,
      /LaunchAgents?\//i,
    ],
  },
  {
    name: 'privileged_operations',
    level: 'yellow',
    patterns: [
      /(?:^|[\s;&|]\(?)(?:sudo|doas)\b/i,
      /\bpip3?\s+install\b/i,
      /\bnpm\s+(?:install|i|add)\s+(?:-[A-Za-z]+\s+)*-g\b/i,
      /\bdocker\b\s+(?:run|exec|rm|rmi|system|volume|network|build|pull|push|cp|compose)\b/i,
      /\biptables\b/i,
      /\bufw\b/i,
      /\bsystemctl\b\s+(?:start|stop|restart|reload|mask|unmask)\b/i,
      /\b(?:pkill|killall)\b/i,
      /\bkill\b\s+-\d/,
      /\bmodprobe\b|\binsmod\b|\brmmod\b/i,
      /\bchown\b[^;\n|]*\sroot\b/i,
    ],
  },
];

/** Commands whose whole-string shape matters before segment splitting. */
const WHOLE_COMMAND_RED: RegExp[] = [
  /\b(?:curl|wget)\b[^;\n]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/i,
  /\beval\b[^;\n]*(?:\$\(|`)/i,
];

/**
 * Split a compound command into segments on shell separators, keeping
 * pipeline stages (each stage is classified separately for yellow audit,
 * while red patterns also run against the full command).
 */
export function splitShellSegments(command: string): string[] {
  return command
    .split(/(?:&&|\|\||;|\|)/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function matchCategories(text: string): ShellVerdict {
  const redReasons: string[] = [];
  const yellowReasons: string[] = [];
  for (const category of CATEGORIES) {
    for (const pattern of category.patterns) {
      let match: RegExpMatchArray | null;
      try {
        match = text.match(pattern);
      } catch {
        continue;
      }
      if (!match) continue;
      const reason = `${category.name}:${pattern.source.slice(0, 60)}`;
      if (category.level === 'red') redReasons.push(reason);
      else yellowReasons.push(reason);
      break; // one reason per category is enough
    }
  }
  if (redReasons.length > 0) return { level: 'red', reasons: redReasons };
  if (yellowReasons.length > 0) return { level: 'yellow', reasons: yellowReasons };
  return { level: 'pass' };
}

export function classifyShellCommand(command: string): ShellVerdict {
  const text = command ?? '';
  if (text.trim().length === 0) return { level: 'pass' };

  // Whole-command red shapes (exfiltration chains, eval of substitutions).
  for (const pattern of WHOLE_COMMAND_RED) {
    if (pattern.test(text)) {
      return { level: 'red', reasons: [`rce:${pattern.source.slice(0, 60)}`] };
    }
  }

  let worst: ShellVerdict = { level: 'pass' };
  const sections = [text, ...splitShellSegments(text)];
  for (const section of sections) {
    const verdict = matchCategories(section);
    if (verdict.level === 'red') return verdict;
    if (verdict.level === 'yellow' && worst.level === 'pass') worst = verdict;
  }
  return worst;
}

/** Extract the bash command from a tool_call input, or null for other tools. */
export function readBashCommand(toolName: string, input: unknown): string | null {
  if (toolName !== 'bash') return null;
  if (!input || typeof input !== 'object') return null;
  const command = (input as { command?: unknown }).command;
  return typeof command === 'string' ? command : null;
}
