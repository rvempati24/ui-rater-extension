import { NextRequest, NextResponse } from 'next/server';
import { isValidParticipant } from '@/lib/participants';

export async function POST(req: NextRequest) {
  const body = await req.json();
  const participantId = typeof body?.participantId === 'string' ? body.participantId.trim() : null;

  if (!participantId) {
    return NextResponse.json({ valid: false, error: 'Missing participant ID' }, { status: 400 });
  }

  const valid = await isValidParticipant(participantId);
  return NextResponse.json({ valid });
}
