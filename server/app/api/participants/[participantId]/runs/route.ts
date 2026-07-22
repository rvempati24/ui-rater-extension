import { NextRequest, NextResponse } from 'next/server';
import { isValidParticipant } from '@/lib/participants';
import { getTrialConfigs } from '@/lib/manifest';
import { getActiveWebsiteMetadata } from '@/lib/website-metadata';
import { createRun, listRuns } from '@/lib/participant-store';
import { withResultsLock } from '@/lib/results';
import { generateTrials } from '@/lib/trials';
import { capabilityFor } from '@/lib/capabilities';
import { requireLocalAdmin } from '@/lib/admin-auth';

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ participantId: string }> }
) {
  const denied = requireLocalAdmin(req);
  if (denied) return denied;
  const { participantId } = await context.params;
  try { return NextResponse.json({ runs: await listRuns(participantId) }); }
  catch (error: unknown) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not list runs' }, { status: 400 });
  }
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ participantId: string }> }
) {
  const { participantId } = await context.params;
  if (!(await isValidParticipant(participantId))) {
    return NextResponse.json({ error: 'Invalid participant ID' }, { status: 404 });
  }
  try {
    const configs = await getTrialConfigs();
    const creationKey = req.headers.get('idempotency-key') || undefined;
    if (!creationKey) {
      return NextResponse.json({ error: 'Idempotency-Key is required' }, { status: 400 });
    }
    const created = await createRun(
      participantId, configs, await getActiveWebsiteMetadata(), creationKey
    );
    await withResultsLock(async (data) => {
      if (data[participantId]?.run_id === created.run.run_id
          && data[participantId].trials?.length) return;
      data[participantId] = { run_id: created.run.run_id, trials: generateTrials(configs) };
    });
    return NextResponse.json({
      runId: created.run.run_id, runStatus: created.run.status,
      runCapability: await capabilityFor('run', created.run.run_id),
      tasks: created.tasks, currentTaskIndex: 0, totalTasks: created.tasks.length,
    }, { status: 201 });
  } catch (error: unknown) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not create run' }, { status: 400 });
  }
}
