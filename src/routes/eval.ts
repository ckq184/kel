import { Hono } from 'hono';

import type { Variables } from '../web-context.js';
import type { AuthUser } from '../types.js';
import { authMiddleware, systemConfigMiddleware } from '../middleware/auth.js';
import { getDefaultEvalStore } from '../eval-store.js';
import { startEvalRun, getEvalTriggerState } from '../eval-trigger.js';
import { validateGoldenSet, type GoldenSet } from '../eval-dataset.js';
import {
  validateAcceptanceSet,
  type AcceptanceQuery,
} from '../harness-probe.js';

/**
 * Native evaluation center API (task AB; web trigger added by task AC).
 *
 * Offline runs land in eval.db from scripts/eval-auto-recall.ts (spawned as
 * an external-executor child process by the trigger endpoints) and observed
 * turns from src/turn-observer.ts; both share eval.db with this route through
 * per-process connections.
 *
 * ACL (task AQ, 2026-11-17, supersedes the task AB split): every endpoint
 * below — including the read-only offline Runs endpoints — requires
 * manage_system_config (the Monitor page precedent). Task AB had opened the
 * Runs endpoints to all logged-in users; the user reversed that decision,
 * see docs/task-aq-eval-admin-only-plan.md.
 */

const RUN_NAME_PATTERN = /^[\w-]{1,64}$/;

const evalRoutes = new Hono<{ Variables: Variables }>();

// GET /runs — offline eval run list, newest first
evalRoutes.get('/runs', authMiddleware, systemConfigMiddleware, (c) => {
  const limitParam = Number(c.req.query('limit') ?? '100');
  const limit =
    Number.isInteger(limitParam) && limitParam >= 1
      ? Math.min(limitParam, 200)
      : 100;
  return c.json({ runs: getDefaultEvalStore().listRuns(limit) });
});

// GET /runs/:id — one run with its per-query items
evalRoutes.get('/runs/:id', authMiddleware, systemConfigMiddleware, (c) => {
  const loaded = getDefaultEvalStore().getRun(c.req.param('id'));
  if (!loaded) return c.json({ error: 'run not found' }, 404);
  return c.json(loaded);
});

// GET /comparison?ids=a,b,c — side-by-side overall metrics per run
evalRoutes.get('/comparison', authMiddleware, systemConfigMiddleware, (c) => {
  const idsRaw = c.req.query('ids');
  if (!idsRaw || !idsRaw.trim()) {
    return c.json({ error: 'ids query parameter is required' }, 400);
  }
  const ids = idsRaw
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
    .slice(0, 10);
  return c.json({ comparison: getDefaultEvalStore().compareRuns(ids) });
});

// ── Managed golden sets (task AD; admin only — may carry real user
// memory content). Create/update run the same validateGoldenSet chain as the
// harness; issues are returned verbatim so the editor can list them.

const DATASET_NAME_PATTERN = /^[\w-]{1,64}$/;

evalRoutes.get('/datasets', authMiddleware, systemConfigMiddleware, (c) =>
  c.json({ datasets: getDefaultEvalStore().listDatasets() }),
);

evalRoutes.get(
  '/datasets/:name',
  authMiddleware,
  systemConfigMiddleware,
  (c) => {
    const dataset = getDefaultEvalStore().getDataset(c.req.param('name'));
    if (!dataset) return c.json({ error: 'dataset not found' }, 404);
    return c.json(dataset);
  },
);

evalRoutes.post(
  '/datasets',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    let body: { name?: unknown; description?: unknown; data?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    if (
      typeof body.name !== 'string' ||
      !DATASET_NAME_PATTERN.test(body.name.trim())
    ) {
      return c.json({ error: 'name must match [\\w-] and be 1-64 chars' }, 400);
    }
    const data = body.data as GoldenSet | undefined;
    if (!data)
      return c.json(
        { error: 'invalid dataset', issues: ['data is required'] },
        400,
      );
    const issues = validateGoldenSet(data);
    if (issues.length > 0)
      return c.json({ error: 'invalid dataset', issues }, 400);
    getDefaultEvalStore().upsertDataset({
      name: body.name.trim(),
      description:
        typeof body.description === 'string' ? body.description : null,
      data,
      source: 'manual',
    });
    return c.json({ ok: true }, 201);
  },
);

