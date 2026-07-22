import { NextRequest, NextResponse } from 'next/server';
import { errorEnvelope } from '@ui-rater/contracts';
import { requireCapability, capabilityFor } from '@/lib/capabilities';
import { getRun } from '@/lib/participant-store';

export async function GET(req: NextRequest, context: { params: Promise<{ participantId: string; participantRunId: string }> }) {
  const { participantId, participantRunId } = await context.params;
  try {
    await requireCapability(req, 'run', participantRunId);
    const current = await getRun(participantId, participantRunId);
    if (!current) return NextResponse.json({ error: { code: 'participant_run_not_found', message: 'Participant Run was not found', retryable: false } }, { status: 404 });
    const tasks = current.tasks.map((task) => ({ ...task, target_url: task.target_url || task.site_url }));
    const currentTaskIndex = tasks.findIndex((task) => task.status === 'pending');
    return NextResponse.json({
      participantId,
      participantRunId: current.run.run_id,
      runId: current.run.run_id,
      runStatus: current.run.status,
      studyRevisionId: current.run.study_revision_id,
      studyRevisionDigest: current.run.study_revision_digest,
      runCapability: await capabilityFor('run', current.run.run_id),
      tasks,
      currentTaskIndex: currentTaskIndex === -1 ? tasks.length : currentTaskIndex,
      totalTasks: tasks.length,
    });
  } catch (error: unknown) {
    const code = (error as { code?: string }).code;
    return NextResponse.json(errorEnvelope(error), { status: code === 'participant_run_not_found' ? 404 : 401 });
  }
}
