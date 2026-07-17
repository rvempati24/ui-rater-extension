import { NextRequest, NextResponse } from 'next/server';
import { updateRunStatus } from '@/lib/participant-store';
import { requireLocalAdmin } from '@/lib/admin-auth';

export async function PATCH(req: NextRequest, context: { params: Promise<{ runId: string }> }) {
  const denied = requireLocalAdmin(req);
  if (denied) return denied;
  const { runId } = await context.params;
  const { participantId, status } = await req.json();
  if (!participantId || !['active', 'aborted', 'archived'].includes(status)) {
    return NextResponse.json({ error: 'Invalid participantId or run status' }, { status: 400 });
  }
  try { return NextResponse.json({ run: await updateRunStatus(participantId, runId, status) }); }
  catch (error: unknown) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Update failed' }, { status: 400 });
  }
}
