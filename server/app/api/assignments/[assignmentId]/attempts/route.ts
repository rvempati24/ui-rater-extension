import { NextRequest, NextResponse } from 'next/server';
import { createAttempt } from '@/lib/participant-store';
import { capabilityFor, requireCapability } from '@/lib/capabilities';
import { normalizeRecordingTiming } from '@/lib/sessions';

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ assignmentId: string }> }
) {
  const { assignmentId } = await context.params;
  const body = await req.json();
  if (!body.participantId || !body.runId || !body.sessionId || !body.recordingTiming) {
    return NextResponse.json({ error: 'Missing participantId, runId, sessionId, or recordingTiming' }, { status: 400 });
  }
  try {
    await requireCapability(req, 'run', body.runId);
    const attempt = await createAttempt({
      participantId: body.participantId, runId: body.runId, assignmentId, sessionId: body.sessionId,
      recordingTiming: normalizeRecordingTiming(body.recordingTiming),
    });
    return NextResponse.json({
      attempt,
      attemptCapability: await capabilityFor('attempt', attempt.attempt_id),
    }, { status: 201 });
  } catch (error: unknown) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not create attempt' }, { status: 400 });
  }
}
