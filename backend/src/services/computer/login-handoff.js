'use strict';

/**
 * Computer LOGIN HANDOFF — ChatGPT-class authenticated-computer primitive.
 *
 * The agent uses the per-chat desktop/browser. When a login / 2FA / captcha /
 * payment wall appears, the USER types credentials on that computer overlay.
 * SiraGPT, the model, logs, tool payloads, and OCR'd screenshots NEVER see
 * username/password/OTP/CVV. Opposite of a keylogger: agent keystrokes into
 * secret fields are refused; the user takes over, then hands back with Listo.
 *
 * This is NOT 20 site scrapers. It is the gate so real portals (DMV, insurer,
 * landlord, vet, …) can continue after the user logs in on THAT chat's VM.
 */

const { EventEmitter } = require('events');
const { resolveSessionIdentity } = require('./member-key');

const REDACTED = '[redacted]';
const LOGIN_HANDOFF_CODE = 'login_handoff_required';
const LOGIN_HANDOFF_EVENT = 'computer_login_handoff';

const COPY = Object.freeze({
  title: 'Inicia sesión en el equipo',
  instruction: 'Inicia sesión en este sitio',
  neverSees: 'SiraGPT no ve tu contraseña',
  ready: 'Listo',
  paused: 'La computadora espera a que inicies sesión. SiraGPT no ve tu contraseña.',
  refuseType: 'No escribo contraseñas ni códigos. Abre la computadora e inicia sesión tú. SiraGPT no ve tu contraseña.',
  refuseChatPassword:
    'NUNCA pidas al usuario que pegue una contraseña, usuario, OTP o tarjeta en el chat. Abre la computadora del agente y pide que inicie sesión ahí.',
});

const SECRET_NAME_RE = /password|passwd|pwd|passcode|passphrase|otp|2fa|mfa|totp|one[-_]?time|cvv|cvc|csc|cid|card[-_]?number|ccnum|cc-number|pin\b|ssn|secret|security[-_]?code/i;
const USERNAME_NAME_RE = /^(user(name)?|login|email|e-?mail|identifier|userid|user[-_]?id|account|correo)$/i;
const PASSWORD_TYPE_RE = /^(password)$/i;
const OTP_AUTOCOMPLETE_RE = /one-time-code|one-time|otp|totp|sms-otp/i;
const CC_AUTOCOMPLETE_RE = /cc-csc|cc-number|cc-exp|cc-name|cc-type/i;
const PASSWORD_AUTOCOMPLETE_RE = /current-password|new-password|password/i;
const USERNAME_AUTOCOMPLETE_RE = /username|email|nickname/i;
const CAPTCHA_RE = /captcha|recaptcha|hcaptcha|turnstile|i['’]?m not a robot|no soy un robot|verify you(?:'re| are) human|verifica que (?:no )?eres (?:un )?robot|unusual traffic/i;
const SSO_RE = /sign in with (google|apple|microsoft|facebook|github|okta)|continuar con (google|apple|microsoft|facebook)|iniciar sesi[oó]n con (google|apple|microsoft)|single sign[- ]on|\bsso\b|\boauth\b/i;
const LOGIN_URL_RE = /\/(login|signin|sign-in|log-in|auth|sso|oauth|account\/login|session\/new|accounts\/servicelogin)(\b|\/|$|\?)/i;
const TWOFA_RE = /two[- ]factor|2fa|authenticator|verification code|c[oó]digo de (verificaci[oó]n|seguridad)|one[- ]time (code|password)|\botp\b|ingresa el c[oó]digo/i;
const PAYMENT_RE = /card number|n[uú]mero de tarjeta|\bcvv\b|\bcvc\b|billing|pasarela de pago|payment wall|checkout|expir(?:y|ation)|mm\s*\/\s*yy/i;
const PASSWORD_PROMPT_RE = /\b(password|contrase(?:ñ|n)a|passwd)\b/i;
const USERNAME_PROMPT_RE = /\b(username|usuario|correo|e-?mail)\b/i;

const EXAMPLE_AUTHENTICATED_TASKS = Object.freeze([
  'activa los servicios (luz, agua, internet) del departamento nuevo',
  'renueva mi licencia en el DMV',
  'agenda la cita de pasaporte y sube la foto',
  'reclama el reembolso del seguro con las facturas',
  'busca un médico in-network cerca y agenda',
  'renueva el registro del auto',
  'escribe al landlord y contrasta con la póliza de renter',
  'filtra departamentos en portales y contacta a los que calzan',
  'reordena este producto a partir de la foto',
  'coordina recoger el paquete en la sucursal',
  'cancela estos boletos y pide el reembolso',
  'agenda al veterinario y sube el historial',
  'arma el reembolso médico con los recibos',
  'avísame y compra en el drop de reventa',
  'evalúa estos candidatos y arma el informe para hiring',
  'manda las facturas a contabilidad',
  'responde las consultas de alquiler con disponibilidad',
  'tramita el permiso de pequeño negocio',
  'cierra los action items del portal de proveedores',
  'analiza la campaña de anuncios en el panel del anunciante',
]);

