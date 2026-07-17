import { NextRequest, NextResponse } from 'next/server';
import { recordAttemptOutcome } from '@/lib/attempt-outcomes';
import { requireLocalAdmin } from '@/lib/admin-auth';

export async function PATCH(req: NextRequest, context: { params: Promise<{ attemptId: string }> }) {
  const denied = requireLocalAdmin(req);
  if (denied) return denied;
  const { attemptId } = await context.params;
  const body = await req.json();
  const common = {
    participantId: body.participantId, runId: body.runId,
    assignmentId: body.assignmentId, attemptId,
  };
  if (!common.participantId || !common.runId || !common.assignmentId) {
    return NextResponse.json({ error: 'Missing participant/run/assignment IDs' }, { status: 400 });
  }
  try {
    if (body.action !== 'accept' && body.action !== 'invalidate') {
      throw new Error('Action must be accept or invalidate');
    }
    const result = await recordAttemptOutcome({
      ...common,
      outcome: body.action === 'accept' ? 'succeeded' : 'recording_problem',
      reason: body.reason || (body.action === 'invalidate' ? 'operator_invalidated' : undefined),
    });
    return NextResponse.json({ attempt: result.attempt });
  } catch (error: unknown) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Update failed' }, { status: 400 });
  }
}