evalRoutes.put(
  '/datasets/:name',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    const name = c.req.param('name');
    const existing = getDefaultEvalStore().getDataset(name);
    if (!existing) return c.json({ error: 'dataset not found' }, 404);
    let body: { description?: unknown; data?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    const data = body.data as GoldenSet | undefined;
    if (!data)
      return c.json(
        { error: 'invalid dataset', issues: ['data is required'] },
        400,
      );
    const issues = validateGoldenSet(data);
    if (issues.length > 0)
      return c.json({ error: 'invalid dataset', issues }, 400);
    getDefaultEvalStore().upsertDataset({
      name,
      description:
        typeof body.description === 'string' ? body.description : null,
      data,
      // Editor updates keep the set's provenance (builtin stays builtin).
      source: existing.source,
    });
    return c.json({ ok: true });
  },
);

evalRoutes.delete(
  '/datasets/:name',
  authMiddleware,
  systemConfigMiddleware,
  (c) => {
    const outcome = getDefaultEvalStore().deleteDataset(c.req.param('name'));
    if (outcome === 'not_found') {
      return c.json({ error: 'dataset not found' }, 404);
    }
    if (outcome === 'builtin') {
      return c.json({ error: 'builtin dataset cannot be deleted' }, 409);
    }
    return c.json({ ok: true });
  },
);

// POST /runs/trigger — spawn the offline eval harness (admin only, cost-bearing).
// Arguments are whitelist-validated here; the trigger itself is single-run
// mutexed and turns its injection surface only on these checked values.
evalRoutes.post(
  '/runs/trigger',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    let body: {
      k?: unknown;
      runName?: unknown;
      reset?: unknown;
      dataset?: unknown;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    const k = body.k;
    if (typeof k !== 'number' || !Number.isInteger(k) || k < 1 || k > 10) {
      return c.json({ error: 'k must be an integer between 1 and 10' }, 400);
    }
    const runName = typeof body.runName === 'string' ? body.runName.trim() : '';
    if (!RUN_NAME_PATTERN.test(runName)) {
      return c.json(
        { error: 'runName must match [\\w-] and be 1-64 chars' },
        400,
      );
    }
    const reset = body.reset === true;
    const datasetRaw =
      typeof body.dataset === 'string' && body.dataset.trim()
        ? body.dataset.trim()
        : 'auto-recall';
    if (!DATASET_NAME_PATTERN.test(datasetRaw)) {
      return c.json(
        { error: 'dataset must match [\\w-] and be 1-64 chars' },
        400,
      );
    }

    const authUser = c.get('user') as AuthUser;
    const started = startEvalRun({
      k,
      runName,
      reset,
      dataset: datasetRaw,
      startedBy: authUser.username,
    });
    if (!started.ok) {
      return c.json({ error: 'An eval run is already in progress' }, 409);
    }
    return c.json({ accepted: true, k, runName, reset }, 202);
  },
);

// GET /runs/trigger/status — trigger snapshot + log tail (admin only; lines
// can echo golden-query text fragments).
evalRoutes.get(
  '/runs/trigger/status',
  authMiddleware,
  systemConfigMiddleware,
  (c) => c.json(getEvalTriggerState()),
);

// GET /turns — observed real-conversation turns (manage_system_config only)
evalRoutes.get('/turns', authMiddleware, systemConfigMiddleware, (c) => {
  const workspaceJid = c.req.query('workspace') || undefined;
  const channel = c.req.query('channel') || undefined;
  const recallInjected = c.req.query('recallInjected') === 'true';
  const judgeRaw = c.req.query('judge');
  const judge =
    judgeRaw === 'judged' || judgeRaw === 'pending' ? judgeRaw : undefined;
  const limitParam = Number(c.req.query('limit') ?? '50');
  const offsetParam = Number(c.req.query('offset') ?? '0');
  const result = getDefaultEvalStore().listTurns({
    workspaceJid,
    channel,
    ...(recallInjected ? { recallInjected: true } : {}),
    ...(judge ? { judge } : {}),
    limit: Number.isInteger(limitParam) && limitParam >= 1 ? limitParam : 50,
    offset: Number.isInteger(offsetParam) && offsetParam >= 0 ? offsetParam : 0,
  });
  return c.json(result);
});

// ── Harness adapter lifecycle (task AE, RSI Phase 1; admin only — adoption
// is the explicit human gate that writes into the sensitive data/ area).
//
// Proposals land here from scripts/eval-harness-evolve.ts; adoption validates
// the body (leak markers, byte cap), flips the state machine, appends an
// immutable version row, writes the runner-facing file, and best-effort
// distils a lesson (cue/lesson/evidence all mandatory — anything less is
// dropped, harness² rule).

import { randomUUID } from 'node:crypto';

