import { NextRequest, NextResponse } from 'next/server';
import { getParticipantTrials, withResultsLock } from '@/lib/results';
import { getTrialConfigs } from '@/lib/manifest';
import { generateTrials } from '@/lib/trials';
import { isValidParticipant } from '@/lib/participants';
import fs from 'fs/promises';
import path from 'path';

export async function GET(req: NextRequest) {
  const participantId = req.nextUrl.searchParams.get('participantId');
  if (!participantId) {
    return NextResponse.json({ error: 'Missing participantId' }, { status: 400 });
  }

  const valid = await isValidParticipant(participantId);
  if (!valid) {
    return NextResponse.json({ error: 'Invalid participant ID' }, { status: 404 });
  }

  let trials = await getParticipantTrials(participantId);

  if (!trials || trials.length === 0) {
    trials = await withResultsLock(async (data) => {
      if (data[participantId]?.trials?.length > 0) return data[participantId].trials;
      const configs = await getTrialConfigs();
      const generated = generateTrials(configs);
      data[participantId] = { trials: generated };
      return generated;
    });
  }

  const configPath = path.join(process.cwd(), '..', 'data', 'trials-config.json');
  const trialsConfig = JSON.parse(await fs.readFile(configPath, 'utf-8'));

  const tasks = trialsConfig.map((config: { task_prompt: string; site_url?: string; group: string; slug: string }) => ({
    task_prompt: config.task_prompt,
    site_url: config.site_url ?? '',
    group: config.group,
    slug: config.slug,
  }));

  const currentTaskIndex = trials!.findIndex(t => !t.completed);

  return NextResponse.json({
    tasks,
    currentTaskIndex: currentTaskIndex === -1 ? tasks.length : currentTaskIndex,
    totalTasks: tasks.length,
  });
}
