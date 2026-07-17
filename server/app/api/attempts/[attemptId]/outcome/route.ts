import { NextRequest, NextResponse } from 'next/server';
import { recordAttemptOutcome } from '@/lib/attempt-outcomes';
import type { AttemptOutcome } from '@/lib/participant-state';

const OUTCOMES = new Set<AttemptOutcome>([
  'succeeded', 'failed_retry', 'failed_no_retry', 'skipped', 'recording_problem',
]);

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ attemptId: string }> }
) {
  const { attemptId } = await context.params;
  const body = await req.json();
  const outcome = body.outcome as AttemptOutcome;
  if (![body.participantId, body.runId, body.assignmentId].every(
    (value) => typeof value === 'string'
  ) || !OUTCOMES.has(outcome)) {
    return NextResponse.json({ error: 'Missing IDs or invalid outcome' }, { status: 400 });
  }
  try {
    const result = await recordAttemptOutcome({
      participantId: body.participantId,
      runId: body.runId,
      assignmentId: body.assignmentId,
      attemptId,
      outcome,
      reason: typeof body.reason === 'string' ? body.reason.slice(0, 500) : undefined,
    });
    return NextResponse.json({
      ok: true,
      idempotent: result.idempotent,
      attempt: result.attempt,
      task: result.task,
      runCompleted: result.runCompleted,
      advance: result.task.status !== 'pending',
      retry: result.task.status === 'pending',
    });
  } catch (error: unknown) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : 'Could not record outcome',
    }, { status: 409 });
  }
}
