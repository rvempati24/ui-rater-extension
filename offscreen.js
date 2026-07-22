let recorder = null;
let chunks = [];
let pendingBlob = null;
let recordingTiming = null;
let lastUploadedTask = null;
let recorderStopped = null;

function openRecordingDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('ui-rater-recording-v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('recordings');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function recordingStore(mode, operation) {
  const db = await openRecordingDb();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction('recordings', mode);
      const request = operation(transaction.objectStore('recordings'));
      let result;
      request.onsuccess = () => { result = request.result; };
      request.onerror = () => reject(request.error);
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error || new Error('Recording transaction aborted'));
    });
  } finally {
    db.close();
  }
}

async function persistPendingRecording(blob, timing) {
  await recordingStore('readwrite', (store) => store.put({ blob, timing }, 'pending'));
}

async function restorePendingBlob() {
  if (!pendingBlob) {
    const stored = await recordingStore('readonly', (store) => store.get('pending')) || null;
    if (stored instanceof Blob) {
      pendingBlob = stored;
    } else if (stored?.blob instanceof Blob) {
      pendingBlob = stored.blob;
      recordingTiming = stored.timing || recordingTiming;
    }
  }
  return pendingBlob;
}

async function clearPendingBlob() {
  pendingBlob = null;
  await recordingStore('readwrite', (store) => store.delete('pending'));
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'START_RECORDING') {
    startRecording(msg.streamId).then((timing) => sendResponse({ ok: true, ...timing }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === 'STOP_RECORDING') {
    stopRecording(msg.collectorUrl || msg.serverUrl, msg.participantId, msg.taskIndex, msg)
      .then((result) => sendResponse(result))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === 'CANCEL_RECORDING') {
    cancelRecording().then(() => sendResponse({ ok: true }))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
});

async function startRecording(streamId) {
  await restorePendingBlob();
  if (recorder || pendingBlob) {
    throw new Error('A previous recording is still active or waiting to upload');
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
        maxFrameRate: 30,
      },
    },
  });

  chunks = [];
  recordingTiming = null;
  lastUploadedTask = null;
  recorder = new MediaRecorder(stream, {
    mimeType: 'video/webm;codecs=vp8',
    videoBitsPerSecond: 1500000,
  });

  const activeRecorder = recorder;
  let startSettled = false;
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  let rejectStopped;
  recorderStopped = new Promise((resolve, reject) => {
    rejectStopped = reject;
    activeRecorder.onstop = async () => {
      try {
        const videoStopEpochMs = Date.now();
        recordingTiming = { ...recordingTiming, videoStopEpochMs };
        pendingBlob = new Blob(chunks, { type: 'video/webm' });
        chunks = [];
        activeRecorder.stream.getTracks().forEach(t => t.stop());
        if (recorder === activeRecorder) recorder = null;
        await persistPendingRecording(pendingBlob, recordingTiming);
        resolve(recordingTiming);
      } catch (error) { reject(error); }
    };
  });
  const started = new Promise((resolve, reject) => {
    activeRecorder.onstart = () => {
      startSettled = true;
      const settings = activeRecorder.stream.getVideoTracks()[0]?.getSettings?.() || {};
      recordingTiming = {
        videoStartEpochMs: Date.now(),
        startSource: 'mediarecorder-start-event',
        captureProfile: {
          profileId: 'tab-vp8-30fps-v1', codec: 'vp8', requestedFrameRate: 30,
          width: settings.width, height: settings.height, frameRate: settings.frameRate,
        },
      };
      resolve(recordingTiming);
    };
    activeRecorder.onerror = (event) => {
      const error = event.error || new Error('MediaRecorder failed');
      if (!startSettled) reject(error);
      rejectStopped?.(error);
    };
  });
  activeRecorder.start(1000);
  return started.catch((error) => {
    if (recorder === activeRecorder) recorder = null;
    activeRecorder.stream.getTracks().forEach(track => track.stop());
    throw error;
  });
}

async function stopRecording(collectorUrl, participantId, taskIndex, managed = {}) {
  if (recorder) {
    if (recorder.state !== 'inactive') recorder.stop();
    recordingTiming = await recorderStopped;
  }
  await restorePendingBlob();

  if (!collectorUrl || !participantId || !taskIndex) {
    return { ok: false, error: 'Missing upload params', code: 'invalid_upload', retryable: false };
  }
  const uploadKey = `${collectorUrl}|${participantId}|${managed.attemptId || taskIndex}`;
  if (!pendingBlob) {
    const stored = await chrome.storage.local.get(['_lastUploadedRecording']);
    lastUploadedTask = lastUploadedTask || stored._lastUploadedRecording;
    if (lastUploadedTask?.uploadKey === uploadKey || lastUploadedTask === uploadKey) {
      return { ok: true, alreadyUploaded: true, ...(lastUploadedTask.timing || {}) };
    }
    return { ok: false, error: 'Not recording', code: 'recorder_unavailable', retryable: false };
  }

  try {
    const res = await fetch(
      `${collectorUrl}/api/upload-recording?participantId=${encodeURIComponent(participantId)}`
        + `&taskIndex=${encodeURIComponent(taskIndex)}`
        + (managed.runId ? `&runId=${encodeURIComponent(managed.runId)}` : '')
        + (managed.assignmentId ? `&assignmentId=${encodeURIComponent(managed.assignmentId)}` : '')
        + (managed.attemptId ? `&attemptId=${encodeURIComponent(managed.attemptId)}` : ''),
      {
        method: 'POST', body: pendingBlob,
        headers: managed.attemptCapability
          ? { 'Authorization': `Bearer ${managed.attemptCapability}` } : {},
      }
    );
    if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
    await clearPendingBlob();
    lastUploadedTask = { uploadKey, timing: recordingTiming };
    await chrome.storage.local.set({ _lastUploadedRecording: lastUploadedTask });
    return { ok: true, ...recordingTiming };
  } catch (err) {
    return { ok: false, error: err.message, code: 'upload_failed', retryable: true };
  }
}

async function cancelRecording() {
  if (recorder) {
    const activeRecorder = recorder;
    recorder = null;
    if (activeRecorder.state !== 'inactive') {
      activeRecorder.stop();
      await recorderStopped?.catch(() => {});
    }
    else activeRecorder.stream.getTracks().forEach(t => t.stop());
  }
  chunks = [];
  recordingTiming = null;
  await clearPendingBlob();
  lastUploadedTask = null;
  recorderStopped = null;
  await chrome.storage.local.remove(['_lastUploadedRecording']);
}
