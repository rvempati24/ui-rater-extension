export type AttemptStatus =
  | 'recording'
  | 'completed_pending_outcome'
  | 'accepted'
  | 'failed'
  | 'invalidated';

export type TaskStatus = 'pending' | 'completed' | 'skipped' | 'failed_no_retry';

export type AttemptOutcome =
  | 'succeeded'
  | 'failed_retry'
  | 'failed_no_retry'
  | 'skipped'
  | 'recording_problem';

export interface OutcomeAttemptState {
  attempt_id: string;
  status: AttemptStatus;
  outcome?: AttemptOutcome;
  reason?: string;
  outcome_at?: string;
  status_updated_at?: string;
}

export interface OutcomeTaskState {
  status: TaskStatus;
  accepted_attempt_id?: string;
  outcome?: AttemptOutcome;
  reason?: string;
  outcome_at?: string;
}

export interface OutcomeTransition<TAttempt, TTask> {
  attempt: TAttempt;
  task: TTask;
  idempotent: boolean;
}

const DEFAULT_REASONS: Partial<Record<AttemptOutcome, string>> = {
  skipped: 'participant_skipped',
  recording_problem: 'recording_problem',
  failed_retry: 'participant_reported_failure',
  failed_no_retry: 'participant_reported_failure',
};

export function isTerminalTask(status: TaskStatus): boolean {
  return status === 'completed' || status === 'skipped' || status === 'failed_no_retry';
}

export function nextAttemptNumber(attempts: Array<{ attempt_number?: number } | null>): number {
  return attempts.reduce((maximum, attempt) => Math.max(maximum, attempt?.attempt_number || 0), 0) + 1;
}

export function projectLegacyTrial<
  T extends { session_id?: string; timestamp?: string | null },
  A extends OutcomeAttemptState & { session_id: string },
  K extends OutcomeTaskState,
>(trial: T, attempt: A, task: K): T {
  if (task.status === 'pending' && trial.session_id
    && trial.session_id !== attempt.session_id) return trial;
  if (task.status !== 'pending' && task.outcome
    && task.outcome !== attempt.outcome) return trial;
  return {
    ...trial,
    session_id: task.status === 'pending' ? trial.session_id || attempt.session_id : attempt.session_id,
    outcome: task.outcome,
    outcome_reason: task.reason,
    outcome_at: task.outcome_at,
    attempt_status: attempt.status,
    task_status: task.status,
    completed: task.status !== 'pending',
    timestamp: task.status === 'pending' ? trial.timestamp : task.outcome_at || trial.timestamp,
  } as T;
}

export function applyOutcomeTransition<
  TAttempt extends OutcomeAttemptState,
  TTask extends OutcomeTaskState,
>(
  attempt: TAttempt,
  task: TTask,
  outcome: AttemptOutcome,
  reason: string | undefined,
  now: string
): OutcomeTransition<TAttempt, TTask> {
  const resolvedReason = reason?.trim() || attempt.reason || DEFAULT_REASONS[outcome];
  if (attempt.outcome) {
    if (attempt.outcome !== outcome) {
      throw new Error(`Attempt already has outcome ${attempt.outcome}`);
    }
    let replayedTask = task;
    if (outcome === 'succeeded') {
      if (task.accepted_attempt_id && task.accepted_attempt_id !== attempt.attempt_id) {
        throw new Error('Task already has another accepted attempt');
      }
      if (task.status !== 'pending' && task.status !== 'completed') {
        throw new Error(`Succeeded attempt conflicts with task status ${task.status}`);
      }
      replayedTask = {
        ...task, status: 'completed', accepted_attempt_id: attempt.attempt_id,
        outcome, reason: resolvedReason, outcome_at: attempt.outcome_at || now,
      } as TTask;
    } else if (outcome === 'skipped' || outcome === 'failed_no_retry') {
      const expectedStatus: TaskStatus = outcome === 'skipped' ? 'skipped' : 'failed_no_retry';
      if (task.status !== 'pending' && task.status !== expectedStatus) {
        throw new Error(`${outcome} attempt conflicts with task status ${task.status}`);
      }
      replayedTask = {
        ...task, status: expectedStatus, accepted_attempt_id: undefined,
        outcome, reason: resolvedReason, outcome_at: attempt.outcome_at || now,
      } as TTask;
    } else if (task.status === 'pending' && !task.outcome) {
      replayedTask = {
        ...task, accepted_attempt_id: undefined,
        outcome, reason: resolvedReason, outcome_at: attempt.outcome_at || now,
      } as TTask;
    }
    return { attempt, task: replayedTask, idempotent: true };
  }
  const mayInvalidateRecording = outcome === 'recording_problem' && attempt.status === 'recording';
  if (attempt.status !== 'completed_pending_outcome' && !mayInvalidateRecording) {
    throw new Error(`Outcome ${outcome} is invalid from attempt status ${attempt.status}`);
  }
  if (outcome === 'succeeded' && task.accepted_attempt_id && task.accepted_attempt_id !== attempt.attempt_id) {
    throw new Error('Task already has another accepted attempt');
  }
  if (task.status !== 'pending') {
    throw new Error(`Outcome ${outcome} is invalid from task status ${task.status}`);
  }

  const nextAttempt = {
    ...attempt,
    status: outcome === 'succeeded'
      ? 'accepted'
      : outcome === 'recording_problem' ? 'invalidated' : 'failed',
    outcome,
    reason: resolvedReason,
    outcome_at: now,
    status_updated_at: now,
  } as TAttempt;
  const nextTask = {
    ...task,
    status: outcome === 'succeeded'
      ? 'completed'
      : outcome === 'skipped'
        ? 'skipped'
        : outcome === 'failed_no_retry' ? 'failed_no_retry' : 'pending',
    accepted_attempt_id: outcome === 'succeeded' ? attempt.attempt_id : undefined,
    outcome,
    reason: resolvedReason,
    outcome_at: now,
  } as TTask;
  return { attempt: nextAttempt, task: nextTask, idempotent: false };
}
