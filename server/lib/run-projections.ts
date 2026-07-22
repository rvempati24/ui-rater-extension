import type { Trial } from '@/types';
import type { RunRecord, TaskRecord } from './participant-store.ts';

/** Compatibility projection for the legacy comparison/results views.
 * The source of truth is always the frozen Participant Run/Assignment snapshot.
 */
export function projectRunTrials(run: RunRecord, tasks: TaskRecord[]): Trial[] {
  return tasks
    .slice()
    .sort((left, right) => left.position - right.position)
    .map((task, index) => ({
      index: index + 1,
      slug: task.slug,
      group: task.group,
      task_app: task.app_id,
      task_prompt: task.task_prompt,
      site_url: task.target_url || task.site_url,
      plain_app: task.app_id,
      defect_app: '',
      defect_principle: '',
      defect_descriptions: [],
      suggested_flows: task.suggested_flows || run.study_revision?.tasks.find((candidate) => candidate.websiteTaskId === task.website_task_id)?.suggestedFlows || [],
      plain_side: 'left',
      selected_side: null,
      is_correct: null,
      agrees_with_defect: null,
      completed: task.status === 'completed',
      timestamp: task.outcome_at || null,
      view_start: null,
      duration_ms: null,
      interactions: [],
    }));
}
