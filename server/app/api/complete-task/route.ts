import { NextRequest, NextResponse } from 'next/server';
import { withResultsLock } from '@/lib/results';
import { InteractionEvent } from '@/types';
import { getParticipantTrials } from '@/lib/results';
import { saveSessionTrace } from '@/lib/sessions';
import { getTrialConfigs } from '@/lib/manifest';

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { sessionId, participantId, trialIndex, view_start, duration_ms, interactions } = body;

  if (!participantId || typeof participantId !== 'string') {
    return NextResponse.json({ error: 'Missing participantId' }, { status: 400 });
  }
  if (typeof trialIndex !== 'number') {
    return NextResponse.json({ error: 'Missing trialIndex' }, { status: 400 });
  }
  if (typeof sessionId !== 'string') {
    return NextResponse.json({ error: 'Missing sessionId' }, { status: 400 });
  }

  try {
    const trials = await getParticipantTrials(participantId);
    const task = trials?.find((trial) => trial.index === trialIndex);
    if (!task) throw new Error(`Trial ${trialIndex} not found`);
    const taskConfig = (await getTrialConfigs()).find((config) => config.slug === task.slug);

    await saveSessionTrace(sessionId, Array.isArray(interactions) ? interactions : [], {
      status: 'complete',
      participant_id: participantId,
      trial_index: trialIndex,
      app_id: task.task_app,
      task_prompt: task.task_prompt,
      site_url: task.site_url || taskConfig?.site_url,
      view_start,
      duration_ms,
      completed_at: new Date().toISOString(),
    });

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
      trial.session_id = sessionId;
    });

    return NextResponse.json({
      success: true,
      sessionId,
      analyzeUrl: `/api/sessions/${sessionId}/analyze`,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 404 });
  }
}
