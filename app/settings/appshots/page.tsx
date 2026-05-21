'use client';

import { useCallback, useState } from 'react';

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

const API_BASE = process.env.NEXT_PUBLIC_API_URL || '';

export default function AppshotsSettingsPage() {
  const [loading, setLoading] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [apiBaseUrl, setApiBaseUrl] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const generate = useCallback(async () => {
    setLoading(true);
    setError(null);
    setToken(null);
    setCopied(false);
    try {
      // CSRF: backend uses the `csrf_token` cookie (underscore) paired with
      // the httpOnly `_csrf_secret`. If the public cookie hasn't been issued
      // yet (fresh tab, never POSTed before), prime it by hitting the
      // dedicated endpoint — same pattern as lib/api.ts._ensureCsrfToken.
      let csrfToken = readCookie('csrf_token');
      if (!csrfToken) {
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
      }
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
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

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

function readCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const pairs = document.cookie.split(';');
  for (const raw of pairs) {
    const [k, ...rest] = raw.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}
