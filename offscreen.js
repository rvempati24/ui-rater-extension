let recorder = null;
let chunks = [];
let pendingBlob = null;
let lastUploadedTask = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'START_RECORDING') {
    startRecording(msg.streamId).then(() => sendResponse({ ok: true })).catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === 'STOP_RECORDING') {
    stopRecording(msg.serverUrl, msg.participantId, msg.taskIndex, msg)
      .then((result) => sendResponse(result))
      .catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === 'CANCEL_RECORDING') {
    cancelRecording();
    sendResponse({ ok: true });
    return false;
  }
});

async function startRecording(streamId) {
  if (recorder || pendingBlob) {
    throw new Error('A previous recording is still active or waiting to upload');
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
  });

  chunks = [];
  lastUploadedTask = null;
  recorder = new MediaRecorder(stream, {
    mimeType: 'video/webm;codecs=vp8',
    videoBitsPerSecond: 1500000,
  });

  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  recorder.start(1000);
}

async function stopRecording(serverUrl, participantId, taskIndex, managed = {}) {
  if (recorder && recorder.state !== 'inactive') {
    await new Promise((resolve) => {
      recorder.onstop = () => {
        pendingBlob = new Blob(chunks, { type: 'video/webm' });
        chunks = [];

        recorder.stream.getTracks().forEach(t => t.stop());
        recorder = null;
        resolve();
      };
      recorder.stop();
    });
  }

  if (!serverUrl || !participantId || !taskIndex) {
    return { ok: false, error: 'Missing upload params', code: 'invalid_upload', retryable: false };
  }
  const uploadKey = `${serverUrl}|${participantId}|${managed.attemptId || taskIndex}`;
  if (!pendingBlob) {
    if (lastUploadedTask === uploadKey) return { ok: true, alreadyUploaded: true };
    return { ok: false, error: 'Not recording', code: 'recorder_unavailable', retryable: false };
  }

  try {
    const res = await fetch(
      `${serverUrl}/api/upload-recording?participantId=${encodeURIComponent(participantId)}`
        + `&taskIndex=${encodeURIComponent(taskIndex)}`
        + (managed.runId ? `&runId=${encodeURIComponent(managed.runId)}` : '')
        + (managed.assignmentId ? `&assignmentId=${encodeURIComponent(managed.assignmentId)}` : '')
        + (managed.attemptId ? `&attemptId=${encodeURIComponent(managed.attemptId)}` : ''),
      { method: 'POST', body: pendingBlob }
    );
    if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
    pendingBlob = null;
    lastUploadedTask = uploadKey;
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message, code: 'upload_failed', retryable: true };
  }
}

function cancelRecording() {
  if (recorder) {
    const activeRecorder = recorder;
    recorder = null;
    activeRecorder.onstop = () => {
      activeRecorder.stream.getTracks().forEach(t => t.stop());
      chunks = [];
    };
    if (activeRecorder.state !== 'inactive') activeRecorder.stop();
    else activeRecorder.stream.getTracks().forEach(t => t.stop());
  }
  chunks = [];
  pendingBlob = null;
  lastUploadedTask = null;
}
