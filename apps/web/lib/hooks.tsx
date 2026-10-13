'use client';
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api, errText, getToken, setToken } from './api';

export interface Profile { id: string; email: string; fullName: string; roles: string[]; grants: { permission: string; campusId: string | null }[]; mfaEnabled: boolean; tenant: { name: string; branding: any } | null }
interface Session { profile: Profile | null; loading: boolean; can: (p: string) => boolean; hasRole: (...r: string[]) => boolean; logout: () => Promise<void>; refresh: () => void }
export const SessionCtx = createContext<Session>({ profile: null, loading: true, can: () => false, hasRole: () => false, logout: async () => undefined, refresh: () => undefined });
export const useSession = () => useContext(SessionCtx);

export function useSessionLoader(): Session {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    if (!getToken()) { setProfile(null); setLoading(false); return; }
    try { setProfile(await api<Profile>('/me/profile')); } catch { setProfile(null); }
    setLoading(false);
  }, []);
  useEffect(() => { void load(); }, [load]);
  return {
    profile, loading,
    can: (p) => !!profile?.grants.some((g) => g.permission === p),
    hasRole: (...r) => !!profile?.roles.some((x) => r.includes(x)),
    logout: async () => { try { await api('/auth/logout', { method: 'POST', body: {} }); } catch { /* ignore */ } setToken(null); setProfile(null); location.href = '/login'; },
    refresh: () => { setLoading(true); void load(); },
  };
}

/** Loads data with explicit loading / error states; `reload` re-runs the fetch. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [state, setState] = useState<{ data: T | null; error: string | null; status: number | null; loading: boolean }>({ data: null, error: null, status: null, loading: true });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    fn().then((data) => live && setState({ data, error: null, status: 200, loading: false }))
      .catch((e) => live && setState({ data: null, error: errText(e), status: e?.status ?? 0, loading: false }));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { ...state, reload: () => setTick((t) => t + 1) };
}
