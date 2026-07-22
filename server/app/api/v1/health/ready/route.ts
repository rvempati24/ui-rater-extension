import { NextResponse } from 'next/server';
import { getCollectionServiceIdentity } from '@/lib/service-identity';
import fs from 'node:fs/promises';
import { PARTICIPANT_DATA_DIR, STUDY_REVISIONS_DIR } from '@/lib/paths';
import { participantRegistry } from '@/lib/participants';

export async function GET() {
  try {
    const serviceInstanceId = await getCollectionServiceIdentity();
    await Promise.all([
      fs.mkdir(PARTICIPANT_DATA_DIR, { recursive: true }),
      fs.mkdir(STUDY_REVISIONS_DIR, { recursive: true }),
      participantRegistry(),
    ]);
    await Promise.all([
      fs.access(PARTICIPANT_DATA_DIR, 2),
      fs.access(STUDY_REVISIONS_DIR, 2),
    ]);
    return NextResponse.json({ status: 'ready', service: 'collection', serviceInstanceId });
  } catch (error: unknown) {
    return NextResponse.json({ status: 'not_ready', service: 'collection', error: error instanceof Error ? error.message : 'not ready' }, { status: 503 });
  }
}
