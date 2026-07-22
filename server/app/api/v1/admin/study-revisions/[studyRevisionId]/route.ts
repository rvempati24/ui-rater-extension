import { NextRequest, NextResponse } from 'next/server';
import { errorEnvelope } from '@ui-rater/contracts';
import { requireLocalAdmin } from '@/lib/admin-auth';
import { getStudyRevisionRegistration } from '@/lib/study-revisions';

export async function GET(req: NextRequest, context: { params: Promise<{ studyRevisionId: string }> }) {
  const denied = requireLocalAdmin(req);
  if (denied) return denied;
  const { studyRevisionId } = await context.params;
  try {
    const current = await getStudyRevisionRegistration(studyRevisionId);
    if (!current) return NextResponse.json({ error: { code: 'study_revision_not_found', message: 'Study revision was not found', retryable: false } }, { status: 404 });
    return NextResponse.json(current);
  } catch (error: unknown) {
    return NextResponse.json(errorEnvelope(error), { status: 500 });
  }
}
