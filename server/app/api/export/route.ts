import { NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';

const RESULTS_PATH = path.join(process.cwd(), 'data', 'results.json');

export async function GET() {
  try {
    const raw = await fs.readFile(RESULTS_PATH, 'utf-8');
    const all = JSON.parse(raw) as Record<string, Record<string, unknown>>;

    // Only include participants with task trials, not old comparison-arena data.
    const filtered: Record<string, unknown> = {};
    for (const [pid, data] of Object.entries(all)) {
      if (data && 'trials' in data) {
        filtered[pid] = data;
      }
    }

    return new NextResponse(JSON.stringify(filtered, null, 2), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="task-trace-results_${new Date().toISOString().slice(0, 10)}.json"`,
      },
    });
  } catch {
    return NextResponse.json({ error: 'results.json not found' }, { status: 404 });
  }
}
