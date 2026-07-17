let recorder = null;
let chunks = [];
let pendingBlob = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'START_RECORDING') {
    startRecording(msg.streamId).then(() => sendResponse({ ok: true })).catch(e => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === 'STOP_RECORDING') {
    stopRecording(msg.serverUrl, msg.participantId, msg.taskIndex)
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
  pendingBlob = null;
  recorder = new MediaRecorder(stream, {
    mimeType: 'video/webm;codecs=vp8',
    videoBitsPerSecond: 1500000,
  });

  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  recorder.start(1000);
}

async function stopRecording(serverUrl, participantId, taskIndex) {
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

  if (!pendingBlob) return { ok: false, error: 'Not recording' };
  if (!serverUrl || !participantId || !taskIndex) {
    return { ok: false, error: 'Missing upload params' };
  }

  try {
    const res = await fetch(
      `${serverUrl}/api/upload-recording?participantId=${participantId}&taskIndex=${taskIndex}`,
      { method: 'POST', body: pendingBlob }
    );
    if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
    pendingBlob = null;
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
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
}
