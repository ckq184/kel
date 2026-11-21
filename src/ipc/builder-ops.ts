import {
  discardPreparedAgentDraft,
  getAgentBuilderDraftForBuilder,
  getAgentCapabilityCatalogForBuilder,
  getAgentProfileForBuilder,
  listAgentProfilesForBuilder,
  prepareAgentBuilderDraft,
  publishAgentBuilderDraft,
  type AgentBuilderActor,
} from '../agent-builder.js';

// ISSUE-12 波 4 单元 4.10：Agent Builder 七 case
// （agent_profile_list/get/draft_get/agent_capability_catalog/prepare/
// publish/discard）自 src/index.ts processTaskIpc 的 switch 原文搬运
// （原 index.ts 9687-9822 含 case 标签共 136 行）。**零控制流改写**：七
// case 标签随体迁入本函数自建 switch (data.type)，全部 break 为内层
// switch 级原义保留；七 case 完全同构（requireAgentBuilderActor + store
// 调用 + 动态 writeTaskResult(tasksDir, data.type, …) 回执），早退全走
// throw→本 case catch，无中段 break。2 外围局部量 + 2 项 index.ts 本地
// 依赖（writeTaskResult / requireAgentBuilderActor——processTaskIpc 头
// 局部 actor 构建器，单元 4.8 迁 memory-owner-ops 后经壳层注入）经
// input 同名解构注入防环；agent-builder.ts 七 store 函数与类型自源模块
// 直引（对 index.ts 零反向依赖已核）。

export interface IpcBuilderOpsInput {
  /** processTaskIpc 解析出的 IPC 请求 JSON（结构类型同壳层，any 语义保留）。 */
  data: any;
  tasksDir: string;
  writeTaskResult: (
    tasksDir: string,
    type: string,
    requestId: string | undefined,
    payload: Record<string, unknown>,
  ) => void;
  requireAgentBuilderActor: () => AgentBuilderActor;
}

export async function processIpcBuilderOps(
  input: IpcBuilderOpsInput,
): Promise<void> {
  const { data, tasksDir, writeTaskResult, requireAgentBuilderActor } = input;
  switch (data.type) {
    case 'agent_profile_list': {
      try {
        const actor = requireAgentBuilderActor();
        writeTaskResult(tasksDir, data.type, data.requestId, {
          success: true,
          ...listAgentProfilesForBuilder(actor.user.id),
        });
      } catch (error) {
        writeTaskResult(tasksDir, data.type, data.requestId, {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      break;
    }

    case 'agent_profile_get': {
      try {
        const actor = requireAgentBuilderActor();
        if (!data.profileId) throw new Error('profileId is required');
        writeTaskResult(tasksDir, data.type, data.requestId, {
          success: true,
          ...getAgentProfileForBuilder(actor.user.id, data.profileId),
        });
      } catch (error) {
        writeTaskResult(tasksDir, data.type, data.requestId, {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      break;
    }

    case 'agent_profile_draft_get': {
      try {
        const actor = requireAgentBuilderActor();
        if (!data.draftId) throw new Error('draftId is required');
        writeTaskResult(tasksDir, data.type, data.requestId, {
          success: true,
          draft: getAgentBuilderDraftForBuilder(actor.user.id, data.draftId),
        });
      } catch (error) {
        writeTaskResult(tasksDir, data.type, data.requestId, {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      break;
    }

    case 'agent_capability_catalog': {
      try {
        const actor = requireAgentBuilderActor();
        writeTaskResult(tasksDir, data.type, data.requestId, {
          success: true,
          catalog: getAgentCapabilityCatalogForBuilder(actor),
        });
      } catch (error) {
        writeTaskResult(tasksDir, data.type, data.requestId, {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      break;
    }

    case 'agent_profile_prepare': {
      try {
        const actor = requireAgentBuilderActor();
        const result = prepareAgentBuilderDraft(actor, {
          draftId: data.draftId,
          expectedDraftRevision: data.expectedDraftRevision,
          targetAgentProfileId: data.targetAgentProfileId,
          expectedAgentVersion: data.expectedAgentVersion,
          definition: data.definition,
          assumptions: data.assumptions,
        });
        writeTaskResult(tasksDir, data.type, data.requestId, {
          success: true,
          ...result,
        });
      } catch (error) {
        writeTaskResult(tasksDir, data.type, data.requestId, {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      break;
    }

    case 'agent_profile_publish': {
      try {
        const actor = requireAgentBuilderActor();
        if (!data.draftId || data.expectedDraftRevision === undefined) {
          throw new Error('draftId and expectedDraftRevision are required');
        }
        const result = await publishAgentBuilderDraft(
          actor,
          data.draftId,
          data.expectedDraftRevision,
        );
        writeTaskResult(tasksDir, data.type, data.requestId, {
          success: true,
          ...result,
        });
      } catch (error) {
        writeTaskResult(tasksDir, data.type, data.requestId, {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      break;
    }

    case 'agent_profile_discard': {
      try {
        const actor = requireAgentBuilderActor();
        if (!data.draftId || data.expectedDraftRevision === undefined) {
          throw new Error('draftId and expectedDraftRevision are required');
        }
        writeTaskResult(tasksDir, data.type, data.requestId, {
          success: true,
          draft: discardPreparedAgentDraft(
            actor.user.id,
            data.draftId,
            data.expectedDraftRevision,
          ),
        });
      } catch (error) {
        writeTaskResult(tasksDir, data.type, data.requestId, {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      break;
    }
  }
}
