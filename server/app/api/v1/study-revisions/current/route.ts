import { NextResponse } from 'next/server';
import { errorEnvelope } from '@ui-rater/contracts';
import { getCurrentStudyRevision } from '@/lib/study-revisions';

export async function GET() {
  try {
    const current = await getCurrentStudyRevision();
    if (!current) {
      return NextResponse.json(
        { error: { code: 'study_revision_not_found', message: 'No accepting Study Revision was found', retryable: false } },
        { status: 404 },
      );
    }
    return NextResponse.json({ studyRevisionId: current.revision.studyRevisionId });
  } catch (error: unknown) {
    return NextResponse.json(errorEnvelope(error), { status: 500 });
  }
}
