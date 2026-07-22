import { NextRequest, NextResponse } from 'next/server';
import { getRunUploadStatus, uploadCompletedRun } from '@/lib/hf-run-upload';
import { requireCapability } from '@/lib/capabilities';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function participantId(req: NextRequest): string | null {
  const value = req.nextUrl.searchParams.get('participantId');
  return value && SAFE_ID.test(value) ? value : null;
}

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ runId: string }> }
) {
  const { runId } = await context.params;
  const participant = participantId(req);
  if (!SAFE_ID.test(runId) || !participant) {
    return NextResponse.json({ error: 'Invalid participant or run ID' }, { status: 400 });
  }
  try {
    await requireCapability(req, 'run', runId);
    return NextResponse.json(await getRunUploadStatus(participant, runId));
  } catch (error: unknown) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : 'Could not read upload status',
    }, { status: 404 });
  }
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ runId: string }> }
) {
  const { runId } = await context.params;
  const body = await req.json().catch(() => ({}));
  const participant = typeof body.participantId === 'string' && SAFE_ID.test(body.participantId)
    ? body.participantId : null;
  if (!SAFE_ID.test(runId) || !participant) {
    return NextResponse.json({ error: 'Invalid participant or run ID' }, { status: 400 });
  }
  try {
    await requireCapability(req, 'run', runId);
    return NextResponse.json({ ok: true, sync: await uploadCompletedRun(participant, runId) });
  } catch (error: unknown) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : 'Could not upload the completed run',
    }, { status: 409 });
  }
}
