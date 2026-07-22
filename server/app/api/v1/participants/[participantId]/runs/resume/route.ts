import { NextRequest, NextResponse } from 'next/server';
import { errorEnvelope, assertId } from '@ui-rater/contracts';
import { isValidParticipant } from '@/lib/participants';
import { capabilityFor } from '@/lib/capabilities';
import { getActiveRun } from '@/lib/participant-store';

export async function POST(req: NextRequest, context: { params: Promise<{ participantId: string }> }) {
  const { participantId } = await context.params;
  if (!(await isValidParticipant(participantId))) {
    return NextResponse.json({ error: { code: 'participant_not_found', message: 'Invalid participant ID', retryable: false } }, { status: 404 });
  }
  try {
    const body = await req.json() as { studyRevisionId?: unknown };
    const studyRevisionId = assertId(body.studyRevisionId, 'studyRevisionId');
    const active = await getActiveRun(participantId);
    if (!active) return NextResponse.json({ error: { code: 'active_run_not_found', message: 'No active participant run was found', retryable: false } }, { status: 404 });
    if (active.run.study_revision_id !== studyRevisionId) {
      return NextResponse.json({ error: { code: 'participant_run_other_revision', message: 'Active run belongs to another Study Revision', retryable: false, details: { activeRunId: active.run.run_id, studyRevisionId: active.run.study_revision_id } } }, { status: 409 });
    }
    const tasks = active.tasks.map((task) => ({ ...task, target_url: task.target_url || task.site_url }));
    const currentTaskIndex = tasks.findIndex((task) => task.status === 'pending');
    return NextResponse.json({
      participantId,
      participantRunId: active.run.run_id,
      runId: active.run.run_id,
      runStatus: active.run.status,
      studyRevisionId: active.run.study_revision_id,
      studyRevisionDigest: active.run.study_revision_digest,
      runCapability: await capabilityFor('run', active.run.run_id),
      tasks,
      currentTaskIndex: currentTaskIndex === -1 ? tasks.length : currentTaskIndex,
      totalTasks: tasks.length,
      resumed: true,
    });
  } catch (error: unknown) {
    const code = (error as { code?: string }).code;
    return NextResponse.json(errorEnvelope(error), { status: code === 'invalid_id' ? 400 : 500 });
  }
}
