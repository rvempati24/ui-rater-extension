import { NextRequest, NextResponse } from 'next/server';
import { withResultsLock } from '@/lib/results';

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { participantId, trialIndex, agrees } = body;

  if (!participantId || typeof participantId !== 'string') {
    return NextResponse.json({ error: 'Missing participantId' }, { status: 400 });
  }
  if (typeof trialIndex !== 'number') {
    return NextResponse.json({ error: 'Missing trialIndex' }, { status: 400 });
  }
  if (typeof agrees !== 'boolean') {
    return NextResponse.json({ error: 'Invalid agrees value' }, { status: 400 });
  }

  try {
    await withResultsLock(async (data) => {
      const participant = data[participantId];
      if (!participant) throw new Error(`Participant "${participantId}" not found`);

      const trial = participant.trials.find(t => t.index === trialIndex);
      if (!trial) throw new Error(`Trial ${trialIndex} not found`);

      trial.agrees_with_defect = agrees;
    });

    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 404 });
  }
}
