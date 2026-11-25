import type { DbMigrationContext } from './context.js';
import {
  includeClaudePresetForMode,
  normalizeAgentProfilePrompts,
  promptModeFromLegacyPreset,
} from '../agent-profile-prompts.js';

// ISSUE-12 波 3 单元 3.3：Agent Profile 表族两段自 src/db.ts 原文搬运。
// ensureAgentProfileTables（原 db.ts 885-1018）：agents/agent_profiles/
// agent_profile_prompt_versions/agent_builder_drafts/workspace_agent_
// profiles 五组建表，无门控幂等建表。
// migrateAgentProfileColumns（原 db.ts 1676-1844）：v29→v32 agents
// last_im_jid/spawned_from_jid 与 v36→v37 sessions provider_id 结构探测、
// v39→v44/v46→v47/v67→v68 profile 列与索引、v68→v69 effort 门控、
// v47→v48 prompt 四段拆分迁移（promptSchemaVersion < 48 门）。搬运体
// 逐字节一致，唯一改写是各函数体首行同名解构 const { … } = ctx（调用点
// 零改动）。五种门控原文保留（结构探测与版本号无关、
// rawSchemaVersionBeforeInit 快照、?? '0'、ensureColumn 幂等重放）；
// prompt 迁移的 normalize/promptMode/include 三函数自 agent-profile-
// prompts 模块直引（db.ts 既有 import，无环），其余四依赖经 ctx 注入。
// 计划表 1708-1844 外的 1676-1706（v29→v32/v36→v37 三段）为行界缺口
// 段按主题并入本单元，提交信息留痕。

export function ensureAgentProfileTables(ctx: DbMigrationContext): void {
  const { db } = ctx;
  // Sub-agents table for multi-agent parallel execution
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      created_by TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      result_summary TEXT,
      last_im_jid TEXT,
      spawned_from_jid TEXT,
      source_kind TEXT,
      thread_id TEXT,
      root_message_id TEXT,
      title_source TEXT,
      last_active_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_agents_group ON agents(group_folder);
    CREATE INDEX IF NOT EXISTS idx_agents_jid ON agents(chat_jid);
    CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
  `);

  // Top-level Agent Profiles: runtime identities/personas that own workspaces.
  // Do not confuse this with the legacy `agents` table above, which stores
  // workspace-scoped conversation/task/spawn agents.
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_profiles (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      name TEXT NOT NULL,
      identity_prompt TEXT NOT NULL DEFAULT '',
      soul_prompt TEXT NOT NULL DEFAULT '',
      agents_prompt TEXT NOT NULL DEFAULT '',
      tools_prompt TEXT NOT NULL DEFAULT '',
      prompt_mode TEXT NOT NULL DEFAULT 'append',
      include_claude_preset INTEGER NOT NULL DEFAULT 1,
      avatar_emoji TEXT,
      avatar_color TEXT,
      avatar_url TEXT,
      model_config_id TEXT,
      runtime_policy TEXT NOT NULL DEFAULT '{}',
      identity_hash TEXT NOT NULL DEFAULT '',
      version INTEGER NOT NULL DEFAULT 1,
      is_default INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_profiles_default
      ON agent_profiles(owner_user_id)
      WHERE is_default = 1 AND status = 'active';
    CREATE INDEX IF NOT EXISTS idx_agent_profiles_owner
      ON agent_profiles(owner_user_id, status);

    CREATE TABLE IF NOT EXISTS agent_profile_prompt_versions (
      id TEXT PRIMARY KEY,
      agent_profile_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      name TEXT NOT NULL,
      identity_prompt TEXT NOT NULL DEFAULT '',
      soul_prompt TEXT NOT NULL DEFAULT '',
      agents_prompt TEXT NOT NULL DEFAULT '',
      tools_prompt TEXT NOT NULL DEFAULT '',
      prompt_mode TEXT NOT NULL DEFAULT 'append',
      identity_hash TEXT NOT NULL,
      change_source TEXT NOT NULL DEFAULT 'update',
      restored_from_version INTEGER,
      created_at TEXT NOT NULL,
      UNIQUE(agent_profile_id, version)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_profile_prompt_versions_profile
      ON agent_profile_prompt_versions(agent_profile_id, version DESC);

    CREATE TABLE IF NOT EXISTS agent_builder_drafts (
      id TEXT PRIMARY KEY,
      owner_user_id TEXT NOT NULL,
      source_group TEXT NOT NULL,
      source_chat_jid TEXT NOT NULL,
      target_agent_profile_id TEXT,
      base_agent_version INTEGER,
      revision INTEGER NOT NULL DEFAULT 1,
      state TEXT NOT NULL DEFAULT 'ready',
      definition_json TEXT NOT NULL,
      assumptions_json TEXT NOT NULL DEFAULT '[]',
      prepared_turn_id TEXT,
      confirmation_phrase TEXT NOT NULL DEFAULT '',
      published_agent_profile_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agent_builder_drafts_owner
      ON agent_builder_drafts(owner_user_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS workspace_agent_profiles (
      group_folder TEXT PRIMARY KEY,
      agent_profile_id TEXT NOT NULL,
      interaction_mode TEXT NOT NULL DEFAULT 'assistant'
        CHECK (interaction_mode IN ('assistant', 'proactive')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_agent_profiles_profile
      ON workspace_agent_profiles(agent_profile_id);
  `);
}

