import { NextRequest, NextResponse } from 'next/server';
import { saveSnapshot } from '@/lib/sessions';
import { getAttempt } from '@/lib/participant-store';
import { requireCapability } from '@/lib/capabilities';

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ sessionId: string }> }
) {
  try {
    const { sessionId } = await context.params;
    const raw = await req.text();
    if (raw.length > 8 * 1024 * 1024) throw new Error('Snapshot request exceeds 8 MB');
    const body = JSON.parse(raw);
    if (![body.participantId, body.runId, body.assignmentId, body.attemptId].every(
      (value) => typeof value === 'string'
    )) throw new Error('Snapshot ownership IDs are required');
    await requireCapability(req, 'attempt', body.attemptId);
    const canonical = await getAttempt(
      body.participantId, body.runId, body.assignmentId, body.attemptId
    );
    if (canonical.attempt.session_id !== sessionId) throw new Error('Attempt/session mismatch');
    const metadata = await saveSnapshot(sessionId, body);
    return NextResponse.json({ ok: true, snapshot: metadata });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Could not save snapshot';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
