import { NextResponse } from 'next/server';
import fs from 'fs/promises';
import { RESULTS_PATH } from '@/lib/paths';

const TMP_PATH = RESULTS_PATH + '.tmp';

export async function POST() {
  await fs.writeFile(TMP_PATH, '{}', 'utf-8');
  await fs.rename(TMP_PATH, RESULTS_PATH);
  return NextResponse.json({ ok: true, message: 'results.json reset to {}' });
}
