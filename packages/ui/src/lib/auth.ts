import { create } from 'zustand';

export const API_TOKEN_STORAGE_KEY = 'stablehand.apiToken';

interface ApiAuthState {
  token: string;
  authRequired: boolean;
  setToken: (token: string) => void;
  clearToken: () => void;
  setAuthRequired: (required: boolean) => void;
}

function canUseStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function readStoredToken(): string {
  if (!canUseStorage()) return '';
  try {
    return window.localStorage.getItem(API_TOKEN_STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

function writeStoredToken(token: string): void {
  if (!canUseStorage()) return;
  try {
    if (token) {
      window.localStorage.setItem(API_TOKEN_STORAGE_KEY, token);
    } else {
      window.localStorage.removeItem(API_TOKEN_STORAGE_KEY);
    }
  } catch {
    // Storage can be unavailable in private contexts. Keep the in-memory token.
  }
}

export const useApiAuthStore = create<ApiAuthState>((set) => ({
  token: readStoredToken(),
  authRequired: false,
  setToken: (token) => {
    const trimmed = token.trim();
    writeStoredToken(trimmed);
    set({ token: trimmed, authRequired: false });
  },
  clearToken: () => {
    writeStoredToken('');
    set({ token: '', authRequired: true });
  },
  setAuthRequired: (required) => set({ authRequired: required }),
}));

export function getApiToken(): string {
  return useApiAuthStore.getState().token;
}

export function markAuthRequired(): void {
  useApiAuthStore.getState().clearToken();
}

export function mergeAuthHeaders(headers?: HeadersInit): HeadersInit | undefined {
  const token = getApiToken();
  if (!token) return headers;

  if (headers instanceof Headers) {
    const merged = new Headers(headers);
    merged.set('Authorization', `Bearer ${token}`);
    return merged;
  }

  if (Array.isArray(headers)) {
    return [...headers, ['Authorization', `Bearer ${token}`]];
  }

  return {
    ...(headers ?? {}),
    Authorization: `Bearer ${token}`,
  };
}

export function withApiAuth(init?: RequestInit): RequestInit | undefined {
  const headers = mergeAuthHeaders(init?.headers);
  if (!headers) return init;
  return {
    ...(init ?? {}),
    headers,
  };
}