import {
  validateAdapterMd,
  writeAdapterFile,
  readAdapterFile,
} from '../harness-adapter-store.js';
import {
  reflectPrompt,
  parseReflectResponse,
  buildUnifiedDiff,
  type EvidenceTurn,
} from '../harness-proposer.js';
import { getAutoMemoryHostConfig } from '../auto-memory-config.js';
import { createJudgeLlmClient } from '../recall-judge.js';
import {
  startHarnessEvolveRun,
  getHarnessEvolveTriggerState,
  WORKSPACE_JID_PATTERN,
} from '../harness-evolve-trigger.js';

async function distilLesson(proposal: {
  id: string;
  workspaceJid: string;
  adapterMd: string;
  rationale: string;
  evidence: Array<{
    turnId: string;
    inputExcerpt: string;
    outputExcerpt: string;
    why: string;
  }>;
}): Promise<void> {
  try {
    const config = getAutoMemoryHostConfig();
    if (!config.enabled || !config.llm) return;
    const client = createJudgeLlmClient(config.llm);
    const turns: EvidenceTurn[] = proposal.evidence.map((item) => ({
      turnId: item.turnId,
      inputText: item.inputExcerpt,
      outputText: item.outputExcerpt,
      channel: '',
      createdAt: '',
    }));
    const raw = await client.complete(
      reflectPrompt({
        adapterMd: proposal.adapterMd,
        rationale: proposal.rationale,
        turns,
      }),
    );
    const lesson = parseReflectResponse(raw);
    if (!lesson) return;
    getDefaultEvalStore().insertHarnessLesson({
      id: `hl_${randomUUID()}`,
      workspaceJid: proposal.workspaceJid,
      cue: lesson.cue,
      lesson: lesson.lesson,
      evidence: lesson.evidence,
      confidence: lesson.confidence,
      proposalId: proposal.id,
    });
  } catch {
    // Lesson distillation is best-effort; a broken endpoint must never fail
    // the adoption itself.
  }
}

evalRoutes.get(
  '/harness/proposals',
  authMiddleware,
  systemConfigMiddleware,
  (c) => {
    const workspace = c.req.query('workspace');
    if (!workspace || !workspace.trim()) {
      return c.json({ error: 'workspace query parameter is required' }, 400);
    }
    return c.json({
      proposals: getDefaultEvalStore().listHarnessProposals(workspace),
    });
  },
);

evalRoutes.get(
  '/harness/proposals/:id',
  authMiddleware,
  systemConfigMiddleware,
  (c) => {
    const store = getDefaultEvalStore();
    const proposal = store.getHarnessProposal(c.req.param('id'));
    if (!proposal) return c.json({ error: 'proposal not found' }, 404);
    // Task AG: attach the latest probe summary so the detail view can badge
    // the verdict without pulling full rounds (those live on /harness/probes).
    const latest = store.listHarnessProbes(proposal.id, 1)[0] ?? null;
    return c.json({
      ...proposal,
      latestProbe: latest
        ? {
            id: latest.id,
            verdict: latest.verdict,
            roundsWon: latest.roundsWon,
            roundsLost: latest.roundsLost,
            roundsTied: latest.roundsTied,
            notesBaselineHit: latest.notesBaselineHit,
            notesProposedHit: latest.notesProposedHit,
            costUsd: latest.costUsd,
            model: latest.model,
            createdAt: latest.createdAt,
          }
        : null,
    });
  },
);

evalRoutes.post(
  '/harness/proposals/:id/adopt',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    const store = getDefaultEvalStore();
    const proposal = store.getHarnessProposal(c.req.param('id'));
    if (!proposal) return c.json({ error: 'proposal not found' }, 404);
    if (proposal.keepBase) {
      return c.json({ error: 'keep_base proposal has nothing to adopt' }, 400);
    }
    const validation = validateAdapterMd(proposal.adapterMd);
    if (!validation.ok) {
      return c.json(
        { error: 'adapter validation failed', issues: validation.issues },
        400,
      );
    }
    const actor = c.get('user')?.id ?? 'unknown';
    const decided = store.decideHarnessProposal(c.req.param('id'), {
      status: 'adopted',
      decidedBy: actor,
    });
    if (decided !== 'ok') {
      return c.json({ error: `proposal decision rejected (${decided})` }, 409);
    }
    const version = store.insertHarnessVersion({
      workspaceJid: proposal.workspaceJid,
      proposalId: proposal.id,
      adapterMd: proposal.adapterMd,
      adoptedBy: actor,
    });
    writeAdapterFile(
      proposal.workspaceJid,
      proposal.adapterMd,
      version.version,
    );
    // Fire-and-forget: the LLM distillation round-trip must not hold the
    // adoption response open (a slow endpoint made the first click look
    // failed and the retry hit the state machine's 409). distilLesson
    // catches everything internally; the lesson lands when it lands.
    void distilLesson(proposal);
    return c.json({ ok: true, version: version.version });
  },
);

