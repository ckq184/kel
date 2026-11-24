import { describe, expect, test } from 'vitest';

import { createUsageAccumulator } from '../src/usage-accumulator.js';

describe('usage accumulator', () => {
  test('sums durationMs and numTurns across distinct eventIds', () => {
    const accumulator = createUsageAccumulator();

    accumulator.accrue('web:main\u0000reply-1', {
      eventId: 'pi:session:1',
      durationMs: 1_200,
      numTurns: 2,
    });
    accumulator.accrue('web:main\u0000reply-1', {
      eventId: 'pi:session:2',
      durationMs: 800,
      numTurns: 1,
    });
    const totals = accumulator.accrue('web:main\u0000reply-1', {
      eventId: 'pi:session:3',
      durationMs: 500,
      numTurns: 3,
    });

    expect(totals).toEqual({ durationMs: 2_500, numTurns: 6 });
  });

  test('ignores a replayed eventId instead of double counting', () => {
    const accumulator = createUsageAccumulator();
    const first = accumulator.accrue('web:main\u0000reply-1', {
      eventId: 'pi:session:1',
      durationMs: 1_200,
      numTurns: 2,
    });
    const replay = accumulator.accrue('web:main\u0000reply-1', {
      eventId: 'pi:session:1',
      durationMs: 1_200,
      numTurns: 2,
    });

    expect(replay).toEqual(first);
    expect(replay).toEqual({ durationMs: 1_200, numTurns: 2 });
  });

  test('keeps different replies isolated', () => {
    const accumulator = createUsageAccumulator();
    accumulator.accrue('web:main\u0000reply-1', {
      eventId: 'pi:session:1',
      durationMs: 1_000,
      numTurns: 1,
    });
    accumulator.accrue('web:main\u0000reply-2', {
      eventId: 'pi:session:2',
      durationMs: 300,
      numTurns: 4,
    });

    expect(
      accumulator.accrue('web:main\u0000reply-1', {
        eventId: 'pi:session:3',
        durationMs: 200,
        numTurns: 1,
      }),
    ).toEqual({ durationMs: 1_200, numTurns: 2 });
    expect(
      accumulator.accrue('web:main\u0000reply-2', {
        eventId: 'pi:session:4',
        durationMs: 100,
        numTurns: 1,
      }),
    ).toEqual({ durationMs: 400, numTurns: 5 });
  });

  test('accrues events without eventId (documented no-dedupe limitation)', () => {
    const accumulator = createUsageAccumulator();
    accumulator.accrue('web:main\u0000reply-1', {
      durationMs: 1_000,
      numTurns: 1,
    });
    const totals = accumulator.accrue('web:main\u0000reply-1', {
      durationMs: 1_000,
      numTurns: 1,
    });

    expect(totals).toEqual({ durationMs: 2_000, numTurns: 2 });
  });

  test('clamps negative and non-finite values to zero', () => {
    const accumulator = createUsageAccumulator();
    const totals = accumulator.accrue('web:main\u0000reply-1', {
      eventId: 'pi:session:1',
      durationMs: -5,
      numTurns: Number.NaN,
    });

    expect(totals).toEqual({ durationMs: 0, numTurns: 0 });
  });

  test('bounds remembered eventIds per reply while recent replays stay deduped', () => {
    const accumulator = createUsageAccumulator({ maxEventIdsPerEntry: 2 });
    accumulator.accrue('reply-1', {
      eventId: 'event-1',
      durationMs: 100,
      numTurns: 1,
    });
    accumulator.accrue('reply-1', {
      eventId: 'event-2',
      durationMs: 200,
      numTurns: 2,
    });
    // event-3 pushes event-1 out of the bounded dedupe set.
    const totals = accumulator.accrue('reply-1', {
      eventId: 'event-3',
      durationMs: 300,
      numTurns: 3,
    });
    expect(totals).toEqual({ durationMs: 600, numTurns: 6 });

    for (const eventId of ['event-2', 'event-3']) {
      expect(accumulator.accrue('reply-1', { eventId })).toEqual(totals);
    }
  });

  test('evicts the oldest key when maxEntries is exceeded', () => {
    const accumulator = createUsageAccumulator({ maxEntries: 2 });
    accumulator.accrue('reply-1', {
      eventId: 'event-1',
      durationMs: 1_000,
      numTurns: 1,
    });
    accumulator.accrue('reply-2', {
      eventId: 'event-2',
      durationMs: 2_000,
      numTurns: 1,
    });
    accumulator.accrue('reply-3', {
      eventId: 'event-3',
      durationMs: 3_000,
      numTurns: 1,
    });

    // reply-1 was evicted: a new key value starts fresh (also proves replay of
    // the evicted entry cannot resurrect the old total).
    expect(
      accumulator.accrue('reply-1', {
        eventId: 'event-4',
        durationMs: 500,
        numTurns: 1,
      }),
    ).toEqual({ durationMs: 500, numTurns: 1 });
  });
});
