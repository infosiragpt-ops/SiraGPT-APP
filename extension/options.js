const STORAGE_KEYS = {
  token: 'siraAppshotsToken',
  apiBase: 'siraAppshotsApiBase',
};

const tokenEl = document.getElementById('token');
const revealBtn = document.getElementById('reveal');
const apiBaseEl = document.getElementById('apiBase');
const saveBtn = document.getElementById('save');
const clearBtn = document.getElementById('clear');
const statusEl = document.getElementById('status');

init();

async function init() {
  const data = await chrome.storage.local.get([STORAGE_KEYS.token, STORAGE_KEYS.apiBase]);
  if (data[STORAGE_KEYS.token]) tokenEl.value = data[STORAGE_KEYS.token];
  apiBaseEl.value = data[STORAGE_KEYS.apiBase] || 'https://siragpt.com';
}

revealBtn.addEventListener('click', () => {
  tokenEl.type = tokenEl.type === 'password' ? 'text' : 'password';
  revealBtn.textContent = tokenEl.type === 'password' ? 'Ver' : 'Ocultar';
});

saveBtn.addEventListener('click', async () => {
  const token = tokenEl.value.trim();
  const apiBase = apiBaseEl.value.trim().replace(/\/+$/, '') || 'https://siragpt.com';
  if (!token) { setStatus('Pega un c\u00f3digo antes de guardar.', 'warn'); return; }
  if (!/^https?:\/\//.test(apiBase)) { setStatus('La URL del servidor debe empezar por http(s)://', 'warn'); return; }
  await chrome.storage.local.set({
    [STORAGE_KEYS.token]: token,
    [STORAGE_KEYS.apiBase]: apiBase,
  });
  setStatus('Guardado. Ya puedes capturar con \u2318\u21e7S.', 'ok');
});

clearBtn.addEventListener('click', async () => {
  await chrome.storage.local.remove([STORAGE_KEYS.token]);
  tokenEl.value = '';
  setStatus('Vinculaci\u00f3n borrada.', 'warn');
});

function setStatus(text, kind) {
  statusEl.textContent = text;
  statusEl.style.color = kind === 'ok' ? '#15803d' : kind === 'warn' ? '#b45309' : '#b91c1c';
}
