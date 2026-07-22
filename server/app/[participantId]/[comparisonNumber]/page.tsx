import { redirect } from 'next/navigation';
import { isValidParticipant } from '@/lib/participants';
import { getActiveRun } from '@/lib/participant-store';
import { projectRunTrials } from '@/lib/run-projections';
import TrialView from './TrialView';

interface PageProps {
  params: Promise<{ participantId: string; comparisonNumber: string }>;
}

export default async function TrialPage({ params }: PageProps) {
  const { participantId, comparisonNumber: numStr } = await params;

  const valid = await isValidParticipant(participantId);
  if (!valid) redirect('/');

  const activeRun = await getActiveRun(participantId);
  const trials = activeRun ? projectRunTrials(activeRun.run, activeRun.tasks) : [];

  if (!trials || trials.length === 0) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
        <div className="bg-white rounded-2xl shadow-md p-10 w-full max-w-md text-center">
          <h1 className="text-xl font-semibold text-gray-900 mb-2">No Trials Configured</h1>
          <p className="text-gray-500 text-sm mb-4">
            No active Participant Run is configured for this participant. Ask the study operator to start or resume one.
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
