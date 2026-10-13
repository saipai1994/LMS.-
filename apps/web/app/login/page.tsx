'use client';
import { FormEvent, useEffect, useState } from 'react';
import { api, errText, setToken } from '@/lib/api';
import { Alert, Button, Input } from '@/components/ui';

interface DemoInfo { tenant: string; password: string; accounts: string[]; mfa: string }

export default function Login() {
  const [demo, setDemo] = useState<DemoInfo | null>(null);
  const [tenant, setTenant] = useState('greenwood');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mfa, setMfa] = useState('');
  const [needMfa, setNeedMfa] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api<DemoInfo>('/demo/info').then(setDemo).catch(() => setDemo(null)); }, []);

  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      const r = await api<{ token: string }>('/auth/login', { body: { tenant, email, password, ...(mfa ? { mfaCode: mfa } : {}) } });
      setToken(r.token); location.href = '/';
    } catch (err: any) {
      if (err?.body?.error === 'mfa_required') { setNeedMfa(true); setError('Enter the 6-digit code from your authenticator app.'); }
      else setError(errText(err));
    } finally { setBusy(false); }
  }

  return (
    <div className="login">
      <h1>Sign in</h1>
      <p className="sub">K-12 ERP + LMS</p>
      <form onSubmit={submit} className="card">
        <Input label="School code" value={tenant} onChange={(e) => setTenant(e.target.value)} required autoComplete="organization" />
        <Input label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" />
        <Input label="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
        {needMfa && <Input label="Authenticator code" inputMode="numeric" pattern="\d{6}" maxLength={6} value={mfa} onChange={(e) => setMfa(e.target.value)} required autoFocus />}
        {error && <Alert kind="error">{error}</Alert>}
        <Button type="submit" busy={busy}>Sign in</Button>
      </form>
      {demo && (
        <div className="card">
          <h2>Demo accounts</h2>
          <p className="sub">Fictional data. Password for all: <code>{demo.password}</code>. {demo.mfa}</p>
          <div className="chips">
            {demo.accounts.map((a) => (
              <button key={a} className="chip" type="button" onClick={() => { setTenant(demo.tenant); setEmail(a); setPassword(demo.password); setError(null); }}>{a.split('@')[0]}</button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
