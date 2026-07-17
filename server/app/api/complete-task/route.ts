import { NextRequest, NextResponse } from 'next/server';
import { withResultsLock } from '@/lib/results';
import { InteractionEvent } from '@/types';
import { getParticipantTrials } from '@/lib/results';
import { saveSessionTrace } from '@/lib/sessions';
import { getTrialConfigs } from '@/lib/manifest';
import { getActiveWebsiteMetadata } from '@/lib/website-metadata';
import { completeAttempt, getRun } from '@/lib/participant-store';
import { generateTrials } from '@/lib/trials';

export async function POST(req: NextRequest) {
  const body = await req.json();
  const {
    sessionId, participantId, trialIndex, view_start, duration_ms, interactions,
    runId, assignmentId, attemptId, attemptNumber,
  } = body;

  if (!participantId || typeof participantId !== 'string') {
    return NextResponse.json({ error: 'Missing participantId' }, { status: 400 });
  }
  if (typeof trialIndex !== 'number') {
    return NextResponse.json({ error: 'Missing trialIndex' }, { status: 400 });
  }
  if (typeof sessionId !== 'string') {
    return NextResponse.json({ error: 'Missing sessionId' }, { status: 400 });
  }
  if (![runId, assignmentId, attemptId].every((value) => typeof value === 'string')) {
    return NextResponse.json({ error: 'Missing runId, assignmentId, or attemptId' }, { status: 400 });
  }

  try {
    const managedRun = await getRun(participantId, runId);
    const managedTask = managedRun?.tasks.find((candidate) => candidate.assignment_id === assignmentId);
    if (!managedTask) throw new Error(`Assignment ${assignmentId} not found`);
    const trials = await getParticipantTrials(participantId);
    const task = trials?.find((trial) => trial.index === trialIndex);
    const configs = await getTrialConfigs();
    const taskConfig = configs.find((config) => config.slug === managedTask.slug);
    const website = await getActiveWebsiteMetadata();

    await saveSessionTrace(sessionId, Array.isArray(interactions) ? interactions : [], {
      status: 'complete',
      participant_id: participantId,
      trial_index: trialIndex,
      app_id: managedTask.app_id || task?.task_app,
      task_prompt: managedTask.task_prompt,
      site_url: managedTask.site_url || task?.site_url || taskConfig?.site_url,
      view_start,
      duration_ms,
      completed_at: new Date().toISOString(),
      run_id: runId,
      assignment_id: assignmentId,
      attempt_id: attemptId,
      attempt_number: attemptNumber,
      website,
    });

    const managed = await completeAttempt({
      participantId, runId, assignmentId, attemptId, sessionId,
    });

    await withResultsLock(async (data) => {
      if (!data[participantId]) data[participantId] = { trials: generateTrials(configs) };
      const participant = data[participantId];

      const trial = participant.trials.find(t => t.index === trialIndex);
      if (!trial) return;

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
      runCompleted: managed.runCompleted,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 404 });
  }
}
