import Database from '../sqlite-compat.js';
import type {
  AgentProfilePrompts,
  AgentProfilePromptVersion,
  AgentProfileRuntimePolicy,
  ChannelTurnContext,
} from '../types.js';

// ISSUE-12 波 3：initDatabase 拆分各 step 模块的共享迁移上下文。
// step 模块不得依赖 db.ts 模块级 `db` 变量（未导出的单连接），也不得
// 反向 import db.ts——那会与 db.ts → db-schema/* 的正向 import 成环。
// 本接口把编排壳持有的全部依赖显式传参：连接、启动前版本快照、五个
// 结构探测/迁移原语，以及 8 个留守 db.ts 原位的模块级函数（它们或在
// initDatabase 外另有 db.ts 内消费点、或已被外部模块消费，本体不动，
// 经同名注入使搬运段调用点逐字节不变——单元 2.7 的 deps 同名注入先例）。
// db.ts 构造本对象时由 TypeScript 结构化校验逐字段把关，签名漂移即红。

// db.ts:7577 的 RuntimePolicyInput 结构副本（db.ts 本地未导出类型，无法
// import；字段与其逐字节一致，构造 ctx 时经结构化类型自然校验——
// feishu-events.ts 的 FeishuEventConnectOptions 结构子集同款先例）。
type RuntimePolicyInput = Partial<{
  reasoning: Partial<AgentProfileRuntimePolicy['reasoning']> | null;
  context: Partial<AgentProfileRuntimePolicy['context']> | null;
  skills:
    | (Partial<Omit<AgentProfileRuntimePolicy['skills'], 'host'>> & {
        host?: Partial<
          NonNullable<AgentProfileRuntimePolicy['skills']['host']>
        > | null;
      })
    | null;
  mcp: Partial<AgentProfileRuntimePolicy['mcp']> | null;
}>;

export interface DbMigrationContext {
  /** 本次 initDatabase 打开的连接（编排壳在 PRAGMA/备份门/FK 门之后构造本对象）。 */
  db: InstanceType<typeof Database>;
  /** 启动前读取的 schema_version 快照（getRouterStateInternal ?? null）；迁移段五种异构门控原文引用它。 */
  rawSchemaVersionBeforeInit: string | null;
  ensureColumn: (
    tableName: string,
    columnName: string,
    sqlTypeWithDefault: string,
  ) => void;
  assertSchema: (
    tableName: string,
    requiredColumns: string[],
    forbiddenColumns?: string[],
  ) => void;
  tableExists: (tableName: string) => boolean;
  hasColumn: (tableName: string, columnName: string) => boolean;
  getRouterStateInternal: (key: string) => string | undefined;
  /** db.ts:7748，v68→v69 迁移段专用（单消费点，本体留守原位）。 */
  migrateAgentProfileEffortPolicy: () => number;
  parseAgentProfileRuntimePolicy: (raw: unknown) => AgentProfileRuntimePolicy;
  /** 仅声明 v47→v48 迁移段实际调用的第二重载形状；db.ts 的完整重载组可结构化赋入。 */
  computeAgentProfileIdentityHash: (
    prompts: AgentProfilePrompts,
    runtimePolicy?: RuntimePolicyInput | AgentProfileRuntimePolicy | null,
    name?: string,
  ) => string;
  insertAgentProfilePromptVersionSnapshot: (input: {
    profileId: string;
    version: number;
    name: string;
    prompts: AgentProfilePrompts;
    identityHash: string;
    changeSource: AgentProfilePromptVersion['change_source'];
    restoredFromVersion?: number | null;
    createdAt?: string;
  }) => void;
  backfillAgentProfileDefaultsAndWorkspaceMappings: () => void;
  removeLegacyAgentToolPolicies: () => void;
  reconcileCanonicalRuntimeProjections: () => void;
  parseChannelTurnContext: (value: unknown) => ChannelTurnContext | undefined;
}
