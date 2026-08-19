const STORAGE_KEYS = {
  token: 'siraAppshotsToken',
  apiBase: 'siraAppshotsApiBase',
};

const statusEl = document.getElementById('status');
const captureBtn = document.getElementById('capture');
const optionsBtn = document.getElementById('open-options');

init().catch((err) => setStatus('err', String(err?.message || err)));

async function init() {
  const data = await chrome.storage.local.get([STORAGE_KEYS.token, STORAGE_KEYS.apiBase]);
  if (!data[STORAGE_KEYS.token]) {
    setStatus('warn', 'Sin vincular. Abre las opciones y pega tu c\u00f3digo de Sira.');
    captureBtn.hidden = true;
    return;
  }
  const host = (data[STORAGE_KEYS.apiBase] || 'siragpt.com').replace(/^https?:\/\//, '');
  setStatus('ok', `Vinculado con ${host}`);
  captureBtn.hidden = false;
}

captureBtn.addEventListener('click', async () => {
  setStatus('', 'Capturando…');
  captureBtn.disabled = true;
  try {
    const reply = await chrome.runtime.sendMessage({ type: 'appshots:capture-now' });
    if (!reply?.ok) throw new Error(reply?.error || 'Captura fallida');
    setStatus('ok', 'Listo. Abriendo Sira…');
    window.close();
  } catch (err) {
    setStatus('err', String(err?.message || err));
  } finally {
    captureBtn.disabled = false;
  }
});

optionsBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());

function setStatus(kind, text) {
  statusEl.textContent = text;
  statusEl.className = `status${kind ? ' ' + kind : ''}`;
}
