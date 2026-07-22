import { NextResponse } from 'next/server';

/**
 * Kept as a migration sentinel so old clients receive an explicit response.
 * Participant Run completion is a Collection state transition; it never
 * controls the lifetime of Website, Collection, or Manager processes.
 */
export async function POST() {
  return NextResponse.json({
    error: {
      code: 'launcher_lifecycle_removed',
      message: 'Launcher lifecycle control was removed; the Participant Run is already terminal after outcome submission.',
      retryable: false,
    },
  }, { status: 410 });
}
