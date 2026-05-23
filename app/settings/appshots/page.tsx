'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Página de vinculación de la extensión Sira Appshots.
 *
 * - Pulsa "Generar código" → POST /api/appshots/pair (con cookie + CSRF
 *   estándar) → muestra el token UNA sola vez.
 * - Copia + pega en la extensión.
 *
 * Sin emojis, copy en español, registro corto siguiendo el estilo de Sira.
 */

type PairResponse = {
  token: string;
  expiresInDays: number;
  apiBaseUrl: string;
};

type AppshotsRevocation = {
  id: string;
  sessionId: string | null;
  when: string;
  reason: string;
};

type AppshotsSession = {
  id: string;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  label: string | null;
  userAgent: string | null;
  ipHint: string | null;
  geoHint: string | null;
  geoHintStatus?: 'ok' | 'private' | 'unresolved';
  device: string | null;
  isCurrent?: boolean;
};

const API_BASE = process.env.NEXT_PUBLIC_API_URL || '';

export default function AppshotsSettingsPage() {
  const [loading, setLoading] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [apiBaseUrl, setApiBaseUrl] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [sessions, setSessions] = useState<AppshotsSession[] | null>(null);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [revocations, setRevocations] = useState<AppshotsRevocation[] | null>(null);
  const [revocationsError, setRevocationsError] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState<string>('');
  const [savingRenameId, setSavingRenameId] = useState<string | null>(null);

  const loadSessions = useCallback(async () => {
    setSessionsError(null);
    try {
      const resp = await fetch(`${API_BASE}/api/appshots/sessions`, {
        method: 'GET',
        credentials: 'include',
      });
      if (!resp.ok) throw new Error(`No se pudieron cargar las sesiones (${resp.status}).`);
      const data = (await resp.json()) as { sessions: AppshotsSession[] };
      setSessions(data.sessions || []);
    } catch (err) {
      setSessionsError(err instanceof Error ? err.message : String(err));
      setSessions([]);
    }
  }, []);

  const loadRevocations = useCallback(async () => {
    setRevocationsError(null);
    try {
      const resp = await fetch(`${API_BASE}/api/appshots/revocations`, {
        method: 'GET',
        credentials: 'include',
      });
      if (!resp.ok) throw new Error(`No se pudo cargar el historial (${resp.status}).`);
      const data = (await resp.json()) as { revocations: AppshotsRevocation[] };
      setRevocations(data.revocations || []);
    } catch (err) {
      setRevocationsError(err instanceof Error ? err.message : String(err));
      setRevocations([]);
    }
  }, []);

  useEffect(() => {
    loadSessions();
    loadRevocations();
  }, [loadSessions, loadRevocations]);

  const revoke = useCallback(
    async (id: string, opts?: { isCurrent?: boolean }) => {
      // Task 20: si la sesión coincide con el navegador actual, exigimos
      // una confirmación extra. La extensión deja de poder enviar
      // capturas inmediatamente, así que si el usuario lo hace por
      // error se queda sin la integración hasta volver a vincular.
      if (opts?.isCurrent) {
        const ok =
          typeof window === 'undefined'
            ? true
            : window.confirm(
                'Vas a revocar la sesión del dispositivo desde el que estás conectado ahora. ' +
                  'La extensión dejará de poder enviar capturas hasta que la vincules de nuevo. ' +
                  '¿Seguro que quieres continuar?',
              );
        if (!ok) return;
      }
      setRevokingId(id);
      setSessionsError(null);
      try {
        const csrfToken = await ensureCsrfToken();
        const resp = await fetch(`${API_BASE}/api/appshots/sessions/${encodeURIComponent(id)}`, {
          method: 'DELETE',
          credentials: 'include',
          headers: { 'x-csrf-token': csrfToken || '' },
        });
        if (!resp.ok) throw new Error(`No se pudo revocar (${resp.status}).`);
        await loadSessions();
      } catch (err) {
        setSessionsError(err instanceof Error ? err.message : String(err));
      } finally {
        setRevokingId(null);
      }
    },
    [loadSessions],
  );

  const startRename = useCallback((s: AppshotsSession) => {
    setRenamingId(s.id);
    setRenameDraft(s.label || '');
    setSessionsError(null);
  }, []);

  const cancelRename = useCallback(() => {
    setRenamingId(null);
    setRenameDraft('');
  }, []);

  const saveRename = useCallback(
    async (id: string) => {
      setSavingRenameId(id);
      setSessionsError(null);
      try {
        const csrfToken = await ensureCsrfToken();
        const trimmed = renameDraft.trim();
        const resp = await fetch(`${API_BASE}/api/appshots/sessions/${encodeURIComponent(id)}`, {
          method: 'PATCH',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            'x-csrf-token': csrfToken || '',
          },
          body: JSON.stringify({ label: trimmed === '' ? null : trimmed }),
        });
        if (!resp.ok) throw new Error(`No se pudo renombrar (${resp.status}).`);
        setRenamingId(null);
        setRenameDraft('');
        await loadSessions();
      } catch (err) {
        setSessionsError(err instanceof Error ? err.message : String(err));
      } finally {
        setSavingRenameId(null);
      }
    },
    [renameDraft, loadSessions],
  );

  const generate = useCallback(async () => {
    setLoading(true);
    setError(null);
    setToken(null);
    setCopied(false);
    try {
      const csrfToken = await ensureCsrfToken();
      const resp = await fetch(`${API_BASE}/api/appshots/pair`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'x-csrf-token': csrfToken || '',
        },
        body: JSON.stringify({}),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`No se pudo generar el código (${resp.status}). ${text.slice(0, 160)}`);
      }
      const data = (await resp.json()) as PairResponse;
      setToken(data.token);
      setApiBaseUrl(data.apiBaseUrl);
      // Refresh the active-sessions list so the user sees the freshly
      // minted token appear without a manual reload.
      loadSessions();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [loadSessions]);

  const copy = useCallback(async () => {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch (_) {
      setCopied(false);
    }
  }, [token]);

  return (
    <div className="mx-auto max-w-2xl px-6 py-10">
      <h1 className="text-2xl font-semibold">Sira Appshots</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Vincula la extensión de Chrome para capturar cualquier ventana y enviarla a Sira.
      </p>

      <section className="mt-8 rounded-lg border border-border bg-card p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Paso 1 · Instala la extensión
        </h2>
        <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm">
          <li>Descarga la carpeta <code>extension/</code> del repositorio.</li>
          <li>
            En Chrome abre <code>chrome://extensions</code> → activa <em>Modo desarrollador</em>{' '}
            → pulsa <em>Cargar descomprimida</em> → elige la carpeta.
          </li>
        </ol>
      </section>

      <section className="mt-6 rounded-lg border border-border bg-card p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Paso 2 · Genera un código
        </h2>
        <p className="mt-2 text-sm">
          El código tiene validez de 1 año y sólo se muestra una vez. Si lo pierdes, genera otro.
        </p>
        <button
          type="button"
          onClick={generate}
          disabled={loading}
          className="mt-4 inline-flex items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {loading ? 'Generando…' : token ? 'Generar otro código' : 'Generar código'}
        </button>

        {error ? (
          <p className="mt-3 rounded border border-destructive bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        ) : null}

        {token ? (
          <div className="mt-4 space-y-3">
            <div className="rounded bg-muted p-3 font-mono text-xs break-all">{token}</div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={copy}
                className="rounded-md border border-border bg-background px-3 py-1.5 text-sm hover:bg-muted"
              >
                {copied ? 'Copiado' : 'Copiar código'}
              </button>
              <span className="text-xs text-muted-foreground self-center">
                Servidor: <code>{apiBaseUrl}</code>
              </span>
            </div>
          </div>
        ) : null}
      </section>

      <section className="mt-6 rounded-lg border border-border bg-card p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Sesiones activas de Appshots
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Si pierdes el portátil o quieres desconectar la extensión, revoca su sesión aquí.
          La extensión dejará de poder enviar capturas inmediatamente.
        </p>

        {sessionsError ? (
          <p className="mt-3 rounded border border-destructive bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {sessionsError}
          </p>
        ) : null}

        {sessions === null ? (
          <p className="mt-3 text-sm text-muted-foreground">Cargando…</p>
        ) : sessions.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">
            No hay extensiones vinculadas todavía.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-border rounded border border-border">
            {sessions.map((s) => {
              const headline =
                s.label ||
                s.device ||
                (s.userAgent ? s.userAgent.slice(0, 60) : 'Dispositivo sin identificar');
              const subtitleParts: string[] = [];
              if (s.label && s.device) subtitleParts.push(s.device);
              // Task 19 — prefer the resolved "City, CC" hint over the raw
              // /24 prefix; only fall back to the prefix when geo lookup
              // failed (or the row predates the migration).
              if (s.geoHint) subtitleParts.push(s.geoHint);
              else if (s.ipHint) subtitleParts.push(s.ipHint);
              // Task 29 — when geo lookup didn't produce a label, render
              // a discreet sub-line explaining *why* (private network,
              // upstream failure) so the user understands the contrast
              // with other devices that do show a city.
              const geoStatusNote =
                s.geoHintStatus && s.geoHintStatus !== 'ok'
                  ? describeGeoHintStatus(s.geoHintStatus)
                  : null;
              return (
                <li
                  key={s.id}
                  className="flex flex-col gap-2 px-3 py-2 sm:flex-row sm:items-start sm:justify-between"
                >
                  <div className="text-sm">
                    {s.isCurrent ? (
                      <div className="mb-1">
                        <span className="inline-flex items-center rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                          Este dispositivo
                        </span>
                      </div>
                    ) : null}
                    {renamingId === s.id ? (
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                        <input
                          type="text"
                          value={renameDraft}
                          onChange={(e) => setRenameDraft(e.target.value)}
                          maxLength={80}
                          placeholder="Ej. Portátil del trabajo"
                          className="rounded border border-border bg-background px-2 py-1 text-sm"
                          autoFocus
                        />
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => saveRename(s.id)}
                            disabled={savingRenameId === s.id}
                            className="rounded-md border border-border bg-background px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
                          >
                            {savingRenameId === s.id ? 'Guardando…' : 'Guardar'}
                          </button>
                          <button
                            type="button"
                            onClick={cancelRename}
                            disabled={savingRenameId === s.id}
                            className="rounded-md border border-border bg-background px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
                          >
                            Cancelar
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="font-medium">{headline}</div>
                    )}
                    {subtitleParts.length > 0 ? (
                      <div className="text-xs text-muted-foreground">
                        {subtitleParts.join(' · ')}
                      </div>
                    ) : null}
                    {geoStatusNote ? (
                      <div
                        className="text-xs italic text-muted-foreground/80"
                        data-testid="appshots-geo-status"
                      >
                        {geoStatusNote}
                      </div>
                    ) : null}
                    <div className="text-xs text-muted-foreground">
                      Vinculada el {formatDate(s.createdAt)}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Último uso: {s.lastUsedAt ? formatDate(s.lastUsedAt) : 'sin usar todavía'}
                    </div>
                  </div>
                  <div className="flex gap-2 self-start sm:self-auto">
                    {renamingId === s.id ? null : (
                      <button
                        type="button"
                        onClick={() => startRename(s)}
                        className="rounded-md border border-border bg-background px-3 py-1.5 text-sm hover:bg-muted"
                      >
                        Renombrar
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => revoke(s.id, { isCurrent: s.isCurrent })}
                      disabled={revokingId === s.id}
                      title={
                        s.isCurrent
                          ? 'Estás conectado desde este dispositivo. Pediremos confirmación antes de revocar.'
                          : undefined
                      }
                      className="rounded-md border border-destructive bg-background px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10 disabled:opacity-50"
                    >
                      {revokingId === s.id ? 'Revocando…' : 'Revocar'}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="mt-6 rounded-lg border border-border bg-card p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Revocaciones recientes
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Cuando detectamos un problema con un dispositivo vinculado (cambio de
          red, token caducado, intervención del equipo de soporte) lo
          desconectamos automáticamente y te avisamos por email. Aquí queda el
          registro por si pierdes el correo.
        </p>

        {revocationsError ? (
          <p className="mt-3 rounded border border-destructive bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {revocationsError}
          </p>
        ) : null}

        {revocations === null ? (
          <p className="mt-3 text-sm text-muted-foreground">Cargando…</p>
        ) : revocations.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">
            No hay revocaciones automáticas registradas en los últimos 6 meses.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-border rounded border border-border">
            {revocations.map((r) => (
              <li key={r.id} className="flex flex-col gap-1 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="text-sm">
                  <div className="font-medium">{describeRevocationReason(r.reason)}</div>
                  <div className="text-xs text-muted-foreground">{formatDate(r.when)}</div>
                </div>
                <div className="text-xs text-muted-foreground sm:text-right">
                  Código: <code>{r.reason}</code>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="mt-6 rounded-lg border border-border bg-card p-5">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Paso 3 · Pégalo en la extensión
        </h2>
        <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm">
          <li>Abre la extensión → <em>Vincular con Sira</em>.</li>
          <li>Pega el código y guarda.</li>
          <li>
            Captura con <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 text-xs">⌘⇧S</kbd>{' '}
            (Mac) o <kbd className="rounded border border-border bg-muted px-1.5 py-0.5 text-xs">Ctrl⇧S</kbd>{' '}
            (Win/Linux).
          </li>
        </ol>
      </section>
    </div>
  );
}

export function describeGeoHintStatus(status: 'ok' | 'private' | 'unresolved'): string | null {
  // Task 29 — copy intentionally short and neutral. Anything longer
  // would push the device card onto a third visual line and start
  // competing for attention with the "Último uso" timestamp.
  switch (status) {
    case 'private':
      return 'Ubicación no disponible (red privada)';
    case 'unresolved':
      return 'Ubicación no disponible';
    case 'ok':
    default:
      return null;
  }
}

function describeRevocationReason(code: string): string {
  // Stable codes come from the backend (backend/src/routes/appshots.js
  // → mapAuditActionToReason). Keep this map small and explicit so a
  // typo on either side surfaces as the raw code rather than a
  // misleading Spanish string.
  switch (code) {
    case 'fingerprint_mismatch':
      return 'Cambio sospechoso de red o navegador';
    case 'token_expired':
      return 'Token caducado';
    case 'admin_revoked':
      return 'Revocado por el equipo de soporte';
    default:
      return 'Sesión revocada automáticamente';
  }
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString('es-ES', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch (_) {
    return iso;
  }
}

async function ensureCsrfToken(): Promise<string> {
  // CSRF: backend uses the `csrf_token` cookie (underscore) paired with the
  // httpOnly `_csrf_secret`. If the public cookie hasn't been issued yet
  // (fresh tab, never POSTed before), prime it by hitting the dedicated
  // endpoint — same pattern as lib/api.ts._ensureCsrfToken.
  let csrfToken = readCookie('csrf_token');
  if (csrfToken) return csrfToken;
  try {
    const seed = await fetch(`${API_BASE}/api/auth/csrf-token`, {
      method: 'GET',
      credentials: 'include',
    });
    if (seed.ok) {
      const data = (await seed.json().catch(() => null)) as { csrfToken?: string } | null;
      csrfToken = data?.csrfToken || readCookie('csrf_token') || '';
    }
  } catch (_) {
    // fall through — request will fail with csrf_invalid and surface
    // the real reason to the user instead of a silent retry loop.
  }
  return csrfToken || '';
}

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const pairs = document.cookie.split(';');
  for (const raw of pairs) {
    const [k, ...rest] = raw.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}
