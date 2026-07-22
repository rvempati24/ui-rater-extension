import type { StudyRevisionTask, StudyTaskSelector, WebsiteTaskDescriptor } from '@ui-rater/contracts';

function hashSeed(seed: string): number {
  let hash = 2166136261;
  for (const char of seed) { hash ^= char.codePointAt(0)!; hash = Math.imul(hash, 16777619); }
  return hash >>> 0;
}

function seededRandom(seed: string): () => number {
  let state = hashSeed(seed);
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

export interface SelectedTask extends WebsiteTaskDescriptor { sourceIndex: number }

export function selectArtifactTasks(tasks: WebsiteTaskDescriptor[], selector: StudyTaskSelector): SelectedTask[] {
  if (!tasks.length) throw new Error('Website artifact has no tasks');
  let candidates = tasks.map((task, index) => ({ task, sourceIndex: task.sourcePosition || index + 1 }));
  if (selector.kind === 'mind2web') {
    candidates = candidates.filter(({ task }) => task.isMind2Web === true || task.taskSource?.toLowerCase() === 'mind2web');
    if (!candidates.length) throw new Error('No Mind2Web tasks found in the immutable artifact catalog');
  }
  if (selector.kind === 'positions') {
    const byPosition = new Map(candidates.map((candidate) => [candidate.sourceIndex, candidate]));
    const missing = (selector.positions || []).filter((position) => !byPosition.has(position));
    if (missing.length) throw new Error(`Task position(s) unavailable: ${missing.join(', ')}`);
    candidates = (selector.positions || []).map((position) => byPosition.get(position)!);
  }
  if (selector.kind === 'random') {
    const random = seededRandom(selector.seed || 'manager-default');
    for (let index = candidates.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(random() * (index + 1));
      [candidates[index], candidates[swapIndex]] = [candidates[swapIndex], candidates[index]];
    }
    candidates = candidates.slice(0, selector.count);
  }
  return candidates.map(({ task, sourceIndex }) => ({ ...task, sourceIndex }));
}

export function makeStudyRevisionTasks(
  tasks: WebsiteTaskDescriptor[],
  selector: StudyTaskSelector,
  baseUrl: string,
): StudyRevisionTask[] {
  const selected = selectArtifactTasks(tasks, selector);
  return selected.map((task, index) => ({
    websiteTaskId: task.websiteTaskId,
    sourcePosition: task.sourceIndex,
    position: index + 1,
    prompt: task.prompt,
    slug: task.slug,
    group: task.group,
    targetUrl: new URL(task.startPath, baseUrl).href,
    isMind2Web: task.isMind2Web,
    taskSource: task.taskSource,
    legacyAppId: task.legacyAppId,
    suggestedFlows: task.suggestedFlows,
  }));
}
