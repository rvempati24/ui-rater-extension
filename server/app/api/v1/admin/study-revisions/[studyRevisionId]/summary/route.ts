import { NextRequest, NextResponse } from 'next/server';
import { errorEnvelope } from '@ui-rater/contracts';
import { requireLocalAdmin } from '@/lib/admin-auth';
import { summarizeStudyRevision } from '@/lib/study-revisions';

export async function GET(req: NextRequest, context: { params: Promise<{ studyRevisionId: string }> }) {
  const denied = requireLocalAdmin(req);
  if (denied) return denied;
  try {
    return NextResponse.json(await summarizeStudyRevision((await context.params).studyRevisionId));
  } catch (error: unknown) {
    const code = (error as { code?: string }).code;
    return NextResponse.json(errorEnvelope(error), { status: code === 'study_revision_not_found' ? 404 : 500 });
  }
}
