import { NextResponse } from 'next/server';
import fs from 'fs/promises';
import path from 'path';

const RESULTS_PATH = path.join(process.cwd(), '..', 'data', 'results.json');
const TMP_PATH = RESULTS_PATH + '.tmp';

export async function POST() {
  await fs.writeFile(TMP_PATH, '{}', 'utf-8');
  await fs.rename(TMP_PATH, RESULTS_PATH);
  return NextResponse.json({ ok: true, message: 'results.json reset to {}' });
}
