import fs from 'fs';
import path from 'path';
import { logger } from '../logger.js';
import { DATA_DIR } from '../config.js';
import type { RegisteredGroup } from '../types.js';
import { deleteSkillForUser, installSkillForUser } from '../routes/skills.js';

// ISSUE-12 波 4 单元 4.11：register_group / install_skill / uninstall_skill
// 三 case 体自 src/index.ts processTaskIpc 的 switch 原文搬运（原 index.ts
// 10849-10889 / 10893-10966 / 10970-11027，共 173 行）。外围局部量经 input
// 显式传参、同名解构使搬运体逐字节不变；4 项 index.ts 本地依赖
// （getRegisteredGroups getter——registeredGroups 有整体重赋值、
// isAdminHostOnlyOwner、registerGroup、SAFE_REQUEST_ID_RE）经 input 注入
// 防环；installSkillForUser/deleteSkillForUser 自 routes/skills.js 直引。
// 计划约束严格落实：install_skill/uninstall_skill 体内 `const tasksDir =
// path.join(DATA_DIR, 'ipc', sourceGroup, 'tasks')` 自算遮蔽形参的历史
// 行为原文保留（不传 tasksDir 形参——三 case 无一消费真参），不顺手修正。
// 唯一控制流改写：七处 case 级 `break;` 机械转 `return;`（switch 为
// processTaskIpc 末语句 break≡return 等价，体内无内嵌循环），尾随 break
// 留壳层。

export interface IpcSkillRegistryInput {
  /** processTaskIpc 解析出的 IPC 请求 JSON（结构类型同壳层，any 语义保留）。 */
  data: any;
  sourceGroup: string;
  isHome?: boolean;
  getRegisteredGroups: () => Record<string, RegisteredGroup>;
  isAdminHostOnlyOwner: (ownerId: string | null | undefined) => boolean;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  SAFE_REQUEST_ID_RE: RegExp;
}

export function processIpcRegisterGroup(input: IpcSkillRegistryInput): void {
  const {
    data,
    sourceGroup,
    isHome,
    getRegisteredGroups,
    isAdminHostOnlyOwner,
    registerGroup,
  } = input;
  // Only the Home workspace can register new groups
  if (!isHome) {
    logger.warn({ sourceGroup }, 'Unauthorized register_group attempt blocked');
    return;
  }
  if (data.jid && data.name && data.folder) {
    // Inherit created_by from the source group so onNewChat won't re-route
    const sourceEntry = Object.values(getRegisteredGroups()).find(
      (g) => g.folder === sourceGroup,
    );
    const execMode = isAdminHostOnlyOwner(sourceEntry?.created_by)
      ? 'host'
      : data.executionMode === 'host' || data.executionMode === 'container'
        ? data.executionMode
        : undefined;
    try {
      registerGroup(data.jid, {
        name: data.name,
        folder: data.folder,
        added_at: new Date().toISOString(),
        containerConfig: data.containerConfig,
        created_by: sourceEntry?.created_by,
        executionMode: execMode,
      });
    } catch (err) {
      // registerGroup 校验 folder 名时会抛错。IPC 来源不可信（agent 进程
      // 可能被 prompt 注入），不要把异常冒泡到主消息循环。
      logger.warn(
        { jid: data.jid, folder: data.folder, err },
        'register_group rejected by validation',
      );
    }
  } else {
    logger.warn(
      { data },
      'Invalid register_group request - missing required fields',
    );
  }
}

