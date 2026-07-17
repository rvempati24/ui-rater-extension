import { NextRequest, NextResponse } from 'next/server';
import { isValidParticipant } from '@/lib/participants';
import { getTrialConfigs } from '@/lib/manifest';
import { getActiveWebsiteMetadata } from '@/lib/website-metadata';
import { createRun, listRuns } from '@/lib/participant-store';
import { withResultsLock } from '@/lib/results';
import { generateTrials } from '@/lib/trials';

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ participantId: string }> }
) {
  const { participantId } = await context.params;
  try { return NextResponse.json({ runs: await listRuns(participantId) }); }
  catch (error: unknown) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not list runs' }, { status: 400 });
  }
}

export async function POST(
  _req: NextRequest,
  context: { params: Promise<{ participantId: string }> }
) {
  const { participantId } = await context.params;
  if (!(await isValidParticipant(participantId))) {
    return NextResponse.json({ error: 'Invalid participant ID' }, { status: 404 });
  }
  try {
    const configs = await getTrialConfigs();
    const created = await createRun(participantId, configs, await getActiveWebsiteMetadata());
    await withResultsLock(async (data) => {
      data[participantId] = { run_id: created.run.run_id, trials: generateTrials(configs) };
    });
    return NextResponse.json({
      runId: created.run.run_id, runStatus: created.run.status,
      tasks: created.tasks, currentTaskIndex: 0, totalTasks: created.tasks.length,
    }, { status: 201 });
  } catch (error: unknown) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not create run' }, { status: 400 });
  }
}
