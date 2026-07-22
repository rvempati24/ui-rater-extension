import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';
import { getSessionDir } from '@/lib/sessions';
import { requireLocalAdmin } from '@/lib/admin-auth';

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ sessionId: string }> }
) {
  const denied = requireLocalAdmin(req);
  if (denied) return denied;
  const { sessionId } = await context.params;
  return NextResponse.json({
    error: 'The server-side analyzer is retired. Materialize a versioned case and run scripts/run-ux-experiment.sh.',
    sessionId,
  }, { status: 410 });
}

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ sessionId: string }> }
) {
  const denied = requireLocalAdmin(req);
  if (denied) return denied;
  try {
    const { sessionId } = await context.params;
    const raw = await fs.readFile(path.join(getSessionDir(sessionId), 'analysis', 'findings.json'), 'utf8');
    return NextResponse.json(JSON.parse(raw));
  } catch {
    return NextResponse.json({ error: 'Analysis has not completed' }, { status: 404 });
  }
}
