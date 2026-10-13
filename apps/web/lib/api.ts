export class ApiError extends Error {
  constructor(public status: number, public body: any) { super(body?.error ?? `HTTP ${status}`); }
}

const KEY = 'lms_token';
export const getToken = (): string | null => { try { return sessionStorage.getItem(KEY); } catch { return null; } };
export const setToken = (t: string | null) => { try { t ? sessionStorage.setItem(KEY, t) : sessionStorage.removeItem(KEY); } catch { /* storage unavailable */ } };

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers: { ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  const body = text ? (() => { try { return JSON.parse(text); } catch { return { error: text.slice(0, 200) }; } })() : null;
  if (res.status === 401 && token) { setToken(null); if (typeof window !== 'undefined' && !location.pathname.startsWith('/login')) location.href = '/login'; }
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

export const money = (minor: number | string | null | undefined) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(Number(minor ?? 0) / 100);
export const fmtDate = (d?: string | null) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
export const fmtDateTime = (d?: string | null) => (d ? new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
export const errText = (e: unknown) => {
  if (e instanceof ApiError) return e.body?.issues ? `${e.body.error}: ${e.body.issues.map((i: any) => `${i.path} ${i.message}`).join('; ')}` : (e.body?.error ?? `Request failed (${e.status})`).replace(/_/g, ' ');
  return 'Network error — is the API running?';
};