export function migrateAgentProfileColumns(ctx: DbMigrationContext): void {
  const {
    db,
    rawSchemaVersionBeforeInit,
    ensureColumn,
    getRouterStateInternal,
    migrateAgentProfileEffortPolicy,
    parseAgentProfileRuntimePolicy,
    computeAgentProfileIdentityHash,
    insertAgentProfilePromptVersionSnapshot,
  } = ctx;
  // v29 → v30: Add last_im_jid to agents table (#225)
  if (
    !db
      .prepare("PRAGMA table_info('agents')")
      .all()
      .some((c: any) => c.name === 'last_im_jid')
  ) {
    db.exec('ALTER TABLE agents ADD COLUMN last_im_jid TEXT');
  }

  // v31 → v32: Add spawned_from_jid to agents table (spawn parallel tasks)
  if (
    !db
      .prepare("PRAGMA table_info('agents')")
      .all()
      .some((c: any) => c.name === 'spawned_from_jid')
  ) {
    db.exec('ALTER TABLE agents ADD COLUMN spawned_from_jid TEXT');
  }

  // v36 → v37: Add provider_id to sessions table for sticky provider binding.
  // Prevents "Invalid signature in thinking block" errors when a Claude session
  // resumed across container restarts gets routed to a different OAuth account.
  if (
    !db
      .prepare("PRAGMA table_info('sessions')")
      .all()
      .some((c: any) => c.name === 'provider_id')
  ) {
    db.exec('ALTER TABLE sessions ADD COLUMN provider_id TEXT');
  }

  // v39 → v40: Track the top-level AgentProfile identity used by each Claude
  // session. When a profile prompt changes, callers can detect the hash mismatch
  // and start a fresh SDK session without losing CKQClaw message history.
  ensureColumn('sessions', 'agent_profile_id', 'TEXT');
  ensureColumn('sessions', 'identity_hash', 'TEXT');
  ensureColumn('sessions', 'agent_profile_version', 'INTEGER');

  // v40 → v41: Allow each AgentProfile to opt out of the Claude Code
  // built-in system prompt preset and use only CKQClaw/Agent prompts.
  ensureColumn(
    'agent_profiles',
    'include_claude_preset',
    'INTEGER NOT NULL DEFAULT 1',
  );

  // v43 → v44: AgentProfile runtime policy moves provider/tool/skill/MCP
  // intent from workspace-level compatibility fields into the top-level Agent.
  ensureColumn(
    'agent_profiles',
    'runtime_policy',
    "TEXT NOT NULL DEFAULT '{}'",
  );
  // v46 → v47: profile-level avatar overrides. Null means inherit the
  // globally configured main CKQClaw avatar.
  ensureColumn('agent_profiles', 'avatar_emoji', 'TEXT');
  ensureColumn('agent_profiles', 'avatar_color', 'TEXT');
  ensureColumn('agent_profiles', 'avatar_url', 'TEXT');
  // v67 -> v68: a top-level Agent can pin one complete model/Provider
  // configuration. Null deliberately means "follow the system default".
  ensureColumn('agent_profiles', 'model_config_id', 'TEXT');
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_agent_profiles_model_config
      ON agent_profiles(model_config_id)
      WHERE model_config_id IS NOT NULL;
  `);
  // v68 -> v69: make reasoning effort an explicit Agent runtime policy. The
  // inherited default preserves every existing Provider/SDK behavior, so this
  // migration normalizes JSON only and deliberately does not bump Agent
  // identity/version metadata.
  if (
    rawSchemaVersionBeforeInit !== null &&
    Number(rawSchemaVersionBeforeInit) < 69
  ) {
    migrateAgentProfileEffortPolicy();
  }

  // v47 → v48: split the legacy all-in-one Agent prompt into the four
  // IDENTITY / SOUL / AGENTS / TOOLS sections. The legacy prompt represented
  // general operating instructions, so migrate it losslessly into AGENTS.
  const promptSchemaVersion = Number(
    getRouterStateInternal('schema_version') ?? '0',
  );
  ensureColumn('agent_profiles', 'soul_prompt', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('agent_profiles', 'agents_prompt', "TEXT NOT NULL DEFAULT ''");
  ensureColumn('agent_profiles', 'tools_prompt', "TEXT NOT NULL DEFAULT ''");
  ensureColumn(
    'agent_profiles',
    'prompt_mode',
    "TEXT NOT NULL DEFAULT 'append'",
  );
  ensureColumn(
    'agent_builder_drafts',
    'confirmation_phrase',
    "TEXT NOT NULL DEFAULT ''",
  );
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_profile_prompt_versions (
      id TEXT PRIMARY KEY,
      agent_profile_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      name TEXT NOT NULL,
      identity_prompt TEXT NOT NULL DEFAULT '',
      soul_prompt TEXT NOT NULL DEFAULT '',
      agents_prompt TEXT NOT NULL DEFAULT '',
      tools_prompt TEXT NOT NULL DEFAULT '',
      prompt_mode TEXT NOT NULL DEFAULT 'append',
      identity_hash TEXT NOT NULL,
      change_source TEXT NOT NULL DEFAULT 'update',
      restored_from_version INTEGER,
      created_at TEXT NOT NULL,
      UNIQUE(agent_profile_id, version)
    );
    CREATE INDEX IF NOT EXISTS idx_agent_profile_prompt_versions_profile
      ON agent_profile_prompt_versions(agent_profile_id, version DESC);
  `);
  if (promptSchemaVersion < 48) {
    const legacyRows = db
      .prepare('SELECT * FROM agent_profiles')
      .all() as Array<Record<string, unknown>>;
    db.transaction(() => {
      for (const row of legacyRows) {
        const legacyPrompt = String(row.identity_prompt ?? '');
        const includePreset = Number(row.include_claude_preset ?? 1) === 1;
        const prompts = normalizeAgentProfilePrompts({
          identity_prompt: '',
          soul_prompt: String(row.soul_prompt ?? ''),
          agents_prompt: String(row.agents_prompt ?? '') || legacyPrompt,
          tools_prompt: String(row.tools_prompt ?? ''),
          prompt_mode: promptModeFromLegacyPreset(includePreset),
        });
        const runtimePolicy = parseAgentProfileRuntimePolicy(
          row.runtime_policy,
        );
        const identityHash = computeAgentProfileIdentityHash(
          prompts,
          runtimePolicy,
          String(row.name ?? ''),
        );
        db.prepare(
          `UPDATE agent_profiles
           SET identity_prompt = ?, soul_prompt = ?, agents_prompt = ?, tools_prompt = ?,
               prompt_mode = ?, include_claude_preset = ?, identity_hash = ?
           WHERE id = ?`,
        ).run(
          prompts.identity_prompt,
          prompts.soul_prompt,
          prompts.agents_prompt,
          prompts.tools_prompt,
          prompts.prompt_mode,
          includeClaudePresetForMode(prompts.prompt_mode) ? 1 : 0,
          identityHash,
          String(row.id),
        );
        insertAgentProfilePromptVersionSnapshot({
          profileId: String(row.id),
          version: Number(row.version ?? 1),
          name: String(row.name ?? ''),
          prompts,
          identityHash,
          changeSource: 'migration',
          createdAt: String(
            row.updated_at ?? row.created_at ?? new Date().toISOString(),
          ),
        });
      }
    })();
  }
}
