import { Trial, TrialConfigEntry } from '@/types';

export function generateTrials(configs: TrialConfigEntry[]): Trial[] {
  const trials: Trial[] = [];

  for (const config of configs) {
    const suggestedFlows = config.suggested_flows ?? [];
    trials.push({
      index: 0,
      slug: config.slug,
      group: config.group,
      task_app: config.plain_app,
      task_prompt: config.task_prompt ?? `Complete a realistic task on the ${config.group} site.`,
      plain_app: config.plain_app,
      defect_app: '',
      defect_principle: '',
      defect_descriptions: [],
      suggested_flows: suggestedFlows,
      plain_side: 'left',
      selected_side: null,
      is_correct: null,
      agrees_with_defect: null,
      completed: false,
      timestamp: null,
      view_start: null,
      duration_ms: null,
      interactions: [],
      feedback: null,
    });
  }

  // Assign sequential indices
  trials.forEach((t, i) => { t.index = i + 1; });

  return trials;
}
