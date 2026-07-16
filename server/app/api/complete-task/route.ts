import { NextRequest, NextResponse } from 'next/server';
import { withResultsLock } from '@/lib/results';
import { InteractionEvent } from '@/types';

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { participantId, trialIndex, view_start, duration_ms, interactions, feedback } = body;

  if (!participantId || typeof participantId !== 'string') {
    return NextResponse.json({ error: 'Missing participantId' }, { status: 400 });
  }
  if (typeof trialIndex !== 'number') {
    return NextResponse.json({ error: 'Missing trialIndex' }, { status: 400 });
  }

  try {
    await withResultsLock(async (data) => {
      const participant = data[participantId];
      if (!participant) throw new Error(`Participant "${participantId}" not found`);

      const trial = participant.trials.find(t => t.index === trialIndex);
      if (!trial) throw new Error(`Trial ${trialIndex} not found`);

      trial.completed = true;
      trial.timestamp = new Date().toISOString();

      if (view_start && !trial.view_start) {
        trial.view_start = view_start;
      }
      if (typeof duration_ms === 'number' && duration_ms >= 0) {
        trial.duration_ms = duration_ms;
      }
      if (Array.isArray(interactions)) {
        trial.interactions = interactions as InteractionEvent[];
      }
      if (typeof feedback === 'string' && feedback.trim()) {
        trial.feedback = feedback.trim();
      }
    });

    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 404 });
  }
}
