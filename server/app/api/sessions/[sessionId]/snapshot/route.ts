import { NextRequest, NextResponse } from 'next/server';
import { saveSnapshot } from '@/lib/sessions';

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ sessionId: string }> }
) {
  try {
    const { sessionId } = await context.params;
    const metadata = await saveSnapshot(sessionId, await req.json());
    return NextResponse.json({ ok: true, snapshot: metadata });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Could not save snapshot';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