const HAS_COMPUTER_POLICY_ES = [
  'POLÍTICA DE COMPUTADORA EN VIVO (obligatoria):',
  '- Cada chat TIENE una computadora en vivo con navegador. El overlay de ESTE chat es real.',
  '- Cuando el usuario pide abrirla, buscar en vivo, ofertas, comprar, reservar, agendar una cita, DMV, seguro o revisar un sitio: llama computer_screenshot, computer_navigate, computer_click y computer_type de inmediato, abre el overlay y navega de verdad.',
  '- NUNCA niegues la computadora ni el navegador de este chat. Confirma precios y ofertas navegando de verdad.',
  '- El usuario escribe contraseñas, OTP y tarjetas EN el overlay. NUNCA pidas que las pegue en el chat. SiraGPT no ve la contraseña.',
].join('\n');

const POLICY_ES = [
  HAS_COMPUTER_POLICY_ES,
  'POLÍTICA DE LOGIN EN LA COMPUTADORA (obligatoria):',
  '- NUNCA pidas al usuario que pegue una contraseña, usuario, código OTP/2FA o número de tarjeta en el chat.',
  '- NUNCA uses computer_type / type / keypress para escribir secretos. Si hay un campo password, OTP, 2FA, CVV o captcha, PAUSA y pide toma de control.',
  '- Abre la computadora del agente de ESTE chat. El usuario inicia sesión en el overlay. SiraGPT no ve la contraseña.',
  '- Cuando el usuario pulse Listo, continúa autenticado con las cookies de ESA conversación. No mezcles sesiones entre chats.',
  '- No inventes integraciones por sitio (no hay "plugin DMV"). Usa el navegador real de la computadora.',
].join('\n');

/** In-memory takeover per conversation session key. Never stores secrets. */
const takeoverByKey = new Map();
const lastObserveByKey = new Map();
const waitersByKey = new Map();
const takeoverBus = new EventEmitter();
takeoverBus.setMaxListeners(80);

function fieldBits(field) {
  if (!field || typeof field !== 'object') {
    return { name: '', type: '', autocomplete: '', role: '', label: '', id: '', value: '', focused: false };
  }
  return {
    name: String(field.name || field.fieldName || field.id || ''),
    type: String(field.type || field.inputType || '').toLowerCase(),
    autocomplete: String(field.autocomplete || field.autoComplete || ''),
    role: String(field.role || '').toLowerCase(),
    label: String(field.label || field.nameLabel || field.ariaLabel || field.title || ''),
    id: String(field.id || ''),
    value: field.value == null ? '' : String(field.value),
    focused: Boolean(field.focused || field.active || field.hasFocus),
  };
}

function isPasswordField(field) {
  const f = fieldBits(field);
  if (PASSWORD_TYPE_RE.test(f.type)) return true;
  if (PASSWORD_AUTOCOMPLETE_RE.test(f.autocomplete)) return true;
  if (SECRET_NAME_RE.test(f.name) && /password|passwd|pwd|passcode|passphrase/i.test(f.name)) return true;
  if (SECRET_NAME_RE.test(f.label) && /password|contrase/i.test(f.label) && f.type !== 'checkbox') return true;
  return false;
}

function isOtpField(field) {
  const f = fieldBits(field);
  if (OTP_AUTOCOMPLETE_RE.test(f.autocomplete)) return true;
  if (/otp|2fa|mfa|totp|one[-_]?time/i.test(f.name) || /otp|2fa|totp|c[oó]digo/i.test(f.label)) return true;
  if (f.type === 'tel' && /code|c[oó]digo|otp/i.test(f.name + f.label)) return true;
  return false;
}

function isCvvField(field) {
  const f = fieldBits(field);
  if (CC_AUTOCOMPLETE_RE.test(f.autocomplete)) return true;
  if (/cvv|cvc|csc|security[-_]?code|card[-_]?number|ccnum/i.test(f.name + ' ' + f.label + ' ' + f.autocomplete)) return true;
  return false;
}

function isUsernameInLoginForm(field, { inLoginForm } = {}) {
  const f = fieldBits(field);
  if (!inLoginForm && !f.focused) {
    if (!USERNAME_NAME_RE.test(f.name) && !USERNAME_AUTOCOMPLETE_RE.test(f.autocomplete)) return false;
  }
  if (USERNAME_NAME_RE.test(f.name) || USERNAME_AUTOCOMPLETE_RE.test(f.autocomplete)) return true;
  if (inLoginForm && /user|usuario|correo|email|login/i.test(f.label + ' ' + f.name)) return true;
  return false;
}

function isSecretField(field, opts = {}) {
  if (isPasswordField(field) || isOtpField(field) || isCvvField(field)) return true;
  if (opts.inLoginForm && isUsernameInLoginForm(field, opts)) return true;
  const f = fieldBits(field);
  if (SECRET_NAME_RE.test(f.name) || SECRET_NAME_RE.test(f.autocomplete)) return true;
  return false;
}

