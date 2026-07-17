import fs from 'fs/promises';
import path from 'path';
import { applyAttemptOutcome, getAttempt } from './participant-store.ts';
import { projectLegacyTrial } from './participant-state.ts';
import type { AttemptOutcome } from './participant-state.ts';
import { updateManifest } from './sessions.ts';
import { withResultsLock } from './results.ts';

export interface RecordAttemptOutcomeInput {
  participantId: string;
  runId: string;
  assignmentId: string;
  attemptId: string;
  outcome: AttemptOutcome;
  reason?: string;
}

async function requestLauncherShutdown(runId: string): Promise<void> {
  const file = process.env.UI_RATER_SHUTDOWN_FILE;
  if (!file) return;
  const target = path.resolve(file);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify({ run_id: runId, completed_at: new Date().toISOString() }));
  await fs.rename(temporary, target);
}

/**
 * The single application-level outcome mutation. The participant tree is the
 * canonical record; session and results files are compatibility projections.
 * Replaying the same outcome repairs either projection without creating a new
 * attempt.
 */
export async function recordAttemptOutcome(input: RecordAttemptOutcomeInput) {
  const result = await applyAttemptOutcome(input);

  await updateManifest(result.attempt.session_id, {
    attempt_status: result.attempt.status,
    task_status: result.task.status,
    outcome: result.attempt.outcome,
    outcome_reason: result.attempt.reason,
    outcome_at: result.attempt.outcome_at,
  });

  await withResultsLock(async (data) => {
    const participant = data[input.participantId];
    if (participant?.run_id && participant.run_id !== input.runId) return;
    const trial = participant?.trials?.find(
      (candidate) => candidate.index === result.task.position
    );
    if (!trial) return;

    let projectedAttempt = result.attempt;
    if (result.task.status === 'completed' && result.task.accepted_attempt_id
      && result.task.accepted_attempt_id !== result.attempt.attempt_id) {
      projectedAttempt = (await getAttempt(
        input.participantId, input.runId, input.assignmentId, result.task.accepted_attempt_id
      )).attempt;
    } else if (result.task.status !== 'pending'
      && result.task.outcome !== result.attempt.outcome) {
      return;
    }
    Object.assign(trial, projectLegacyTrial(trial, projectedAttempt, result.task));
  });

  if (result.runCompleted) await requestLauncherShutdown(input.runId);

  return result;
}