evalRoutes.post(
  '/harness/proposals/:id/reject',
  authMiddleware,
  systemConfigMiddleware,
  (c) => {
    const decided = getDefaultEvalStore().decideHarnessProposal(
      c.req.param('id'),
      { status: 'rejected', decidedBy: c.get('user')?.id ?? 'unknown' },
    );
    if (decided === 'not_found') {
      return c.json({ error: 'proposal not found' }, 404);
    }
    if (decided !== 'ok') {
      return c.json({ error: `proposal decision rejected (${decided})` }, 409);
    }
    return c.json({ ok: true });
  },
);

evalRoutes.get(
  '/harness/versions',
  authMiddleware,
  systemConfigMiddleware,
  (c) => {
    const workspace = c.req.query('workspace');
    if (!workspace || !workspace.trim()) {
      return c.json({ error: 'workspace query parameter is required' }, 400);
    }
    const store = getDefaultEvalStore();
    const versions = store.listHarnessVersions(workspace);
    // Active is the file-side pointer (rollback re-points it, history stays).
    const activeVersion = readAdapterFile(workspace)?.version ?? null;
    return c.json({
      versions: versions.map((version) => ({
        ...version,
        active: activeVersion === version.version,
      })),
    });
  },
);

evalRoutes.post(
  '/harness/versions/:id/rollback',
  authMiddleware,
  systemConfigMiddleware,
  (c) => {
    const workspace = c.req.query('workspace');
    if (!workspace || !workspace.trim()) {
      return c.json({ error: 'workspace query parameter is required' }, 400);
    }
    const store = getDefaultEvalStore();
    const target = store
      .listHarnessVersions(workspace)
      .find((version) => version.id === c.req.param('id'));
    if (!target) return c.json({ error: 'version not found' }, 404);
    writeAdapterFile(workspace, target.adapterMd, target.version);
    return c.json({ ok: true, version: target.version });
  },
);

// GET /harness/lessons — read-only lesson list (admin only)
evalRoutes.get(
  '/harness/lessons',
  authMiddleware,
  systemConfigMiddleware,
  (c) => {
    const workspace = c.req.query('workspace');
    if (!workspace || !workspace.trim()) {
      return c.json({ error: 'workspace query parameter is required' }, 400);
    }
    return c.json({
      lessons: getDefaultEvalStore().listHarnessLessons(workspace),
    });
  },
);

// GET /harness/workspaces — workspaces with turns or proposals (task AF;
// feeds the Web tab's selector so JIDs never need to be typed by hand).
evalRoutes.get(
  '/harness/workspaces',
  authMiddleware,
  systemConfigMiddleware,
  (c) => c.json({ workspaces: getDefaultEvalStore().listHarnessWorkspaces() }),
);

// ── Harness probe (task AG, RSI Phase 2; admin only). Acceptance sets and
// probe reports are grader material — the proposer CLI has no read path to
// them (leak discipline, plan §1-5): only the admin surface and the manual
// probe CLI reach these tables.

evalRoutes.get(
  '/harness/acceptance/:workspace',
  authMiddleware,
  systemConfigMiddleware,
  (c) => {
    const record = getDefaultEvalStore().getAcceptanceSet(
      c.req.param('workspace'),
    );
    if (!record) return c.json({ error: 'acceptance set not found' }, 404);
    return c.json(record);
  },
);

evalRoutes.put(
  '/harness/acceptance/:workspace',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    let body: { queries?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    const validation = validateAcceptanceSet(body.queries);
    if (!validation.ok) {
      return c.json(
        { error: 'invalid acceptance set', issues: validation.issues },
        400,
      );
    }
    getDefaultEvalStore().upsertAcceptanceSet({
      workspaceJid: c.req.param('workspace'),
      queries: body.queries as AcceptanceQuery[],
    });
    return c.json({ ok: true });
  },
);

// GET /harness/probes?proposal=<id> — probe reports for one proposal (the
// detail view's latestProbe summary is the pointer; full rounds live here).
evalRoutes.get(
  '/harness/probes',
  authMiddleware,
  systemConfigMiddleware,
  (c) => {
    const proposal = c.req.query('proposal');
    if (!proposal || !proposal.trim()) {
      return c.json({ error: 'proposal query parameter is required' }, 400);
    }
    return c.json({
      probes: getDefaultEvalStore().listHarnessProbes(proposal),
    });
  },
);

