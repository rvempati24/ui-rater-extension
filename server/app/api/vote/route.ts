import { NextRequest, NextResponse } from 'next/server';
import { withResultsLock } from '@/lib/results';
import { InteractionEvent } from '@/types';

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { participantId, trialIndex, selected_side, view_start, duration_ms, interactions } = body;

  if (!participantId || typeof participantId !== 'string') {
    return NextResponse.json({ error: 'Missing participantId' }, { status: 400 });
  }
  if (typeof trialIndex !== 'number') {
    return NextResponse.json({ error: 'Missing trialIndex' }, { status: 400 });
  }
  if (selected_side !== 'left' && selected_side !== 'right') {
    return NextResponse.json({ error: 'Invalid selected_side' }, { status: 400 });
  }

  try {
    await withResultsLock(async (data) => {
      const participant = data[participantId];
      if (!participant) throw new Error(`Participant "${participantId}" not found`);

      const trial = participant.trials.find(t => t.index === trialIndex);
      if (!trial) throw new Error(`Trial ${trialIndex} not found`);

      trial.selected_side = selected_side;
      trial.is_correct = selected_side !== trial.plain_side;
      trial.timestamp = new Date().toISOString();

      if (view_start && !trial.view_start) {
        trial.view_start = view_start;
      }
      if (typeof duration_ms === 'number' && duration_ms >= 0) {
        trial.duration_ms = duration_ms;
      }
      if (Array.isArray(interactions) && interactions.length > 0) {
        trial.interactions = interactions as InteractionEvent[];
      }
    });

    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 404 });
  }
}
