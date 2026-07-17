import { NextRequest, NextResponse } from 'next/server';
import { recordAttemptOutcome } from '@/lib/attempt-outcomes';

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ attemptId: string }> }
) {
  const { attemptId } = await context.params;
  const body = await req.json();
  if (!body.participantId || !body.runId || !body.assignmentId) {
    return NextResponse.json({ error: 'Missing participant/run/assignment IDs' }, { status: 400 });
  }
  try {
    const result = await recordAttemptOutcome({
      participantId: body.participantId, runId: body.runId,
      assignmentId: body.assignmentId, attemptId, outcome: 'recording_problem',
      reason: body.reason || 'operator_retry',
    });
    return NextResponse.json({ ok: true, attempt: result.attempt });
  } catch (error: unknown) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not invalidate attempt' }, { status: 400 });
  }
}
