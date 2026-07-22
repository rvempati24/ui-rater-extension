import { NextRequest, NextResponse } from 'next/server';
import { getParticipantData, withResultsLock } from '@/lib/results';
import { getTrialConfigs } from '@/lib/manifest';
import { generateTrials } from '@/lib/trials';
import { isValidParticipant } from '@/lib/participants';
import { createRun, getActiveRun, getRun } from '@/lib/participant-store';
import { getActiveWebsiteMetadata } from '@/lib/website-metadata';
import { capabilityFor, requireCapability } from '@/lib/capabilities';

export async function GET(req: NextRequest) {
  const participantId = req.nextUrl.searchParams.get('participantId');
  const runId = req.nextUrl.searchParams.get('runId');
  if (!participantId) {
    return NextResponse.json({ error: 'Missing participantId' }, { status: 400 });
  }

  const valid = await isValidParticipant(participantId);
  if (!valid) {
    return NextResponse.json({ error: 'Invalid participant ID' }, { status: 404 });
  }

  const configs = await getTrialConfigs();
  let managed = runId ? await getRun(participantId, runId) : await getActiveRun(participantId);
  if (runId && !managed) {
    return NextResponse.json({ error: 'Run not found for participant' }, { status: 404 });
  }
  if (runId) {
    try { await requireCapability(req, 'run', runId); }
    catch (error: unknown) {
      return NextResponse.json({ error: error instanceof Error ? error.message : 'Unauthorized' }, { status: 401 });
    }
  }
  const createdRun = !managed;
  if (!managed) managed = await createRun(
    participantId, configs, await getActiveWebsiteMetadata(), 'bootstrap-v1'
  );
  if (managed.run.status === 'aborted' || managed.run.status === 'archived') {
    return NextResponse.json({ error: `Run is ${managed.run.status}; start a new run` }, { status: 409 });
  }

  const existingResults = await getParticipantData(participantId);
  let trials = existingResults?.trials ?? null;

  if (createdRun || existingResults?.run_id !== managed.run.run_id || !trials?.length) {
    trials = await withResultsLock(async (data) => {
      const current = data[participantId];
      if (!createdRun && current?.run_id === managed.run.run_id && current.trials.length > 0) {
        return current.trials;
      }
      const generated = generateTrials(configs);
      data[participantId] = { run_id: managed.run.run_id, trials: generated };
      return generated;
    });
  }

  const tasks = managed.tasks.map((task) => ({
    task_prompt: task.task_prompt, site_url: task.site_url, group: task.group, slug: task.slug,
    assignment_id: task.assignment_id, position: task.position,
    source_position: task.source_position,
    accepted_attempt_id: task.accepted_attempt_id, attempt_count: task.attempt_count,
    status: task.status,
    outcome: task.outcome,
    reason: task.reason,
  }));
  const currentTaskIndex = managed.tasks.findIndex((task) => task.status === 'pending');

  return NextResponse.json({
    runId: managed.run.run_id,
    runCapability: await capabilityFor('run', managed.run.run_id),
    runStatus: managed.run.status,
    tasks,
    currentTaskIndex: currentTaskIndex === -1 ? tasks.length : currentTaskIndex,
    totalTasks: tasks.length,
  });
}
