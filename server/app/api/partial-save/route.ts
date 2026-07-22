import { NextRequest, NextResponse } from 'next/server';
import { InteractionEvent } from '@/types';
import { appendSessionTraceBatch } from '@/lib/sessions';
import { getAttempt } from '@/lib/participant-store';
import { requireCapability } from '@/lib/capabilities';
import { withResultsLock } from '@/lib/results';

async function saveLegacyPartial(body: Record<string, unknown>) {
  const { participantId, trialIndex, view_start, interactions } = body;
  if (typeof participantId !== 'string' || typeof trialIndex !== 'number') {
    return NextResponse.json({ error: 'Missing legacy partial-save IDs' }, { status: 400 });
  }
  if (interactions !== undefined && !Array.isArray(interactions)) {
    return NextResponse.json({ error: 'Legacy interactions must be an array' }, { status: 400 });
  }
  await withResultsLock(async (data) => {
    const trial = data[participantId]?.trials.find((candidate) => candidate.index === trialIndex);
    if (!trial) throw new Error('Legacy trial not found');
    if (trial.completed) return;
    if (typeof view_start === 'string' && !trial.view_start) trial.view_start = view_start;
    if (Array.isArray(interactions) && interactions.length >= trial.interactions.length) {
      trial.interactions = interactions.slice(0, 100_000) as InteractionEvent[];
    }
  });
  return NextResponse.json({ ok: true, mode: 'legacy-web' });
}

export async function POST(req: NextRequest) {
  try {
    const raw = await req.text();
    if (raw.length > 2 * 1024 * 1024) {
      return NextResponse.json({ error: 'Trace batch request exceeds 2 MB' }, { status: 413 });
    }
    const body = JSON.parse(raw);
    const {
      sessionId, participantId, trialIndex, view_start, batchId, events,
      runId, assignmentId, attemptId, attemptNumber,
    } = body;

    const hasManagedId = [sessionId, runId, assignmentId, attemptId]
      .some((value) => value !== undefined && value !== null);
    if (!hasManagedId) return await saveLegacyPartial(body);

    if (![participantId, sessionId, runId, assignmentId, attemptId].every(
      (value) => typeof value === 'string'
    ) || typeof trialIndex !== 'number' || !Number.isInteger(attemptNumber)) {
      return NextResponse.json({ error: 'Missing or invalid partial-save IDs' }, { status: 400 });
    }

    const canonical = await getAttempt(participantId, runId, assignmentId, attemptId);
    await requireCapability(req, 'attempt', attemptId);
    if (canonical.attempt.session_id !== sessionId
      || canonical.attempt.attempt_number !== attemptNumber
      || canonical.task.position !== trialIndex) {
      return NextResponse.json({ error: 'Partial-save IDs do not match the attempt' }, { status: 409 });
    }
    if (canonical.attempt.status !== 'recording') {
      // Delayed partial requests from an older retry are expected. They are a
      // successful no-op and must not replace the current legacy session/trace.
      return NextResponse.json({ ok: true, ignored: 'attempt_finalized' });
    }

    if (typeof batchId !== 'string' || !Array.isArray(events)) {
      return NextResponse.json({ error: 'Missing trace batchId or events' }, { status: 400 });
    }
    const result = await appendSessionTraceBatch(sessionId, batchId, events as InteractionEvent[], {
        participant_id: participantId,
        trial_index: trialIndex,
        view_start,
        status: 'recording',
        run_id: runId,
        assignment_id: assignmentId,
        attempt_id: attemptId,
        attempt_number: attemptNumber,
        attempt_status: 'recording',
        task_status: 'pending',
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (error: unknown) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : 'Partial save failed',
    }, { status: 400 });
  }
}
