import { NextRequest, NextResponse } from 'next/server';
import { invalidateAttempt } from '@/lib/participant-store';

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
    const attempt = await invalidateAttempt({
      participantId: body.participantId, runId: body.runId,
      assignmentId: body.assignmentId, attemptId, reason: body.reason || 'operator_retry',
    });
    return NextResponse.json({ ok: true, attempt });
  } catch (error: unknown) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not invalidate attempt' }, { status: 400 });
  }
}
