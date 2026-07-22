import { NextRequest, NextResponse } from 'next/server';
import { requestLauncherShutdown } from '@/lib/launcher-shutdown';
import { getRun } from '@/lib/participant-store';
import { requireCapability } from '@/lib/capabilities';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ runId: string }> }
) {
  const { runId } = await context.params;
  const body = await req.json().catch(() => ({}));
  const participantId = typeof body.participantId === 'string' ? body.participantId : '';
  if (!SAFE_ID.test(runId) || !SAFE_ID.test(participantId)) {
    return NextResponse.json({ error: 'Invalid participant or run ID' }, { status: 400 });
  }
  const found = await getRun(participantId, runId);
  try { await requireCapability(req, 'run', runId); }
  catch (error: unknown) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Unauthorized' }, { status: 401 });
  }
  if (!found) return NextResponse.json({ error: 'Run not found' }, { status: 404 });
  if (found.run.status !== 'completed') {
    return NextResponse.json({ error: 'Run is not completed' }, { status: 409 });
  }
  return NextResponse.json({ ok: true, shutdown_requested: await requestLauncherShutdown(runId) });
}
