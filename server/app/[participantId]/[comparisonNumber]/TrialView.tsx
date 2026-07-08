'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Trial, InteractionEvent } from '@/types';

interface TrialViewProps {
  participantId: string;
  trialNumber: number;
  trial: Trial;
  totalTrials: number;
}

export default function TrialView({
  participantId,
  trialNumber,
  trial,
  totalTrials,
}: TrialViewProps) {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isDone, setIsDone] = useState(Boolean(trial.completed));
  const [showInstructions, setShowInstructions] = useState(false);
  const [loaded, setLoaded] = useState(true);

  const iframeRef = useRef<HTMLIFrameElement>(null);
  const iframeCleanupRef = useRef<(() => void) | null>(null);
  const currentTrialIndexRef = useRef(trial.index);
  const viewStartRef = useRef<string | null>(trial.view_start);
  const originTimeRef = useRef<number>(
    trial.view_start ? Date.parse(trial.view_start) : Date.now()
  );
  const interactionsRef = useRef<InteractionEvent[]>(trial.interactions ?? []);

  const taskApp = trial.task_app || trial.plain_app;
  const iframeSrc = `/apps/${taskApp}/index.html`;

  const recordEvent = useCallback((event: Omit<InteractionEvent, 'ts'>) => {
    interactionsRef.current.push({ ...event, ts: Date.now() - originTimeRef.current });
  }, []);

  useEffect(() => {
    const trialChanged = currentTrialIndexRef.current !== trial.index;
    currentTrialIndexRef.current = trial.index;

    setIsDone(Boolean(trial.completed));
    if (trialChanged) setLoaded(true);
    viewStartRef.current = trial.view_start;
    originTimeRef.current = trial.view_start ? Date.parse(trial.view_start) : Date.now();
    interactionsRef.current = trial.interactions ?? [];
  }, [trial]);

  useEffect(() => {
    if (viewStartRef.current !== null) return;
    const now = new Date().toISOString();
    viewStartRef.current = now;
    originTimeRef.current = Date.parse(now);
    fetch('/api/partial-save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        participantId,
        trialIndex: trial.index,
        view_start: now,
        interactions: [],
      }),
    }).catch(() => {});
  }, [participantId, trial.index]);

  useEffect(() => {
    function onBeforeUnload() {
      const blob = new Blob([JSON.stringify({
        participantId,
        trialIndex: trial.index,
        view_start: viewStartRef.current,
        interactions: interactionsRef.current,
      })], { type: 'application/json' });
      navigator.sendBeacon('/api/partial-save', blob);
    }
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [participantId, trial.index]);

  useEffect(() => {
    return () => iframeCleanupRef.current?.();
  }, []);

  function attachIFrameListeners(iframe: HTMLIFrameElement): () => void {
    const doc = iframe.contentDocument;
    const win = iframe.contentWindow;
    if (!doc || !win) return () => {};

    const side = 'left' as const;

    const onClick = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      const anchor = el.closest('a');
      let fixed = false;
      let node: HTMLElement | null = el;
      while (node && node !== doc.body) {
        const pos = win.getComputedStyle(node).position;
        if (pos === 'fixed' || pos === 'sticky') {
          fixed = true;
          break;
        }
        node = node.parentElement;
      }
      recordEvent({
        kind: 'iframe_click',
        side,
        x: Math.round(e.clientX),
        y: Math.round(e.clientY),
        scroll_y: Math.round(win.scrollY),
        is_fixed: fixed || undefined,
        tag: el.tagName?.toLowerCase() ?? '',
        text: el.innerText?.trim().slice(0, 80) ?? '',
        viewport_w: Math.round(iframe.clientWidth),
        viewport_h: Math.round(iframe.clientHeight),
        href: anchor?.href ?? undefined,
      });
    };

    let scrollTimer: ReturnType<typeof setTimeout> | null = null;
    const onScroll = () => {
      if (scrollTimer !== null) return;
      scrollTimer = setTimeout(() => {
        scrollTimer = null;
        const scrollY = win.scrollY;
        const denom = doc.documentElement.scrollHeight - doc.documentElement.clientHeight;
        recordEvent({
          kind: 'iframe_scroll',
          side,
          scroll_y: Math.round(scrollY),
          scroll_pct: denom > 0 ? Math.round((scrollY / denom) * 100) : 0,
        });
      }, 500);
    };

    let lastMoveTime = 0;
    const onMouseMove = (e: MouseEvent) => {
      const now = Date.now();
      if (now - lastMoveTime < 500) return;
      lastMoveTime = now;
      recordEvent({
        kind: 'mousemove',
        side,
        x: Math.round(e.clientX),
        y: Math.round(e.clientY),
        scroll_y: Math.round(win.scrollY),
        viewport_w: Math.round(iframe.clientWidth),
        viewport_h: Math.round(iframe.clientHeight),
      });
    };

    const onInput = (e: Event) => {
      const el = e.target as HTMLInputElement | HTMLTextAreaElement;
      if (!('value' in el)) return;
      recordEvent({
        kind: 'input',
        side,
        tag: el.tagName?.toLowerCase() ?? '',
        field: (el as HTMLInputElement).name || el.id || (el as HTMLInputElement).placeholder || '',
        value: el.value?.slice(0, 200) ?? '',
      });
    };

    doc.addEventListener('click', onClick);
    win.addEventListener('scroll', onScroll);
    doc.addEventListener('mousemove', onMouseMove);
    doc.addEventListener('input', onInput);

    return () => {
      doc.removeEventListener('click', onClick);
      win.removeEventListener('scroll', onScroll);
      doc.removeEventListener('mousemove', onMouseMove);
      doc.removeEventListener('input', onInput);
      if (scrollTimer !== null) clearTimeout(scrollTimer);
    };
  }

  async function handleDone() {
    if (isSubmitting) return;
    setIsSubmitting(true);
    const duration_ms =
      viewStartRef.current !== null
        ? Date.now() - Date.parse(viewStartRef.current)
        : null;

    try {
      const res = await fetch('/api/complete-task', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          participantId,
          trialIndex: trial.index,
          view_start: viewStartRef.current,
          duration_ms,
          interactions: interactionsRef.current,
        }),
      });

      if (!res.ok) throw new Error('Failed to save task completion');
      setIsDone(true);

      if (trialNumber < totalTrials) {
        router.push(`/${participantId}/${trialNumber + 1}`);
      } else {
        router.push(`/${participantId}/complete`);
      }
    } catch {
      setIsSubmitting(false);
    }
  }

  function goToPrevious() {
    if (trialNumber > 1) router.push(`/${participantId}/${trialNumber - 1}`);
  }

  function goToNext() {
    if (trialNumber < totalTrials) router.push(`/${participantId}/${trialNumber + 1}`);
  }

  return (
    <div className="flex flex-col min-h-screen bg-gray-50">
      <div className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-4">
          <span className="text-sm font-medium text-gray-500">
            Task <span className="text-gray-900 font-semibold">{trialNumber}</span> of{' '}
            <span className="text-gray-900 font-semibold">{totalTrials}</span>
          </span>
          <div className="w-32 h-2 bg-gray-200 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-500 rounded-full transition-all"
              style={{ width: `${(trialNumber / totalTrials) * 100}%` }}
            />
          </div>
          <span className="text-xs uppercase tracking-wide text-gray-400">{trial.group}</span>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowInstructions(true)}
            className="w-7 h-7 rounded-full border border-gray-300 text-gray-500 hover:bg-gray-50 text-sm italic font-serif transition-colors flex items-center justify-center"
            title="Study instructions"
          >
            i
          </button>
          <button
            onClick={goToPrevious}
            disabled={trialNumber <= 1}
            className="text-sm px-3 py-1.5 rounded border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Prev
          </button>
          <button
            onClick={goToNext}
            disabled={trialNumber >= totalTrials || !isDone}
            className="text-sm px-3 py-1.5 rounded border border-gray-300 text-gray-600 hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Next
          </button>
        </div>
      </div>

      {showInstructions && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
          <div className="bg-white rounded-2xl shadow-lg p-8 w-full max-w-lg">
            <h2 className="text-xl font-semibold text-gray-900 mb-4">Study Instructions</h2>
            <ul className="list-disc list-inside space-y-2 text-sm text-gray-700 mb-6">
              <li>You will complete one task on each website.</li>
              <li>Use the website naturally: click, scroll, search, and type as needed.</li>
              <li>Press Done only after you believe the task is complete.</li>
              <li>Do not enter personal information. Use realistic but fake values if a form asks for details.</li>
            </ul>
            <button
              onClick={() => setShowInstructions(false)}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg px-4 py-2.5 transition-colors"
            >
              Got it
            </button>
          </div>
        </div>
      )}

      <div className="bg-white border-b border-gray-200 px-6 py-4 shrink-0">
        <div className="max-w-5xl mx-auto">
          <p className="text-xs font-semibold uppercase tracking-wide text-blue-600 mb-1">
            Complete this task
          </p>
          <h1 className="text-lg font-semibold text-gray-900 leading-snug">
            {trial.task_prompt}
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            Website: <span className="font-medium text-gray-700">{trial.group}</span>
          </p>
        </div>
      </div>

      <div
        className="flex-1 p-3 overflow-hidden"
        onMouseEnter={() => recordEvent({ kind: 'hover_start', side: 'left' })}
        onMouseLeave={() => recordEvent({ kind: 'hover_end', side: 'left' })}
      >
        <div className="relative h-full min-h-[68vh] overflow-hidden rounded-lg border border-gray-200 bg-white">
          {!loaded && (
            <div className="absolute inset-0 flex items-center justify-center bg-gray-50 z-10">
              <div className="flex flex-col items-center gap-2 text-gray-400">
                <div className="w-8 h-8 border-2 border-gray-300 border-t-blue-500 rounded-full animate-spin" />
                <span className="text-xs">Loading app...</span>
              </div>
            </div>
          )}
          <iframe
            ref={iframeRef}
            src={iframeSrc}
            title={`${trial.group} task`}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            className="w-full h-full min-h-[68vh] border-0"
            onLoad={() => {
              const iframe = iframeRef.current;
              if (!iframe) return;
              setLoaded(true);
              iframeCleanupRef.current?.();
              iframeCleanupRef.current = attachIFrameListeners(iframe);
            }}
          />
        </div>
      </div>

      <div className="bg-white border-t border-gray-200 px-6 py-4 shrink-0">
        <div className="max-w-5xl mx-auto flex items-center justify-between gap-4">
          <p className="text-sm text-gray-500">
            {isDone ? 'Task saved.' : 'When you finish the task in the website above, press Done.'}
          </p>
          <button
            onClick={handleDone}
            disabled={isSubmitting || isDone}
            className="px-7 py-3 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
          >
            {isSubmitting ? 'Saving...' : isDone ? 'Done saved' : 'Done'}
          </button>
        </div>
      </div>
    </div>
  );
}
