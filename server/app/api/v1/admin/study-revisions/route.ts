import { NextRequest, NextResponse } from 'next/server';
import { errorEnvelope } from '@ui-rater/contracts';
import { requireLocalAdmin } from '@/lib/admin-auth';
import { registerStudyRevision } from '@/lib/study-revisions';

function statusFor(error: unknown): number {
  const code = (error as { code?: string }).code;
  if (code === 'study_revision_conflict' || code === 'idempotency_key_reused') return 409;
  if (code === 'study_revision_not_found') return 404;
  if (code === 'invalid_id' || code === 'invalid_request') return 400;
  return 500;
}

export async function POST(req: NextRequest) {
  const denied = requireLocalAdmin(req);
  if (denied) return denied;
  const key = req.headers.get('idempotency-key');
  if (!key) return NextResponse.json({ error: { code: 'missing_idempotency_key', message: 'Idempotency-Key is required', retryable: false } }, { status: 400 });
  try {
    const result = await registerStudyRevision(await req.json(), key);
    return NextResponse.json({ registration: result.registration }, { status: result.created ? 201 : 200 });
  } catch (error: unknown) {
    return NextResponse.json(errorEnvelope(error), { status: statusFor(error) });
  }
}
