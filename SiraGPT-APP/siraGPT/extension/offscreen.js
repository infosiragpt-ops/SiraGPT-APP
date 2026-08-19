/**
 * Offscreen document — runs the actual getUserMedia + canvas grab that MV3
 * service workers can't do. Lives only while the SW keeps it alive.
 */
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== 'offscreen') return;
  if (msg.type === 'appshots:revoke-blob') {
    try { URL.revokeObjectURL(msg.blobUrl); } catch (_) { /* best-effort */ }
    return;
  }
  if (msg.type !== 'appshots:grab-frame') return;
  const { streamId, requestId } = msg;
  grabFrame(streamId)
    .then((blobUrl) => chrome.runtime.sendMessage({
      type: 'appshots:frame-result',
      requestId,
      blobUrl,
    }))
    .catch((err) => chrome.runtime.sendMessage({
      type: 'appshots:frame-result',
      requestId,
      error: String(err?.message || err),
    }));
});

async function grabFrame(streamId) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: streamId,
        maxWidth: 3840,
        maxHeight: 2160,
      },
    },
  });
  try {
    const video = document.createElement('video');
    video.srcObject = stream;
    video.muted = true;
    await video.play();
    // Wait a tick so the video element has actual dimensions to draw from.
    // Without this, the first paint on slow displays can land a 0x0 frame.
    await new Promise((r) => setTimeout(r, 120));

    const w = video.videoWidth || 1280;
    const h = video.videoHeight || 720;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d').drawImage(video, 0, 0, w, h);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('No se pudo codificar PNG del frame capturado.');
    return URL.createObjectURL(blob);
  } finally {
    stream.getTracks().forEach((t) => t.stop());
  }
}
