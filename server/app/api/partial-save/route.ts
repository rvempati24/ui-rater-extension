import { NextRequest, NextResponse } from 'next/server';
import { withResultsLock } from '@/lib/results';
import { InteractionEvent } from '@/types';
import { saveSessionTrace } from '@/lib/sessions';
import { getAttempt } from '@/lib/participant-store';

export async function POST(req: NextRequest) {
  try {
    const body = JSON.parse(await req.text());
    const { sessionId, participantId, trialIndex, view_start, interactions, runId, assignmentId, attemptId, attemptNumber } = body;

    if (![participantId, sessionId, runId, assignmentId, attemptId].every(
      (value) => typeof value === 'string'
    ) || typeof trialIndex !== 'number' || !Number.isInteger(attemptNumber)) {
      return NextResponse.json({ error: 'Missing or invalid partial-save IDs' }, { status: 400 });
    }

    const canonical = await getAttempt(participantId, runId, assignmentId, attemptId);
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

    if (typeof sessionId === 'string' && Array.isArray(interactions)) {
      await saveSessionTrace(sessionId, interactions as InteractionEvent[], {
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
    }

    await withResultsLock(async (data) => {
      if (data[participantId]?.run_id && data[participantId].run_id !== runId) return;
      const trial = data[participantId]?.trials
        .find(t => t.index === trialIndex);
      if (!trial) return;

      // A delayed partial request must never overwrite a completed task.
      if (trial.completed) return;

      if (view_start && !trial.view_start) {
        trial.view_start = view_start;
      }
      if (Array.isArray(interactions) && interactions.length >= trial.interactions.length) {
        trial.interactions = interactions as InteractionEvent[];
      }
      if (typeof sessionId === 'string') trial.session_id = sessionId;
    });
  } catch (error: unknown) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : 'Partial save failed',
    }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}
