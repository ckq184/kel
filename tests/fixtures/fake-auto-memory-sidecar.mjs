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
    process.stdout.write(
      `${JSON.stringify({ id, ok: true, result: { ready } })}\n`,
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
  process.stdout.write(
    `${JSON.stringify({ id, ok: false, error: `unknown op: ${op}` })}\n`,
  );
}
