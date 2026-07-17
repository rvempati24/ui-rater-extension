import { NextRequest, NextResponse } from 'next/server';
import { withResultsLock } from '@/lib/results';
import { InteractionEvent } from '@/types';
import { saveSessionTrace } from '@/lib/sessions';

export async function POST(req: NextRequest) {
  try {
    const body = JSON.parse(await req.text());
    const { sessionId, participantId, trialIndex, view_start, interactions, runId, assignmentId, attemptId, attemptNumber } = body;

    if (!participantId || typeof trialIndex !== 'number') {
      return NextResponse.json({ ok: true });
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
      });
    }

    await withResultsLock(async (data) => {
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
  } catch {
    // Best-effort
  }

  return NextResponse.json({ ok: true });
}
