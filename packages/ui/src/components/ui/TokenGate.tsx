import { FormEvent, useState } from 'react';
import { KeyRound, LockKeyhole } from 'lucide-react';

import { ApiError, fetchConfig } from '@/lib/api';
import { useApiAuthStore } from '@/lib/auth';

export function TokenGate() {
  const authRequired = useApiAuthStore((s) => s.authRequired);
  const setToken = useApiAuthStore((s) => s.setToken);
  const clearToken = useApiAuthStore((s) => s.clearToken);
  const setAuthRequired = useApiAuthStore((s) => s.setAuthRequired);
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [checking, setChecking] = useState(false);

  if (!authRequired) return null;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const token = value.trim();
    if (!token) {
      setError('Enter a token.');
      return;
    }

    setChecking(true);
    setError('');
    setToken(token);
    try {
      await fetchConfig();
      setAuthRequired(false);
      setValue('');
    } catch (caught) {
      clearToken();
      const body = caught instanceof ApiError
        && caught.body
        && typeof caught.body === 'object'
        && !Array.isArray(caught.body)
        ? caught.body as Record<string, unknown>
        : null;
      if (caught instanceof ApiError && caught.status === 403 && body?.required_capability === null) {
        setError('Scoped keys cannot unlock the dashboard. Enter the master CTXMILL_API_TOKEN.');
      } else {
        setError('Token was not accepted.');
      }
    } finally {
      setChecking(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-surface-950/85 px-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="api-token-title"
    >
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm rounded-md border border-surface-700 bg-surface-900 shadow-2xl shadow-black/40"
      >
        <div className="border-b border-surface-700 px-5 py-4">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-md border border-accent-500/40 bg-accent-500/10 text-accent-300">
              <LockKeyhole className="h-4 w-4" aria-hidden="true" />
            </span>
            <div>
              <h1 id="api-token-title" className="text-sm font-semibold text-surface-100">
                API token required
              </h1>
              <p className="mt-1 text-xs text-surface-400">
                Enter the CTXMILL_API_TOKEN for this deployment.
              </p>
            </div>
          </div>
        </div>

        <div className="space-y-4 px-5 py-5">
          <label className="block text-xs font-medium text-surface-300" htmlFor="api-token-input">
            Token
          </label>
          <input
            id="api-token-input"
            type="password"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            autoComplete="off"
            autoFocus
            className="w-full rounded-md border border-surface-700 bg-surface-950 px-3 py-2 text-sm text-surface-100 outline-none transition-colors placeholder:text-surface-600 focus:border-accent-400 focus:ring-2 focus:ring-accent-400/20"
            placeholder="Bearer token"
          />
          {error && (
            <p className="rounded-md border border-status-error/40 bg-status-error/10 px-3 py-2 text-xs text-status-error">
              {error}
            </p>
          )}
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-surface-700 px-5 py-4">
          <button
            type="submit"
            disabled={checking}
            className="inline-flex min-h-9 items-center gap-2 rounded-md bg-accent-500 px-3 py-2 text-sm font-medium text-surface-950 transition-colors hover:bg-accent-400 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <KeyRound className="h-4 w-4" aria-hidden="true" />
            {checking ? 'Checking' : 'Unlock'}
          </button>
        </div>
      </form>
    </div>
  );
}
