const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const modulePath = pathToFileURL(path.join(
  __dirname, '..', 'server', 'scripts', 'task-selection.mjs'
)).href;

const tasks = [
  { slug: 'one', task_prompt: 'First native task', source: 'mind2web' },
  { slug: 'two', task_prompt: 'Extra generated task' },
  { slug: 'three', task_prompt: 'Third native task' },
  { slug: 'four', task_prompt: 'Another extra task' },
  { slug: 'five', task_prompt: 'Fifth native task', is_mind2web: true },
];

test('task numbers preserve the requested order and use source indices', async () => {
  const { selectTasks } = await import(modulePath);
  const selected = selectTasks(tasks, { taskNumbers: [1, 3, 5] });
  assert.deepEqual(selected.sourceIndices, [1, 3, 5]);
  assert.deepEqual(selected.tasks.map((task) => task.slug), ['one', 'three', 'five']);
  assert.deepEqual(selected.tasks.map((task) => task.source_position), [1, 3, 5]);
});

test('Mind2Web selection recognizes metadata and adjacent prompt lists', async () => {
  const { parseMind2WebPrompts, selectTasks } = await import(modulePath);
  const mind2webPrompts = parseMind2WebPrompts('1. Third native task.\n');
  const selected = selectTasks(tasks, { mind2webOnly: true, mind2webPrompts });
  assert.deepEqual(selected.sourceIndices, [1, 3, 5]);
});

test('random selection is deterministic with a seed and enforces bounds', async () => {
  const { selectTasks } = await import(modulePath);
  const first = selectTasks(tasks, { randomCount: 2, seed: 'pilot-1' });
  const second = selectTasks(tasks, { randomCount: 2, seed: 'pilot-1' });
  assert.deepEqual(first.sourceIndices, second.sourceIndices);
  assert.equal(first.tasks.length, 2);
  assert.throws(() => selectTasks(tasks, { randomCount: 6, seed: 'x' }), /Cannot sample/);
});

test('task number parser accepts spaces or commas and rejects duplicates', async () => {
  const { parseTaskNumbers } = await import(modulePath);
  assert.deepEqual(parseTaskNumbers(['1', '3,5']), [1, 3, 5]);
  assert.throws(() => parseTaskNumbers(['1,1']), /duplicate/);
});
