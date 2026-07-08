import { NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { ResultsStore } from '@/types';

const RESULTS_PATH = path.join(process.cwd(), '..', 'data', 'results.json');

export async function GET() {
  const raw = await fs.readFile(RESULTS_PATH, 'utf-8');
  const results = JSON.parse(raw) as ResultsStore;

  const rows: string[][] = [
    ['participant_id', 'trial_index', 'slug', 'group', 'task_app', 'task_prompt', 'completed', 'duration_ms', 'view_start', 'timestamp', 'interaction_count'],
  ];

  for (const [participantId, data] of Object.entries(results)) {
    if (participantId.startsWith('T')) continue;
    for (const t of data.trials) {
      if (!t.completed) continue;

      rows.push([
        participantId,
        String(t.index),
        t.slug ?? '',
        t.group,
        t.task_app || t.plain_app,
        t.task_prompt ?? '',
        String(t.completed),
        String(t.duration_ms ?? ''),
        String(t.view_start ?? ''),
        t.timestamp ?? '',
        String(t.interactions?.length ?? 0),
      ]);
    }
  }

  const csv = rows.map(r => r.map(v => `"${v.replace(/"/g, '""')}"`).join(',')).join('\n');

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': 'attachment; filename="task-trials.csv"',
    },
  });
}
