import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import { RESULTS_PATH } from '@/lib/paths';
import { requireLocalAdmin } from '@/lib/admin-auth';

export async function GET(req: NextRequest) {
  const denied = requireLocalAdmin(req);
  if (denied) return denied;
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
