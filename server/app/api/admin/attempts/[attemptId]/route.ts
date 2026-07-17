import { NextRequest, NextResponse } from 'next/server';
import { decideAttempt, invalidateAttempt } from '@/lib/participant-store';
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
    const attempt = body.action === 'invalidate'
      ? await invalidateAttempt({ ...common, reason: body.reason || 'operator_invalidated' })
      : await decideAttempt({ ...common, action: body.action, reason: body.reason });
    return NextResponse.json({ attempt });
  } catch (error: unknown) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Update failed' }, { status: 400 });
  }
}
