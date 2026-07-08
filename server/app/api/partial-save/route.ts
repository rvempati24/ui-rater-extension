import { NextRequest, NextResponse } from 'next/server';
import { withResultsLock } from '@/lib/results';
import { InteractionEvent } from '@/types';

export async function POST(req: NextRequest) {
  try {
    const body = JSON.parse(await req.text());
    const { participantId, trialIndex, view_start, interactions } = body;

    if (!participantId || typeof trialIndex !== 'number') {
      return NextResponse.json({ ok: true });
    }

    await withResultsLock(async (data) => {
      const trial = data[participantId]?.trials
        .find(t => t.index === trialIndex);
      if (!trial) return;

      if (view_start && !trial.view_start) {
        trial.view_start = view_start;
      }
      if (Array.isArray(interactions) && interactions.length > 0) {
        trial.interactions = interactions as InteractionEvent[];
      }
    });
  } catch {
    // Best-effort
  }

  return NextResponse.json({ ok: true });
}
