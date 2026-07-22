import { NextRequest, NextResponse } from 'next/server';
import { ContractError, errorEnvelope, assertId } from '@ui-rater/contracts';
import { isValidParticipant } from '@/lib/participants';
import { capabilityFor } from '@/lib/capabilities';
import { createRunFromStudyRevision } from '@/lib/participant-store';
import { getStudyRevisionRegistration } from '@/lib/study-revisions';

function statusFor(error: unknown): number {
  const code = (error as { code?: string }).code;
  if (code === 'study_revision_not_found' || code === 'participant_unavailable') return 404;
  if (['participant_run_active', 'study_admission_closed', 'idempotency_key_reused', 'study_revision_conflict'].includes(code || '')) return 409;
  if (code === 'invalid_id' || code === 'invalid_study_revision') return 400;
  return 500;
}

function responseFor(result: Awaited<ReturnType<typeof createRunFromStudyRevision>>) {
  const tasks = result.tasks.map((task) => ({
    ...task,
    target_url: task.target_url || task.site_url,
  }));
  const currentTaskIndex = tasks.findIndex((task) => task.status === 'pending');
  return {
    participantId: result.participant.participant_id,
    participantRunId: result.run.run_id,
    runId: result.run.run_id,
    runStatus: result.run.status,
    studyRevisionId: result.run.study_revision_id,
    studyRevisionDigest: result.run.study_revision_digest,
    runCapability: undefined as string | undefined,
    tasks,
    currentTaskIndex: currentTaskIndex === -1 ? tasks.length : currentTaskIndex,
    totalTasks: tasks.length,
    created: result.created,
  };
}

export async function POST(req: NextRequest, context: { params: Promise<{ participantId: string }> }) {
  const { participantId } = await context.params;
  if (!(await isValidParticipant(participantId))) {
    return NextResponse.json({ error: { code: 'participant_not_found', message: 'Invalid participant ID', retryable: false } }, { status: 404 });
  }
  const key = req.headers.get('idempotency-key');
  if (!key) return NextResponse.json({ error: { code: 'missing_idempotency_key', message: 'Idempotency-Key is required', retryable: false } }, { status: 400 });
  try {
    const body = await req.json() as Record<string, unknown>;
    const studyRevisionId = assertId(body.studyRevisionId, 'studyRevisionId');
    const registered = await getStudyRevisionRegistration(studyRevisionId);
    if (!registered) throw new ContractError('study_revision_not_found', 'Study revision was not found');
    const revision = registered.revision;
    const result = await createRunFromStudyRevision(participantId, revision, key);
    const response = responseFor(result);
    response.runCapability = await capabilityFor('run', result.run.run_id);
    return NextResponse.json(response, { status: result.created ? 201 : 200 });
  } catch (error: unknown) {
    return NextResponse.json(errorEnvelope(error), { status: statusFor(error) });
  }
}
