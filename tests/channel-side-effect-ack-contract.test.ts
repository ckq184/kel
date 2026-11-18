import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

const source = fs.readFileSync(
  path.join(process.cwd(), 'src/index.ts'),
  'utf8',
);

function sliceBetween(start: string, end: string, from = 0): string {
  const startIndex = source.indexOf(start, from);
  expect(startIndex, `missing source marker: ${start}`).toBeGreaterThanOrEqual(
    0,
  );
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(endIndex, `missing source marker: ${end}`).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe('strict physical acknowledgement contract', () => {
  test('main and agent mirror paths await exact-target durable Outboxes and join primary ACK', () => {
    const mainMirror = sliceBetween(
      '// Optional mirror mode for explicitly bound IM channels',
      '\n              if (occupiesPrimarySlot) {',
    );
    expect(mainMirror).toContain('const mirrorScope = bindChannelOutboxScope(');
    expect(mainMirror).toContain('const delivered = await sendImWithRetry(');
    expect(mainMirror).toContain('scopeToken: mirrorScope.token');
    expect(mainMirror).toContain(
      'replyDeliveryAcknowledged &&= mirrorDeliveryAcknowledged;',
    );
    expect(mainMirror).not.toContain('sendImWithFailTracking');

    const agentMirror = sliceBetween(
      '// Optional mirror mode for linked IM channels',
      '\n        if (agentReplyDeliveryAcknowledged && occupiesPrimarySlot)',
    );
    expect(agentMirror).toContain(
      'const mirrorScope = bindChannelOutboxScope(',
    );
    expect(agentMirror).toContain('const delivered = await sendImWithRetry(');
    expect(agentMirror).toContain('scopeToken: mirrorScope.token');
    expect(agentMirror).toContain('agentMirrorDeliveryAcknowledged;');
    expect(agentMirror).not.toContain('sendImWithFailTracking');
  });
});
