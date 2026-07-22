import { NextRequest, NextResponse } from 'next/server';
import { errorEnvelope } from '@ui-rater/contracts';
import { requireLocalAdmin } from '@/lib/admin-auth';
import { closeStudyRevision } from '@/lib/study-revisions';

export async function POST(req: NextRequest, context: { params: Promise<{ studyRevisionId: string }> }) {
  const denied = requireLocalAdmin(req);
  if (denied) return denied;
  try {
    return NextResponse.json({ registration: await closeStudyRevision((await context.params).studyRevisionId) });
  } catch (error: unknown) {
    const code = (error as { code?: string }).code;
    const status = code === 'study_revision_not_found' ? 404 : code === 'study_already_retired' ? 409 : 500;
    return NextResponse.json(errorEnvelope(error), { status });
  }
}
