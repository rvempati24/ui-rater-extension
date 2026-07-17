import { NextRequest, NextResponse } from 'next/server';
import { updateParticipantStatus } from '@/lib/participant-store';
import { requireLocalAdmin } from '@/lib/admin-auth';

export async function PATCH(req: NextRequest, context: { params: Promise<{ participantId: string }> }) {
  const denied = requireLocalAdmin(req);
  if (denied) return denied;
  const { participantId } = await context.params;
  const { status } = await req.json();
  if (!['active', 'disabled', 'archived'].includes(status)) {
    return NextResponse.json({ error: 'Invalid participant status' }, { status: 400 });
  }
  try { return NextResponse.json({ participant: await updateParticipantStatus(participantId, status) }); }
  catch (error: unknown) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Update failed' }, { status: 404 });
  }
}