// ── Task AH (RSI Phase 3): cross-workspace reuse + one-click propose.
// All admin only — the clone is a cost-free but cross-workspace information
// flow (adapter bodies can carry source-workspace business detail), the
// evidence counter echoes observed turn fragments, and the evolve trigger
// spends one real proposer LLM call.

// POST /harness/versions/:id/clone?workspace=<source> — clone any historical
// version into ANOTHER workspace as a PENDING proposal (plan §1-4). The
// proposal gate holds: nothing here writes the target adapter file; the clone
// walks the same human review + probe flow as any other proposal.
evalRoutes.post(
  '/harness/versions/:id/clone',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    const source = c.req.query('workspace');
    if (!source || !source.trim()) {
      return c.json({ error: 'workspace query parameter is required' }, 400);
    }
    let body: { targetWorkspace?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    const target =
      typeof body.targetWorkspace === 'string'
        ? body.targetWorkspace.trim()
        : '';
    if (!target) {
      return c.json({ error: 'targetWorkspace is required' }, 400);
    }
    if (target === source) {
      return c.json(
        { error: 'targetWorkspace must differ from the source workspace' },
        400,
      );
    }
    const store = getDefaultEvalStore();
    const version = store
      .listHarnessVersions(source)
      .find((row) => row.id === c.req.param('id'));
    if (!version) return c.json({ error: 'version not found' }, 404);

    // Baseline = what the target workspace actually runs today (file-side
    // pointer; 0 when it has no adapter yet).
    const targetFile = readAdapterFile(target);
    const id = `hp_${randomUUID()}`;
    store.insertHarnessProposal({
      id,
      workspaceJid: target,
      adapterMd: version.adapterMd,
      keepBase: false,
      diff: buildUnifiedDiff(targetFile?.text ?? null, version.adapterMd),
      rationale: `克隆自 ${source} v${version.version}（跨 workspace 复用，走正常人审+探针）。`,
      evidence: [],
      baselineVersion: targetFile?.version ?? 0,
      model: 'clone',
      promptHash: 'clone',
    });
    return c.json({ ok: true, proposal: { id, workspaceJid: target } }, 201);
  },
);

// GET /harness/evidence-status?workspace=<jid> — dynamic banner feed (plan
// §1-6): turns accumulated since the last proposal. The ≥10 threshold is a
// pure frontend concern; no config surface.
evalRoutes.get(
  '/harness/evidence-status',
  authMiddleware,
  systemConfigMiddleware,
  (c) => {
    const workspace = c.req.query('workspace');
    if (!workspace || !workspace.trim()) {
      return c.json({ error: 'workspace query parameter is required' }, 400);
    }
    const store = getDefaultEvalStore();
    const lastProposalAt =
      store.listHarnessProposals(workspace, 1)[0]?.createdAt ?? null;
    return c.json({
      turnsSinceLastProposal: store.countTurnsSince(workspace, lastProposalAt),
      lastProposalAt,
      activeVersion: readAdapterFile(workspace)?.version ?? 0,
    });
  },
);

// POST /harness/evolve/trigger — one-click propose (plan §1-5): spawn the
// evolve CLI as a child process via src/harness-evolve-trigger.ts. Cost: one
// proposer LLM call. Single-flight (409 while a run is in flight); the
// workspace is JID-whitelisted so the spawn argv stays injection-safe.
evalRoutes.post(
  '/harness/evolve/trigger',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    let body: { workspace?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    const workspace =
      typeof body.workspace === 'string' ? body.workspace.trim() : '';
    if (!workspace) {
      return c.json({ error: 'workspace is required' }, 400);
    }
    if (!WORKSPACE_JID_PATTERN.test(workspace)) {
      return c.json(
        { error: 'workspace must be a JID of [\\w:@.-]{1,128}' },
        400,
      );
    }
    const authUser = c.get('user') as AuthUser;
    const started = startHarnessEvolveRun({
      workspace,
      startedBy: authUser.username,
    });
    if (!started.ok) {
      if (started.error === 'busy') {
        return c.json(
          { error: 'A harness evolve run is already in progress' },
          409,
        );
      }
      return c.json({ error: 'invalid workspace' }, 400);
    }
    return c.json({ accepted: true, workspace }, 202);
  },
);

// GET /harness/evolve/status — trigger snapshot + log tail (admin only; lines
// can echo evidence fragments from the CLI stderr).
evalRoutes.get(
  '/harness/evolve/status',
  authMiddleware,
  systemConfigMiddleware,
  (c) => c.json(getHarnessEvolveTriggerState()),
);

export default evalRoutes;
