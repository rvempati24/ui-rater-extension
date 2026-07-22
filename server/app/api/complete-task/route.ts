import { NextRequest, NextResponse } from 'next/server';
import { withResultsLock } from '@/lib/results';
import { InteractionEvent } from '@/types';
import { getParticipantTrials } from '@/lib/results';
import { loadSession, normalizeRecordingTiming, saveSessionTrace } from '@/lib/sessions';
import { completeAttemptEvidence, getAttempt, getRun } from '@/lib/participant-store';
import { requireCapability } from '@/lib/capabilities';
import { projectRunTrials } from '@/lib/run-projections';

async function completeLegacyTask(body: Record<string, unknown>) {
  const { participantId, trialIndex, view_start, duration_ms, interactions } = body;
  if (typeof participantId !== 'string' || typeof trialIndex !== 'number') {
    return NextResponse.json({ error: 'Missing legacy task IDs' }, { status: 400 });
  }
  if (interactions !== undefined && !Array.isArray(interactions)) {
    return NextResponse.json({ error: 'Legacy interactions must be an array' }, { status: 400 });
  }
  await withResultsLock(async (data) => {
    const trial = data[participantId]?.trials.find((candidate) => candidate.index === trialIndex);
    if (!trial) throw new Error('Legacy trial not found');
    if (typeof view_start === 'string' && !trial.view_start) trial.view_start = view_start;
    if (typeof duration_ms === 'number' && duration_ms >= 0) trial.duration_ms = duration_ms;
    if (Array.isArray(interactions) && !trial.completed) {
      trial.interactions = interactions.slice(0, 100_000) as InteractionEvent[];
    }
    trial.completed = true;
    trial.timestamp ||= new Date().toISOString();
  });
  return NextResponse.json({ success: true, mode: 'legacy-web' });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const {
    sessionId, participantId, trialIndex, view_start, duration_ms,
    runId, assignmentId, attemptId, attemptNumber,
    recording_status, recording_error, final_flush_status, final_flush_error,
    finalization_report, intended_outcome, recording_timing,
  } = body;

  const hasManagedId = [sessionId, runId, assignmentId, attemptId]
    .some((value) => value !== undefined && value !== null);
  if (!hasManagedId) {
    try { return await completeLegacyTask(body); }
    catch (error: unknown) {
      return NextResponse.json({
        error: error instanceof Error ? error.message : 'Legacy completion failed',
      }, { status: 404 });
    }
  }

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
    await requireCapability(req, 'attempt', attemptId);
    const managedRun = await getRun(participantId, runId);
    const managedTask = managedRun?.tasks.find((candidate) => candidate.assignment_id === assignmentId);
    if (!managedTask) throw new Error(`Assignment ${assignmentId} not found`);
    const canonical = await getAttempt(participantId, runId, assignmentId, attemptId);
    if (managedTask.position !== trialIndex) throw new Error('trialIndex does not match assignment');
    if (canonical.attempt.session_id !== sessionId) throw new Error('Attempt/session mismatch');
    if (canonical.attempt.attempt_number !== attemptNumber) throw new Error('attemptNumber does not match attempt');
    const session = await loadSession(sessionId);
    const completedRecordingTiming = normalizeRecordingTiming(
      recording_timing, recording_status !== 'missing'
    );
    const isRecordingProblem = intended_outcome === 'recording_problem';
    if (!isRecordingProblem) {
      if (final_flush_status !== 'complete'
        || finalization_report?.interaction_flush !== 'acknowledged'
        || finalization_report?.task_end_snapshot !== 'acknowledged') {
        throw new Error('Evidence finalization was not fully acknowledged');
      }
      if (!session.snapshots.some((snapshot) => snapshot.reason === 'task-end')) {
        throw new Error('The required task-end screenshot is absent');
      }
    }
    const trials = await getParticipantTrials(participantId);
    const task = trials?.find((trial) => trial.index === trialIndex);
    const website = managedRun?.run.website;

    await saveSessionTrace(sessionId, session.interactions, {
      status: 'complete',
      participant_id: participantId,
      trial_index: trialIndex,
      app_id: managedTask.app_id || task?.task_app,
      task_prompt: managedTask.task_prompt,
      site_url: managedTask.target_url || managedTask.site_url || task?.site_url,
      view_start,
      duration_ms,
      completed_at: new Date().toISOString(),
      run_id: runId,
      assignment_id: assignmentId,
      attempt_id: attemptId,
      attempt_number: attemptNumber,
      attempt_status: 'completed_pending_outcome',
      task_status: 'pending',
      recording_status: recording_status === 'missing' ? 'missing' : 'saved',
      recording_error: typeof recording_error === 'string' ? recording_error.slice(0, 500) : undefined,
      final_flush_status: final_flush_status === 'unavailable' ? 'unavailable' : 'complete',
      final_flush_error: typeof final_flush_error === 'string' ? final_flush_error.slice(0, 500) : undefined,
      finalization_report: finalization_report && typeof finalization_report === 'object'
        ? finalization_report : undefined,
      recording_timing: completedRecordingTiming,
      website,
      study_revision_id: managedRun?.run.study_revision_id,
      study_revision_digest: managedRun?.run.study_revision_digest,
      website_snapshot: managedRun?.run.website_snapshot,
    });

    const managed = await completeAttemptEvidence({
      participantId, runId, assignmentId, attemptId, sessionId,
    });

    await withResultsLock(async (data) => {
      if (!data[participantId]) {
        data[participantId] = { run_id: runId, trials: projectRunTrials(managedRun!.run, managedRun!.tasks) };
      }
      const participant = data[participantId];
      if (participant.run_id && participant.run_id !== runId) return;

      const trial = participant.trials.find(t => t.index === trialIndex);
      if (!trial) return;

      if (view_start && !trial.view_start) {
        trial.view_start = view_start;
      }
      if (typeof duration_ms === 'number' && duration_ms >= 0) {
        trial.duration_ms = duration_ms;
      }
      trial.interactions = session.interactions as InteractionEvent[];
      trial.session_id = sessionId;
    });

    return NextResponse.json({
      success: true,
      sessionId,
      attemptStatus: managed.attempt.status,
      pendingOutcome: managed.attempt.status === 'completed_pending_outcome',
      outcome: managed.attempt.outcome,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 404 });
  }
}
