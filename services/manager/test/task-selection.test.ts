import test from 'node:test';
import assert from 'node:assert/strict';
import { makeStudyRevisionTasks, selectArtifactTasks } from '../src/domain/task-selection.ts';

const tasks = [1, 2, 3].map((position) => ({
  websiteTaskId: `wst_${position}`, sourcePosition: position, prompt: `Task ${position}`,
  slug: `task-${position}`, group: 'fixture', startPath: position === 3 ? '/deep-route' : '/',
  isMind2Web: position !== 2, taskSource: position !== 2 ? 'mind2web' : undefined,
  suggestedFlows: [],
}));

test('selection preserves source positions and deterministic random order', () => {
  assert.deepEqual(selectArtifactTasks(tasks, { kind: 'positions', positions: [3, 1] }).map((task) => task.sourceIndex), [3, 1]);
  const first = selectArtifactTasks(tasks, { kind: 'random', count: 2, seed: 'fixture' }).map((task) => task.websiteTaskId);
  const second = selectArtifactTasks(tasks, { kind: 'random', count: 2, seed: 'fixture' }).map((task) => task.websiteTaskId);
  assert.deepEqual(first, second);
  assert.deepEqual(makeStudyRevisionTasks(tasks, { kind: 'mind2web' }, 'http://d.test/').map((task) => task.position), [1, 2]);
});
