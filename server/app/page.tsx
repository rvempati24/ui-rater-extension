'use client';

import { useState, FormEvent } from 'react';
import { useRouter } from 'next/navigation';

export default function HomePage() {
  const router = useRouter();
  const [slide, setSlide] = useState<1 | 2>(1);
  const [participantId, setParticipantId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmed = participantId.trim();
    if (!trimmed) {
      setError('Please enter your participant ID.');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/validate-participant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ participantId: trimmed }),
      });
      const data = await res.json();

      if (data.valid) {
        router.push(`/${trimmed}/1`);
      } else {
        setError('Invalid participant ID. Please check your ID and try again.');
        setLoading(false);
      }
    } catch {
      setError('Something went wrong. Please try again.');
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <div className="bg-white rounded-2xl shadow-md p-10 w-full max-w-lg">

        {slide === 1 && (
          <>
            <h1 className="text-2xl font-semibold text-gray-900 mb-4">Website Task Completion Study</h1>
            <p className="text-gray-700 text-sm leading-relaxed mb-6">
              We are a team of researchers studying how long realistic website tasks take to
              complete. During the study, you will see one website at a time with a specific task
              prompt. Your task is to use the website naturally and press Done when you believe
              the task is complete.
            </p>
            <p className="text-gray-700 text-sm leading-relaxed mb-6">
              This experiment should be completed on a desktop computer. Your data will be anonymized
              and used strictly for research purposes.
            </p>
            <p className="text-gray-500 text-sm mb-8">
              By pressing the <span className="font-medium text-gray-700">&quot;Consent &amp; Continue&quot;</span> button,
              you declare that you have read and understood the information above. You confirm that you
              will be concentrating on the task and complete it to the best of your abilities.
            </p>
            <button
              onClick={() => setSlide(2)}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg px-4 py-2.5 transition-colors"
            >
              Consent &amp; Continue
            </button>
          </>
        )}

        {slide === 2 && (
          <>
            <h1 className="text-2xl font-semibold text-gray-900 mb-4">Study Instructions</h1>
            <ul className="list-disc list-inside space-y-2 text-sm text-gray-700 mb-8">
              <li>You will be shown <span className="font-medium">one website at a time</span> with a specific task prompt.</li>
              <li>Your task is to <span className="font-medium">complete the prompted flow</span> and press Done when finished.</li>
              <li>These websites are clones of existing websites so many of the images are text placeholders.</li>
              <li>Use each site naturally: scroll, click links, search, and type as needed.</li>
              <li><span className="font-medium font-bold">DO NOT</span> enter personal information. Use realistic but fake values if a form asks for details.</li>
              <li>We encourage you to finish the study in a single sitting.</li>
            </ul>

            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
              <div>
                <label htmlFor="pid" className="block text-sm font-medium text-gray-700 mb-1">
                  Participant ID
                </label>
                <input
                  id="pid"
                  type="text"
                  value={participantId}
                  onChange={e => setParticipantId(e.target.value)}
                  placeholder="e.g. P001"
                  className="w-full border border-gray-300 rounded-lg px-4 py-2.5 text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  autoFocus
                />
              </div>

              {error && (
                <p className="text-red-600 text-sm">{error}</p>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white font-medium rounded-lg px-4 py-2.5 transition-colors"
              >
                {loading ? 'Verifying...' : 'Start Study'}
              </button>
            </form>
          </>
        )}

      </div>
    </div>
  );
}
