import { NextResponse } from 'next/server';

/**
 * The pre-v1 participant run endpoint depended on process-global trial and
 * website metadata.  Use the Manager-admitted /api/v1 run contract instead.
 */
function removed() {
  return NextResponse.json({
    error: {
      code: 'legacy_participant_runs_route_removed',
      message: 'Use /api/v1/participants/:participantId/runs with a Study Revision',
      retryable: false,
    },
  }, { status: 410 });
}

export async function GET() {
  return removed();
}

export async function POST() {
  return removed();
}
