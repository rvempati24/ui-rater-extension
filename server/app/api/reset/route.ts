import { NextRequest, NextResponse } from 'next/server';
import { requireLocalAdmin } from '@/lib/admin-auth';
import { withResultsLock } from '@/lib/results';

export async function POST(req: NextRequest) {
  const denied = requireLocalAdmin(req);
  if (denied) return denied;
  await withResultsLock(async (data) => {
    for (const key of Object.keys(data)) delete data[key];
  });
  return NextResponse.json({ ok: true, message: 'results.json reset to {}' });
}
