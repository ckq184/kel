// Test fake for the mem0 sidecar protocol: speaks the same JSON-lines
// contract as python/auto_memory_sidecar.py without needing mem0ai.
import { createInterface } from 'node:readline';

let ready = false;

for await (const line of createInterface({ input: process.stdin })) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  let request;
  try {
    request = JSON.parse(trimmed);
  } catch {
    continue;
  }
  const { op, id } = request;
  if (op === 'init') {
    // The python sidecar reads base_url/api_key/model (snake_case, per its
    // documented protocol). Reject camelCase senders so a protocol drift
    // between the Node bridge and the sidecar fails tests, not production.
    const endpointOk = (endpoint) =>
      endpoint &&
      typeof endpoint.base_url === 'string' &&
      typeof endpoint.api_key === 'string' &&
      typeof endpoint.model === 'string';
    if (
      !endpointOk(request.config?.llm) ||
      !endpointOk(request.config?.embedder)
    ) {
      process.stdout.write(
        `${JSON.stringify({
          id,
          ok: false,
          error:
            'init endpoints must use snake_case keys (base_url/api_key/model)',
        })}\n`,
      );
      process.exit(1);
    }
    ready = true;
    process.stdout.write(
      `${JSON.stringify({ id, ok: true, result: 'ready' })}\n`,
    );
    continue;
  }
  if (op === 'ping') {
    // mem0Telemetry echoes the spawn env so manager tests can pin
    // MEM0_TELEMETRY=false (fixed-path qdrant store collision fix).
    process.stdout.write(
      `${JSON.stringify({
        id,
        ok: true,
        result: {
          ready,
          mem0Telemetry: process.env.MEM0_TELEMETRY ?? null,
        },
      })}\n`,
    );
    continue;
  }
  if (!ready) {
    process.stdout.write(
      `${JSON.stringify({ id, ok: false, error: 'sidecar not initialized' })}\n`,
    );
    continue;
  }
  if (op === 'add') {
    process.stdout.write(
      `${JSON.stringify({ id, ok: true, result: { captured: true } })}\n`,
    );
    continue;
  }
  if (op === 'search') {
    process.stdout.write(
      `${JSON.stringify({
        id,
        ok: true,
        result: [
          {
            id: 'mem-1',
            memory: 'User prefers TypeScript (from fake sidecar)',
            score: 0.9,
          },
        ],
      })}\n`,
    );
    continue;
  }
  if (op === 'get') {
    process.stdout.write(
      `${JSON.stringify({
        id,
        ok: true,
        result: {
          id: request.args?.memory_id ?? 'mem-1',
          memory: 'fake memory',
        },
      })}\n`,
    );
    continue;
  }
  if (op === 'list') {
    // Mirrors the python sidecar's list semantics (task W): page over a
    // fixed fixture by limit/offset, return a bare array like search does.
    const limit =
      typeof request.args?.limit === 'number' ? request.args.limit : 20;
    const offset =
      typeof request.args?.offset === 'number' ? request.args.offset : 0;
    const items = [
      {
        id: 'fake-mem-1',
        memory: 'first fake memory',
        created_at: '2026-01-01',
      },
      {
        id: 'fake-mem-2',
        memory: 'second fake memory',
        created_at: '2026-01-02',
      },
      {
        id: 'fake-mem-3',
        memory: 'third fake memory',
        created_at: '2026-01-03',
      },
    ];
    process.stdout.write(
      `${JSON.stringify({
        id,
        ok: true,
        result: items.slice(offset, offset + limit),
      })}\n`,
    );
    continue;
  }
  process.stdout.write(
    `${JSON.stringify({ id, ok: false, error: `unknown op: ${op}` })}\n`,
  );
}
