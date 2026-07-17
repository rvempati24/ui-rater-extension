import { NextRequest, NextResponse } from 'next/server';
import { listParticipants } from '@/lib/participant-store';
import { requireLocalAdmin } from '@/lib/admin-auth';

export async function GET(req: NextRequest) {
  const denied = requireLocalAdmin(req);
  if (denied) return denied;
  return NextResponse.json({ participants: await listParticipants() });
}
