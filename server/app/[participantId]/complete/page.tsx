import { getParticipantTrials } from '@/lib/results';
import Link from 'next/link';

interface PageProps {
  params: Promise<{ participantId: string }>;
}

export default async function CompletePage({ params }: PageProps) {
  const { participantId } = await params;
  const trials = await getParticipantTrials(participantId);
  const completed = trials?.filter(t => t.completed).length ?? 0;
  const total = trials?.length ?? 0;

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="bg-white rounded-2xl shadow-md p-10 w-full max-w-md text-center">
        <div className="text-5xl mb-4">&#127881;</div>
        <h1 className="text-2xl font-semibold text-gray-900 mb-2">
          Thank You for Participating!
        </h1>
        <p className="text-gray-500 text-sm mb-6">
          You have completed the website task study.
        </p>
        {total > 0 && (
          <div className="text-sm text-gray-600 mb-8 space-y-1">
            <p>
              Tasks completed:{' '}
              <span className="font-semibold text-gray-900">{completed}</span> of{' '}
              <span className="font-semibold text-gray-900">{total}</span>
            </p>
          </div>
        )}
        <p className="text-xs text-gray-400">
          Participant ID: <span className="font-mono">{participantId}</span>
        </p>
        {completed < total && total > 0 && (
          <div className="mt-6">
            <p className="text-sm text-yellow-600 mb-3">
              You have {total - completed} unfinished task{total - completed !== 1 ? 's' : ''}.
            </p>
            <Link
              href={`/${participantId}/1`}
              className="text-sm text-blue-600 hover:underline"
            >
              Go back to trials
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
