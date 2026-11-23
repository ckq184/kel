/**
 * Pi 子代理适配：跨进程经 pi-subagents 扩展的 EventBus RPC 协议操作子代理。
 *
 * RPC 约定：请求发 `subagents:rpc:<op>`，响应回 `subagents:rpc:<op>:reply:<requestId>`
 * （requestId 用 UUID 关联，一次性订阅防串台）。spawn/stop 走 RPC；
 * getResult/steer 刻意抛错——协议未提供（由会话内的 get_subagent_result /
 * steer_subagent 工具在 Pi 会话内部实现）。生命周期经六个广播频道
 * （created/started/completed/failed/steered/compacted）转成 RuntimeEvent。
 */
import crypto from 'node:crypto';
import type {
  EventBus,
  ExtensionFactory,
} from '@earendil-works/pi-coding-agent';
import type { RuntimeEventListener } from '../types.js';

/**
 * ISSUE-22: under a custom endpoint every subagent inherits the parent model.
 * An explicit `model` on the Agent tool call would otherwise resolve against
 * Pi's built-in catalog (or fail as "model not found"), so it is dropped
 * before pi-subagents reads the arguments. Pi lets `tool_call` handlers
 * rewrite arguments by mutating `event.input` in place.
 */
export function createSubagentInheritModelExtension(): ExtensionFactory {
  return (pi) => {
    pi.on('tool_call', (event) => {
      if (event.toolName !== 'Agent') return;
      Reflect.deleteProperty(event.input as Record<string, unknown>, 'model');
    });
  };
}

export type SubAgentSpec = {
  type: string;
  prompt: string;
  description: string;
  runInBackground?: boolean;
  resume?: string;
  inheritContext?: boolean;
  model?: string;
};

export type SubAgentResult = {
  id: string;
  status: 'running' | 'completed' | 'failed';
  result?: string;
  error?: string;
};

/**
 * Adapter over pi-subagents' documented event-bus RPC. CKQClaw does not
 * import the extension's internal classes, so the third-party package can be
 * replaced without changing the product runtime contract.
 */
export class PiSubAgentAdapter {
  constructor(
    private readonly eventBus: EventBus,
    private readonly emitRuntimeEvent?: RuntimeEventListener,
  ) {}

  async spawn(spec: SubAgentSpec): Promise<SubAgentResult> {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const channel = `subagents:rpc:spawn:reply:${requestId}`;
      const unsubscribe = this.eventBus.on(channel, (value) => {
        unsubscribe();
        const reply = value as {
          success?: boolean;
          data?: { id?: string };
          error?: string;
        };
        if (!reply.success || !reply.data?.id) {
          reject(new Error(reply.error || 'Pi subagent spawn failed'));
          return;
        }
        resolve({ id: reply.data.id, status: 'running' });
      });
      this.eventBus.emit('subagents:rpc:spawn', {
        requestId,
        type: spec.type,
        prompt: spec.prompt,
        options: {
          description: spec.description,
          ...(spec.runInBackground !== undefined
            ? { run_in_background: spec.runInBackground }
            : {}),
          ...(spec.resume ? { resume: spec.resume } : {}),
          ...(spec.inheritContext !== undefined
            ? { inherit_context: spec.inheritContext }
            : {}),
          ...(spec.model ? { model: spec.model } : {}),
        },
      });
    });
  }

  onLifecycle(
    sessionId: string,
    listener: RuntimeEventListener = this.emitRuntimeEvent || (() => {}),
  ): () => void {
    const channels = [
      'subagents:created',
      'subagents:started',
      'subagents:completed',
      'subagents:failed',
      'subagents:steered',
      'subagents:compacted',
    ] as const;
    const unsubscribers = channels.map((channel) =>
      this.eventBus.on(channel, (data) => {
        const value = data as Record<string, unknown>;
        listener({
          type: 'subagent',
          sessionId,
          lifecycle: channel.slice('subagents:'.length) as
            | 'created'
            | 'started'
            | 'completed'
            | 'failed'
            | 'steered'
            | 'compacted',
          agentId: typeof value.id === 'string' ? value.id : undefined,
          result: typeof value.result === 'string' ? value.result : undefined,
          error: typeof value.error === 'string' ? value.error : undefined,
          details: value,
        });
      }),
    );
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }

  async getResult(_agentId: string, _wait = false): Promise<SubAgentResult> {
    throw new Error(
      'Pi subagent result lookup is exposed by get_subagent_result inside the Pi session; pi-subagents does not publish a result RPC.',
    );
  }

  async steer(agentId: string, message: string): Promise<void> {
    void agentId;
    void message;
    throw new Error(
      'Pi subagent steering is exposed by steer_subagent inside the Pi session; pi-subagents does not publish a steer RPC.',
    );
  }

  async stop(agentId: string): Promise<void> {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const channel = `subagents:rpc:stop:reply:${requestId}`;
      const unsubscribe = this.eventBus.on(channel, (value) => {
        unsubscribe();
        const reply = value as { success?: boolean; error?: string };
        if (!reply.success) {
          reject(new Error(reply.error || 'Pi subagent stop failed'));
          return;
        }
        resolve();
      });
      this.eventBus.emit('subagents:rpc:stop', {
        requestId,
        agentId,
      });
    });
  }
}
