import { redirect } from 'next/navigation';
import { getParticipantTrials, withResultsLock } from '@/lib/results';
import { getTrialConfigs } from '@/lib/manifest';
import { generateTrials } from '@/lib/trials';
import { isValidParticipant } from '@/lib/participants';
import TrialView from './TrialView';

interface PageProps {
  params: Promise<{ participantId: string; comparisonNumber: string }>;
}

export default async function TrialPage({ params }: PageProps) {
  const { participantId, comparisonNumber: numStr } = await params;

  const valid = await isValidParticipant(participantId);
  if (!valid) redirect('/');

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

  if (!trials || trials.length === 0) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
        <div className="bg-white rounded-2xl shadow-md p-10 w-full max-w-md text-center">
          <h1 className="text-xl font-semibold text-gray-900 mb-2">No Trials Configured</h1>
          <p className="text-gray-500 text-sm mb-4">
            The trials config is empty. Add entries to data/trials-config.json and run the setup script.
          </p>
        </div>
      </div>
    );
  }

  const totalTrials = trials.length;
  const trialNumber = parseInt(numStr, 10);
  if (isNaN(trialNumber) || trialNumber < 1 || trialNumber > totalTrials) {
    redirect(`/${participantId}/1`);
  }

  const trial = trials.find(t => t.index === trialNumber);
  if (!trial) {
    redirect(`/${participantId}/1`);
  }

  return (
    <TrialView
      participantId={participantId}
      trialNumber={trialNumber}
      trial={trial!}
      totalTrials={totalTrials}
    />
  );
}