export async function processIpcInstallSkill(
  input: IpcSkillRegistryInput,
): Promise<void> {
  const { data, sourceGroup, getRegisteredGroups, SAFE_REQUEST_ID_RE } = input;
  if (data.package && data.requestId) {
    const pkg = data.package;
    const requestId = data.requestId;
    if (!SAFE_REQUEST_ID_RE.test(requestId)) {
      logger.warn(
        { sourceGroup, requestId },
        'Rejected install_skill request with invalid requestId',
      );
      return;
    }
    const tasksDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'tasks');
    const tasksDirResolved = path.resolve(tasksDir);
    const resultFileName = `install_skill_result_${requestId}.json`;
    const resultFilePath = path.resolve(tasksDir, resultFileName);
    if (!resultFilePath.startsWith(`${tasksDirResolved}${path.sep}`)) {
      logger.warn(
        { sourceGroup, requestId, resultFilePath },
        'Rejected install_skill request with unsafe result file path',
      );
      return;
    }

    // Find the user who owns this group
    const sourceGroupForSkill = Object.values(getRegisteredGroups()).find(
      (g) => g.folder === sourceGroup,
    );
    const userId = sourceGroupForSkill?.created_by;

    if (!userId) {
      logger.warn(
        { sourceGroup },
        'Cannot install skill: no user associated with group',
      );
      const errorResult = JSON.stringify({
        success: false,
        error: 'No user associated with this group',
      });
      const tmpPath = `${resultFilePath}.tmp`;
      fs.mkdirSync(path.dirname(resultFilePath), { recursive: true });
      fs.writeFileSync(tmpPath, errorResult);
      fs.renameSync(tmpPath, resultFilePath);
      return;
    }

    try {
      const result = await installSkillForUser(userId, pkg);
      const tmpPath = `${resultFilePath}.tmp`;
      fs.mkdirSync(path.dirname(resultFilePath), { recursive: true });
      fs.writeFileSync(tmpPath, JSON.stringify(result));
      fs.renameSync(tmpPath, resultFilePath);
      logger.info(
        { sourceGroup, userId, pkg, success: result.success },
        'Skill installation via IPC completed',
      );
    } catch (err) {
      const errorResult = JSON.stringify({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
      const tmpPath = `${resultFilePath}.tmp`;
      fs.mkdirSync(path.dirname(resultFilePath), { recursive: true });
      fs.writeFileSync(tmpPath, errorResult);
      fs.renameSync(tmpPath, resultFilePath);
      logger.error(
        { sourceGroup, userId, pkg, err },
        'Skill installation via IPC failed',
      );
    }
  } else {
    logger.warn(
      { data },
      'Invalid install_skill request - missing required fields',
    );
  }
}

export async function processIpcUninstallSkill(
  input: IpcSkillRegistryInput,
): Promise<void> {
  const { data, sourceGroup, getRegisteredGroups, SAFE_REQUEST_ID_RE } = input;
  if (data.skillId && data.requestId) {
    const skillId = data.skillId;
    const requestId = data.requestId;
    if (!SAFE_REQUEST_ID_RE.test(requestId)) {
      logger.warn(
        { sourceGroup, requestId },
        'Rejected uninstall_skill request with invalid requestId',
      );
      return;
    }
    const tasksDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'tasks');
    const tasksDirResolved = path.resolve(tasksDir);
    const resultFileName = `uninstall_skill_result_${requestId}.json`;
    const resultFilePath = path.resolve(tasksDir, resultFileName);
    if (!resultFilePath.startsWith(`${tasksDirResolved}${path.sep}`)) {
      logger.warn(
        { sourceGroup, requestId, resultFilePath },
        'Rejected uninstall_skill request with unsafe result file path',
      );
      return;
    }

    const sourceGroupForUninstall = Object.values(getRegisteredGroups()).find(
      (g) => g.folder === sourceGroup,
    );
    const userId = sourceGroupForUninstall?.created_by;

    if (!userId) {
      logger.warn(
        { sourceGroup },
        'Cannot uninstall skill: no user associated with group',
      );
      const errorResult = JSON.stringify({
        success: false,
        error: 'No user associated with this group',
      });
      const tmpPath = `${resultFilePath}.tmp`;
      fs.mkdirSync(path.dirname(resultFilePath), { recursive: true });
      fs.writeFileSync(tmpPath, errorResult);
      fs.renameSync(tmpPath, resultFilePath);
      return;
    }

    const result = await deleteSkillForUser(userId, skillId);
    const tmpPath = `${resultFilePath}.tmp`;
    fs.mkdirSync(path.dirname(resultFilePath), { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(result));
    fs.renameSync(tmpPath, resultFilePath);
    logger.info(
      { sourceGroup, userId, skillId, success: result.success },
      'Skill uninstall via IPC completed',
    );
  } else {
    logger.warn(
      { data },
      'Invalid uninstall_skill request - missing required fields',
    );
  }
}
