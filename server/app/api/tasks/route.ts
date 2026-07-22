import { NextResponse } from 'next/server';

/**
 * The pre-v1 task bootstrap route depended on process-global trial and
 * website metadata.  Runs are now admitted and materialized by the Manager
 * through the versioned /api/v1 contract.
 */
export async function GET() {
  return NextResponse.json({
    error: {
      code: 'legacy_tasks_route_removed',
      message: 'Use /api/v1/participants/:participantId/runs with a Study Revision',
      retryable: false,
    },
  }, { status: 410 });
}
