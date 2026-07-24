import { NextRequest, NextResponse } from 'next/server';
import { withResultsLock } from '@/lib/results';
import { InteractionEvent, IssueMarker } from '@/types';

function normalizeMarkers(raw: unknown): IssueMarker[] | null {
  if (!Array.isArray(raw)) return null;
  const markers: IssueMarker[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const ts = (item as { ts_ms?: unknown }).ts_ms;
    if (typeof ts !== 'number' || !Number.isFinite(ts) || ts < 0) continue;
    const noteRaw = (item as { note?: unknown }).note;
    const createdRaw = (item as { created_at?: unknown }).created_at;
    markers.push({
      ts_ms: Math.round(ts),
      note: typeof noteRaw === 'string' ? noteRaw.slice(0, 2000) : '',
      created_at: typeof createdRaw === 'string' ? createdRaw : new Date().toISOString(),
    });
  }
  markers.sort((a, b) => a.ts_ms - b.ts_ms);
  return markers;
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { participantId, trialIndex, view_start, duration_ms, interactions, feedback, issue_markers } = body;

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
      if (typeof duration_ms === 'number' && duration_ms > 0) {
        trial.duration_ms = duration_ms;
      } else if (trial.view_start) {
        trial.duration_ms = Date.now() - new Date(trial.view_start).getTime();
      }
      if (Array.isArray(interactions)) {
        trial.interactions = interactions as InteractionEvent[];
      }
      if (typeof feedback === 'string' && feedback.trim()) {
        trial.feedback = feedback.trim();
      }
      const markers = normalizeMarkers(issue_markers);
      if (markers) {
        trial.issue_markers = markers;
      }
    });

    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 404 });
  }
}