function siteNameFromUrl(url) {
  try {
    const host = new URL(String(url || '')).hostname.replace(/^www\./, '');
    return host || '';
  } catch {
    return '';
  }
}

function looksLikeLoginForm(text, url, title) {
  const blob = `${text || ''}\n${title || ''}\n${url || ''}`;
  const hasPasswordCue = PASSWORD_PROMPT_RE.test(blob) || /type=["']password["']/i.test(blob) || /autocomplete=["'][^"']*password/i.test(blob);
  const hasUserCue = USERNAME_PROMPT_RE.test(blob) || /type=["'](?:email|text)["'][^>]*(?:name|id)=["'](?:user|email|login)/i.test(blob);
  const hasLoginUrl = LOGIN_URL_RE.test(String(url || ''));
  const hasLoginTitle = /log\s*in|sign\s*in|iniciar sesi[oó]n|acceder/i.test(String(title || ''));
  return Boolean((hasPasswordCue && (hasUserCue || hasLoginUrl || hasLoginTitle)) || (hasLoginUrl && hasPasswordCue));
}

function detectLoginGate(input = {}) {
  const text = String(input.text || input.dom || input.a11y || '');
  const url = String(input.url || '');
  const title = String(input.title || '');
  const focused = input.focused || input.focusedField || null;
  const blob = `${text}\n${title}\n${url}`;
  const site = siteNameFromUrl(url) || String(input.site || '').trim();
  const inLoginForm = looksLikeLoginForm(text, url, title);
  const hasLoginTitle = /log\s*in|sign\s*in|iniciar sesi[oó]n|acceder/i.test(title);

  if (focused && isSecretField(focused, { inLoginForm: true })) {
    const kind = isPasswordField(focused) ? 'password' : isOtpField(focused) ? 'otp' : isCvvField(focused) ? 'payment' : 'username';
    return {
      gated: true,
      kind,
      reason: 'focused_secret_field',
      site,
      focusedSecret: true,
      inLoginForm: true,
      code: LOGIN_HANDOFF_CODE,
      message: COPY.paused,
    };
  }

  if (CAPTCHA_RE.test(blob)) {
    return { gated: true, kind: 'captcha', reason: 'captcha', site, focusedSecret: false, inLoginForm, code: LOGIN_HANDOFF_CODE, message: COPY.paused };
  }
  if (TWOFA_RE.test(blob) && (inLoginForm || /code|c[oó]digo|authenticator/i.test(blob))) {
    return { gated: true, kind: 'otp', reason: '2fa', site, focusedSecret: false, inLoginForm: true, code: LOGIN_HANDOFF_CODE, message: COPY.paused };
  }
  if (PAYMENT_RE.test(blob) && /cvv|cvc|card number|n[uú]mero de tarjeta|checkout/i.test(blob)) {
    return { gated: true, kind: 'payment', reason: 'payment_wall', site, focusedSecret: false, inLoginForm, code: LOGIN_HANDOFF_CODE, message: COPY.paused };
  }
  if (SSO_RE.test(blob)) {
    return { gated: true, kind: 'sso', reason: 'sso', site, focusedSecret: false, inLoginForm: true, code: LOGIN_HANDOFF_CODE, message: COPY.paused };
  }
  if (/type\s*=\s*["']password["']/i.test(text) || /name\s*=\s*["'][^"']*(?:password|passwd|pwd|otp|2fa|totp|cvv|cvc|csc)[^"']*["']/i.test(text)) {
    const kind = /otp|2fa|totp/i.test(text) ? 'otp' : /cvv|cvc|csc/i.test(text) ? 'payment' : 'password';
    return { gated: true, kind, reason: kind === 'otp' ? '2fa' : 'login_form', site, focusedSecret: false, inLoginForm: true, code: LOGIN_HANDOFF_CODE, message: COPY.paused };
  }
  if (inLoginForm) {
    if (PASSWORD_PROMPT_RE.test(blob) || LOGIN_URL_RE.test(url) || hasLoginTitle) {
      return { gated: true, kind: 'password', reason: 'login_form', site, focusedSecret: false, inLoginForm: true, code: LOGIN_HANDOFF_CODE, message: COPY.paused };
    }
  }
  return { gated: false, kind: null, reason: null, site, focusedSecret: false, inLoginForm, code: null, message: null };
}

function redactHtmlInputValues(html, opts = {}) {
  return String(html || '').replace(/<input\b[^>]*>/gi, (tag) => {
    const name = ((tag.match(/\b(?:name|id)\s*=\s*["']([^"']*)/i) || [])[1] || '');
    const type = ((tag.match(/\btype\s*=\s*["']([^"']*)/i) || [])[1] || '');
    const autocomplete = ((tag.match(/\bautocomplete\s*=\s*["']([^"']*)/i) || [])[1] || '');
    if (isSecretField({ name, type, autocomplete }, { inLoginForm: opts.inLoginForm })) {
      return tag.replace(/(\bvalue\s*=\s*["'])([^"']*)(["'])/i, `$1${REDACTED}$3`);
    }
    return tag;
  });
}

function redactLabeledSecret(text) {
  let next = String(text || '');
  next = next.replace(
    /(\b(?:password|passwd|pwd|passcode|otp|2fa|mfa|totp|cvv|cvc|csc|pin|secret|contrase(?:ñ|n)a|usuario|username)\b\s*[:=]\s*)([^\s,;|"'<>]{1,256})/gi,
    `$1${REDACTED}`,
  );
  next = next.replace(
    /(type\s*=\s*["']password["'][^>]*value\s*=\s*["'])([^"']*)(["'])/gi,
    `$1${REDACTED}$3`,
  );
  next = next.replace(
    /(value\s*=\s*["'])([^"']*)(["'][^>]*type\s*=\s*["']password["'])/gi,
    `$1${REDACTED}$3`,
  );
  next = next.replace(
    /(autocomplete\s*=\s*["'][^"']*(?:password|one-time-code|cc-csc|cc-number)[^"']*["'][^>]*value\s*=\s*["'])([^"']*)(["'])/gi,
    `$1${REDACTED}$3`,
  );
  next = next.replace(
    /(\b(?:name|id)\s*=\s*["'][^"']*(?:password|passwd|otp|2fa|cvv|cvc)[^"']*["'][^>]*value\s*=\s*["'])([^"']*)(["'])/gi,
    `$1${REDACTED}$3`,
  );
  next = next.replace(/\s=\s+[^\s]{1,80}(?=\s*$)/gm, (match, offset, whole) => {
    const lineStart = whole.lastIndexOf('\n', offset) + 1;
    const line = whole.slice(lineStart, offset);
    if (SECRET_NAME_RE.test(line) || /password|otp|cvv|textbox.*contrase/i.test(line)) {
      return ` = ${REDACTED}`;
    }
    return match;
  });
  return next;
}

function redactSecretsFromText(text, opts = {}) {
  const raw = text == null ? '' : String(text);
  if (!raw) return raw;
  const inLogin = opts.inLoginForm || looksLikeLoginForm(raw, opts.url, opts.title);
  let next = redactHtmlInputValues(raw, { inLoginForm: inLogin });
  next = redactLabeledSecret(next);
  if (inLogin) {
    next = next.replace(
      /(\b(?:username|user|email|correo|usuario|login)\b\s*[:=]\s*)([^\s,;|"'<>]{1,256})/gi,
      `$1${REDACTED}`,
    );
  }
  return next;
}


function redactAxNode(node, opts = {}) {
  if (!node || typeof node !== 'object') return node;
  const inLoginForm = opts.inLoginForm === true;
  const copy = Array.isArray(node) ? node.map((n) => redactAxNode(n, opts)) : { ...node };
  if (Array.isArray(node)) return copy;
  const field = {
    name: axPrimitive(node.name) || node.name || '',
    type: axPrimitive(node.description) || node.inputType || node.type || '',
    autocomplete: node.autocomplete || '',
    role: axPrimitive(node.role) || node.role || '',
    label: axPrimitive(node.name) || '',
    value: axPrimitive(node.value),
    focused: Boolean(node.focused),
  };
  const secret = isSecretField(field, { inLoginForm })
    || (String(field.role).toLowerCase() === 'textbox' && isSecretField({ ...field, type: 'password' }, { inLoginForm }) === false
      && SECRET_NAME_RE.test(String(field.name) + String(field.label)));
  const treatAsSecret = isSecretField(field, { inLoginForm }) || (inLoginForm && isUsernameInLoginForm(field, { inLoginForm }));
  if (treatAsSecret || secret) {
    if (copy.value != null) {
      copy.value = typeof copy.value === 'object' ? { ...copy.value, value: REDACTED } : REDACTED;
    }
  }
  if (Array.isArray(copy.children)) {
    copy.children = copy.children.map((c) => redactAxNode(c, opts));
  }
  return copy;
}

function axPrimitive(v) {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (typeof v === 'object' && v.value != null) return String(v.value);
  return '';
}

function redactObservePayload(payload = {}) {
  const url = payload.url || '';
  const title = payload.title || '';
  const text = redactSecretsFromText(payload.text || '', { url, title, inLoginForm: looksLikeLoginForm(payload.text, url, title) });
  const gate = detectLoginGate({ ...payload, text, url, title, focused: payload.focused });
  const out = {
    ...payload,
    text,
    title: String(title || ''),
    url: url || null,
    loginHandoff: gate.gated,
    loginGate: gate.gated ? { kind: gate.kind, reason: gate.reason, site: gate.site } : null,
  };
  if (gate.gated) {
    out.screenshotOcr = undefined;
    if (payload.png && gate.focusedSecret) {
      out.png = null;
      out.shot = null;
      out.mediaType = undefined;
      out.screenshotBlocked = true;
      out.text = redactSecretsFromText(
        `${text}\n[login-handoff] ${COPY.paused}`,
        { url, title, inLoginForm: true },
      );
    }
  }
  if (payload.ocrText) {
    out.ocrText = redactSecretsFromText(payload.ocrText, { url, title, inLoginForm: gate.inLoginForm });
  }
  if (payload.metadata && typeof payload.metadata === 'object') {
    out.metadata = redactMessageMetadata(payload.metadata);
  }
  return out;
}

function redactMessageMetadata(meta) {
  if (!meta || typeof meta !== 'object') return meta;
  const out = Array.isArray(meta) ? [] : {};
  for (const [k, v] of Object.entries(meta)) {
    if (SECRET_NAME_RE.test(k) || /username|user|email|otp|cvv|card/i.test(k)) {
      out[k] = REDACTED;
      continue;
    }
    if (typeof v === 'string') out[k] = redactSecretsFromText(v, { inLoginForm: true });
    else if (v && typeof v === 'object') out[k] = redactMessageMetadata(v);
    else out[k] = v;
  }
  return out;
}

function rememberObserve(identityOrConversationId, payload = {}, user) {
  const key = takeoverKey(identityOrConversationId, user);
  lastObserveByKey.set(key, {
    text: String(payload.text || payload.dom || payload.a11y || ''),
    url: String(payload.url || ''),
    title: String(payload.title || ''),
    loginHandoff: Boolean(payload.loginHandoff || (payload.loginGate && payload.loginGate.kind)),
    loginGate: payload.loginGate || null,
    at: Date.now(),
  });
}

function getLastObserve(identityOrConversationId, user) {
  const key = takeoverKey(identityOrConversationId, user);
  return lastObserveByKey.get(key) || null;
}

function pageContextForGate(input = {}) {
  const typed = input.text != null ? String(input.text) : '';
  const hasPage = Boolean(input.dom || input.a11y || input.pageText || input.url || input.title);
  if (hasPage) {
    return {
      text: String(input.dom || input.a11y || input.pageText || ''),
      url: String(input.url || ''),
      title: String(input.title || ''),
      focused: input.focused || input.focusedField || null,
    };
  }
  const cached = getLastObserve(input.identity || input.conversationId, input.user);
  if (cached) {
    return {
      text: cached.text || '',
      url: cached.url || '',
      title: cached.title || '',
      focused: input.focused || input.focusedField || null,
    };
  }
  // Never treat the characters being typed as the page DOM.
  return {
    text: '',
    url: String(input.url || ''),
    title: String(input.title || ''),
    focused: input.focused || input.focusedField || null,
    typed,
  };
}

function emitTakeoverChange(payload) {
  try {
    takeoverBus.emit(LOGIN_HANDOFF_EVENT, payload);
  } catch (_) { /* listeners must not break takeover */ }
}

function subscribeTakeover(listener) {
  if (typeof listener !== 'function') return () => {};
  takeoverBus.on(LOGIN_HANDOFF_EVENT, listener);
  return () => {
    try { takeoverBus.off(LOGIN_HANDOFF_EVENT, listener); } catch (_) { /* noop */ }
  };
}

function addWaiter(key, entry) {
  let set = waitersByKey.get(key);
  if (!set) {
    set = new Set();
    waitersByKey.set(key, set);
  }
  set.add(entry);
}

function flushWaiters(key, result) {
  const set = waitersByKey.get(key);
  if (!set) return;
  waitersByKey.delete(key);
  for (const entry of set) {
    try { if (typeof entry.cleanup === 'function') entry.cleanup(); } catch (_) { /* noop */ }
    try { entry.resolve(result); } catch (_) { /* noop */ }
  }
}

function waitUntilReleased({ conversationId, user, identity, timeoutMs, signal } = {}) {
  const key = takeoverKey(identity || conversationId, user);
  const current = takeoverByKey.get(key);
  const timeout = Number.isFinite(Number(timeoutMs))
    ? Math.max(0, Number(timeoutMs))
    : (process.env.NODE_TEST_CONTEXT || process.env.NODE_ENV === 'test' ? 0 : 10 * 60 * 1000);
  if (!current || !current.active) {
    return Promise.resolve({ active: false, released: true, waited: false });
  }
  if (timeout <= 0) {
    return Promise.resolve({ active: true, released: false, timedOut: true, waited: false });
  }
  return new Promise((resolve) => {
    let timer = null;
    const entry = {
      resolve,
      cleanup() {
        if (timer) clearTimeout(timer);
        timer = null;
        if (signal && typeof signal.removeEventListener === 'function') {
          signal.removeEventListener('abort', onAbort);
        }
      },
    };
    const finish = (result) => {
      const set = waitersByKey.get(key);
      if (set) set.delete(entry);
      entry.cleanup();
      resolve(result);
    };
    const onAbort = () => finish({ active: true, released: false, aborted: true, waited: true });
    timer = setTimeout(() => finish({ active: true, released: false, timedOut: true, waited: true }), timeout);
    if (signal) {
      if (signal.aborted) return onAbort();
      if (typeof signal.addEventListener === 'function') {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }
    addWaiter(key, entry);
  });
}

function takeoverKey(identityOrConversationId, user) {
  if (identityOrConversationId && typeof identityOrConversationId === 'object' && identityOrConversationId.sessionKey) {
    return String(identityOrConversationId.sessionKey);
  }
  const conversationId = String(
    (identityOrConversationId && identityOrConversationId.conversationId)
    || identityOrConversationId
    || '',
  ).trim();
  const identity = resolveSessionIdentity(user || { id: 'member' }, conversationId);
  return identity.sessionKey;
}

function beginTakeover({ conversationId, user, site, kind, reason, identity } = {}) {
  const key = takeoverKey(identity || conversationId, user);
  const row = {
    active: true,
    conversationId: String((identity && identity.conversationId) || conversationId || '').trim() || null,
    sessionKey: key,
    site: site || '',
    kind: kind || 'password',
    reason: reason || 'login_form',
    at: new Date().toISOString(),
  };
  takeoverByKey.set(key, row);
  try {
    const gw = require('../agent-runner/engine-gateway');
    gw.takeControl({
      computerId: 'chat:' + (row.conversationId || key),
      reason: row.reason || 'login_wall',
      actorId: 'user',
    });
  } catch (_) { /* gateway optional */ }
  const published = publicTakeover(row);
  emitTakeoverChange(published);
  return published;
}

function endTakeover({ conversationId, user, identity } = {}) {
  const key = takeoverKey(identity || conversationId, user);
  const prev = takeoverByKey.get(key);
  takeoverByKey.delete(key);
  try {
    const gw = require('../agent-runner/engine-gateway');
    gw.releaseControl({ computerId: 'chat:' + ((prev && prev.conversationId) || key), actorId: 'user' });
  } catch (_) { /* gateway optional */ }
  const released = { active: false, conversationId: (prev && prev.conversationId) || null, released: true, event: LOGIN_HANDOFF_EVENT };
  flushWaiters(key, { active: false, released: true, waited: true, conversationId: released.conversationId });
  emitTakeoverChange(released);
  return released;
}

function getTakeover({ conversationId, user, identity } = {}) {
  const key = takeoverKey(identity || conversationId, user);
  const row = takeoverByKey.get(key);
  if (!row) return { active: false, conversationId: String(conversationId || '').trim() || null };
  return publicTakeover(row);
}

function publicTakeover(row) {
  return {
    active: true,
    conversationId: row.conversationId,
    site: row.site || '',
    kind: row.kind,
    reason: row.reason,
    at: row.at,
    title: COPY.title,
    instruction: row.site ? `${COPY.instruction.replace(/este sitio/, row.site)}` : COPY.instruction,
    neverSees: COPY.neverSees,
    ready: COPY.ready,
    event: LOGIN_HANDOFF_EVENT,
  };
}

function resetTakeoverForTests() {
  takeoverByKey.clear();
  lastObserveByKey.clear();
  for (const key of [...waitersByKey.keys()]) {
    flushWaiters(key, { active: false, released: true, waited: false, reset: true });
  }
  takeoverBus.removeAllListeners(LOGIN_HANDOFF_EVENT);
}

function refuseAgentType(input = {}) {
  const takeover = input.takeover != null ? input.takeover : getTakeover(input);
  const focused = input.focused || input.focusedField || null;
  const page = pageContextForGate(input);
  const gate = input.gate || detectLoginGate({ ...page, focused });
  const text = input.text != null ? String(input.text) : (input.args && input.args.text != null ? String(input.args.text) : '');
  const toolName = String(input.toolName || input.tool || 'computer_type');
  const isTypeTool = /computer_type|computer_key|type|keypress|key_press/i.test(toolName);

  if (!isTypeTool && !input.force) {
    return { refuse: false, ok: true, code: null };
  }

  if (takeover && takeover.active) {
    return refuseResult('user_takeover');
  }
  if (focused && isSecretField(focused, { inLoginForm: true })) {
    return refuseResult('secret_field_focused');
  }
  if (gate && gate.gated && (gate.kind === 'password' || gate.kind === 'otp' || gate.kind === 'payment' || gate.focusedSecret)) {
    return refuseResult(gate.reason || 'login_gate');
  }
  if (text && looksLikeSecretPayload(text)) {
    return refuseResult('secret_payload');
  }
  return { refuse: false, ok: true, code: null, typed: text };
}

function refuseResult(reason) {
  return {
    refuse: true,
    ok: false,
    code: LOGIN_HANDOFF_CODE,
    reason,
    loginHandoff: true,
    message: COPY.refuseType,
    typed: 0,
    text: undefined,
  };
}

function looksLikeSecretPayload(text) {
  const t = String(text || '');
  if (!t) return false;
  if (/^(password|passwd|otp|2fa|cvv)\s*[:=]/i.test(t)) return true;
  if (/^\d{3,8}$/.test(t.trim()) && t.trim().length <= 8) return false; // ambiguous; gate+focus handles OTP
  return false;
}

function redactToolArgs(args) {
  if (!args || typeof args !== 'object') return args;
  const out = { ...args };
  for (const k of Object.keys(out)) {
    if (SECRET_NAME_RE.test(k) || /username|user|email/i.test(k)) {
      out[k] = REDACTED;
    }
  }
  if (out.text != null && looksLikeSecretPayload(out.text)) {
    out.text = REDACTED;
  }
  return out;
}

function redactLogPayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const out = { ...payload };
  if (out.args) out.args = redactToolArgs(out.args);
  if (out.text) out.text = redactSecretsFromText(out.text, { inLoginForm: true });
  if (out.typed && typeof out.typed === 'string') out.typed = REDACTED;
  for (const k of Object.keys(out)) {
    if (SECRET_NAME_RE.test(k)) out[k] = REDACTED;
  }
  return out;
}

function modelMustNotAskPasswordInChat(text) {
  const t = String(text || '');
  if (!t) return true;
  return !/(pega|paste|escribe|escr[ií]beme|m[aá]ndame|env[ií]ame).{0,40}(contrase|password|otp|cvv|usuario.{0,10}y.{0,10}contrase)/i.test(t);
}

function isPasswordPasteRequest(text) {
  return !modelMustNotAskPasswordInChat(text);
}

const OPEN_COMPUTER_RE = /\b(abre|abrir|enciende|usa|usar|abre(?:me|la)?)\b.{0,48}\b(?:tu |la |el |mi )?(computadora|ordenador|navegador|browser|overlay)\b/i;
const LIVE_BROWSE_RE = /\b(busca(?:r|me|le)? en vivo|buscar en vivo|en el navegador|live (?:search|browse)|navega(?:r)? (?:a|en|por)|en tu computadora)\b/i;
const SHOPPING_RE = /\b(ofertas?|prendas? de vestir|shopping|comprar ropa|tienda de ropa|ropa de (?:mujer|hombre|ni[nñ][oa]s?))\b/i;
const BOOKING_RE = /\b(reserva(?:r)?(?: un[oa]?| el| la)? (?:vuelo|hotel|mesa|cita|restaurante|turno)|hacer una reserva|booking)\b/i;
const APPOINTMENT_RE = /\b(agend(?:a|ar)(?: una| la)? cita|pedir cita|saca(?:r)? una cita|cita (?:m[eé]dica|en el|para|del|de ))\b/i;
const PORTAL_ALWAYS_RE = /\b(dmv|pasaporte|passport)\b/i;

function isAuthenticatedComputerTask(prompt) {
  const t = String(prompt || '').toLowerCase();
  if (!t.trim()) return false;
  if (EXAMPLE_AUTHENTICATED_TASKS.some((ex) => t.includes(ex.slice(0, 24).toLowerCase()) || fuzzyIncludes(t, ex))) {
    return true;
  }
  const portal = /\b(dmv|pasaporte|passport|seguro|insurance|reembolso|landlord|arrendador|veterinari|vet\b|departamento|apartamento|utilities|luz|agua|internet|registro del auto|in-network|m[eé]dico|boletos|tickets|permiso|proveedor|vendor|campa[nñ]a|anuncios|ads manager|hiring|candidatos|facturas|contabilidad|reventa|drop)\b/i.test(t);
  const action = /\b(renueva|agenda|tramita|reclama|activa|cancela|coordina|escribe|filtra|reordena|manda|eval[uú]a|analiza|compra|cierra|avisa|busca|contacta)\b/i.test(t);
  return portal && action;
}

function isLiveComputerUsePrompt(prompt) {
  const t = String(prompt || '');
  if (!t.trim()) return false;
  if (OPEN_COMPUTER_RE.test(t)) return true;
  if (LIVE_BROWSE_RE.test(t)) return true;
  if (SHOPPING_RE.test(t)) return true;
  if (BOOKING_RE.test(t)) return true;
  if (APPOINTMENT_RE.test(t)) return true;
  if (PORTAL_ALWAYS_RE.test(t)) return true;
  return isAuthenticatedComputerTask(t);
}

function fuzzyIncludes(hay, needle) {
  const n = String(needle || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (n.length < 12) return hay.includes(n);
  const head = n.slice(0, 18);
  return hay.includes(head);
}

function routeAuthenticatedComputerTask(prompt) {
  const live = isLiveComputerUsePrompt(prompt);
  const authenticated = isAuthenticatedComputerTask(prompt);
  return {
    useComputer: live,
    loginHandoff: authenticated,
    askPasswordInChat: false,
    openComputerInstead: true,
    policy: POLICY_ES,
    replyClass: live ? 'computer_use' : 'text',
  };
}

function cookieJarKey(identity) {
  if (!identity || identity.conversationBound !== true) return null;
  return `cookies:${identity.sessionKey}`;
}

function assertCookiesIsolated(jarA, jarB, identityA, identityB) {
  const keyA = cookieJarKey(identityA);
  const keyB = cookieJarKey(identityB);
  if (!keyA || !keyB) return { ok: false, code: 'isolation_required' };
  if (keyA === keyB) return { ok: false, code: 'shared_session_key' };
  const a = jarA instanceof Map ? jarA : new Map(Object.entries(jarA || {}));
  const b = jarB instanceof Map ? jarB : new Map(Object.entries(jarB || {}));
  for (const cookie of a.keys()) {
    if (b.has(cookie) && a.get(cookie) === b.get(cookie) && String(a.get(cookie)).includes('session')) {
      return { ok: false, code: 'cookie_leaked' };
    }
  }
  return { ok: true, keyA, keyB };
}

function loginHandoffToolResult(gate, takeover) {
  return JSON.stringify({
    ok: false,
    error: LOGIN_HANDOFF_CODE,
    loginHandoff: true,
    kind: gate && gate.kind,
    reason: gate && gate.reason,
    site: (gate && gate.site) || '',
    takeover: takeover ? { active: takeover.active, title: COPY.title } : { active: true, title: COPY.title },
    message: COPY.refuseType,
  });
}

function applyObserveHandoff(session, observeResult, { user, conversationId, identity } = {}) {
  const redacted = redactObservePayload(observeResult || {});
  const id = identity || resolveSessionIdentity(user || { id: session && session.memberKey }, conversationId || (session && session.conversationId));
  rememberObserve(id, redacted, user);
  if (redacted.loginHandoff) {
    const takeover = beginTakeover({
      identity: id,
      conversationId: id.conversationId,
      site: redacted.loginGate && redacted.loginGate.site,
      kind: redacted.loginGate && redacted.loginGate.kind,
      reason: redacted.loginGate && redacted.loginGate.reason,
    });
    redacted.takeover = takeover;
    redacted.event = LOGIN_HANDOFF_EVENT;
  }
  return redacted;
}

function filterModelPasswordPaste(text) {
  const raw = text == null ? '' : String(text);
  if (!raw) return raw;
  if (!isPasswordPasteRequest(raw)) return raw;
  return COPY.refuseType;
}

function sanitizeChatPayload(payload) {
  if (payload == null) return payload;
  if (typeof payload === 'string') return redactSecretsFromText(payload, { inLoginForm: true });
  if (Array.isArray(payload)) return payload.map((item) => sanitizeChatPayload(item));
  if (typeof payload !== 'object') return payload;
  return redactLogPayload(redactMessageMetadata(payload));
}

function loginHandoffResumeResult(gate, released) {
  if (released) {
    return JSON.stringify({
      ok: true,
      resumed: true,
      loginHandoff: false,
      message: 'El usuario inició sesión. Continúa en esta computadora. No pidas la contraseña en el chat. SiraGPT no ve tu contraseña.',
    });
  }
  return loginHandoffToolResult(gate, { active: true });
}

function overlayOpenFromTakeover(state) {
  const active = Boolean(state && state.active);
  return { openPanel: active, expand: active, banner: active, fullScreenMobile: active };
}

function ssePayloadFromTakeover(state) {
  const active = Boolean(state && state.active);
  return {
    type: LOGIN_HANDOFF_EVENT,
    active,
    conversationId: (state && state.conversationId) || null,
    site: (state && state.site) || '',
    kind: (state && state.kind) || null,
    reason: (state && state.reason) || null,
    title: COPY.title,
    instruction: (state && state.instruction) || COPY.instruction,
    neverSees: COPY.neverSees,
    ready: COPY.ready,
  };
}

function overlayLayoutContract(viewportWidth) {
  const width = Number(viewportWidth) || 0;
  const mobile = width > 0 && width < 768;
  return {
    mobile,
    fullScreen: mobile,
    minTapPx: 44,
    bannerMinHeightPx: mobile ? 64 : 48,
    noClippedChrome: true,
    overlayPosition: mobile ? 'fixed-inset-0' : 'panel',
  };
}

module.exports = {
  REDACTED,
  LOGIN_HANDOFF_CODE,
  LOGIN_HANDOFF_EVENT,
  COPY,
  POLICY_ES,
  HAS_COMPUTER_POLICY_ES,
  isLiveComputerUsePrompt,
  EXAMPLE_AUTHENTICATED_TASKS,
  SECRET_NAME_RE,
  isPasswordField,
  isOtpField,
  isCvvField,
  isUsernameInLoginForm,
  isSecretField,
  looksLikeLoginForm,
  detectLoginGate,
  redactSecretsFromText,
  redactAxNode,
  redactObservePayload,
  redactMessageMetadata,
  redactToolArgs,
  redactLogPayload,
  refuseAgentType,
  beginTakeover,
  endTakeover,
  getTakeover,
  resetTakeoverForTests,
  isAuthenticatedComputerTask,
  isLiveComputerUsePrompt,
  routeAuthenticatedComputerTask,
  modelMustNotAskPasswordInChat,
  isPasswordPasteRequest,
  cookieJarKey,
  assertCookiesIsolated,
  loginHandoffToolResult,
  applyObserveHandoff,
  overlayLayoutContract,
  siteNameFromUrl,
  rememberObserve,
  getLastObserve,
  subscribeTakeover,
  waitUntilReleased,
  emitTakeoverChange,
  filterModelPasswordPaste,
  sanitizeChatPayload,
  loginHandoffResumeResult,
  overlayOpenFromTakeover,
  ssePayloadFromTakeover,
};
