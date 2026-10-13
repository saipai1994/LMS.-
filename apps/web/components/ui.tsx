'use client';
import { ReactNode, useId, useState } from 'react';
import { errText } from '@/lib/api';

export const Card = ({ title, action, children, className = '' }: { title?: string; action?: ReactNode; children: ReactNode; className?: string }) => (
  <section className={`card ${className}`}>{(title || action) && <header className="card-h"><h2>{title}</h2>{action}</header>}{children}</section>
);
export const Stat = ({ label, value, tone, hint }: { label: string; value: ReactNode; tone?: 'good' | 'warn' | 'bad'; hint?: string }) => (
  <div className={`stat ${tone ?? ''}`}><div className="stat-v">{value}</div><div className="stat-l">{label}</div>{hint && <div className="stat-h">{hint}</div>}</div>
);
export const Badge = ({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'good' | 'warn' | 'bad' | 'info' }) => <span className={`badge ${tone}`}>{children}</span>;
export const statusTone = (s: string) => (['paid', 'graded', 'present', 'approved', 'returned', 'on_campus', 'closed', 'succeeded', 'enrolled', 'accepted', 'active'].includes(s) ? 'good'
  : ['overdue', 'absent', 'rejected', 'critical', 'missing', 'failed'].includes(s) ? 'bad'
  : ['requested', 'submitted', 'partially_paid', 'late', 'pending', 'under_review', 'investigating', 'on_leave', 'waitlisted', 'open', 'draft'].includes(s) ? 'warn' : 'neutral') as 'good' | 'bad' | 'warn' | 'neutral';
export const StatusBadge = ({ s }: { s: string }) => <Badge tone={statusTone(s)}>{s.replace(/_/g, ' ')}</Badge>;

export function Button({ children, onClick, variant = 'primary', type = 'button', disabled, busy, small }: { children: ReactNode; onClick?: () => void | Promise<void>; variant?: 'primary' | 'secondary' | 'danger'; type?: 'button' | 'submit'; disabled?: boolean; busy?: boolean; small?: boolean }) {
  return <button type={type} className={`btn ${variant} ${small ? 'sm' : ''}`} onClick={onClick} disabled={disabled || busy} aria-busy={busy}>{busy ? 'Working…' : children}</button>;
}

export function Field({ label, children, hint }: { label: string; children: (id: string) => ReactNode; hint?: string }) {
  const id = useId();
  return <div className="field"><label htmlFor={id}>{label}</label>{children(id)}{hint && <small>{hint}</small>}</div>;
}
export const Input = (p: React.InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) => {
  const { label, hint, ...rest } = p;
  return <Field label={label} hint={hint}>{(id) => <input id={id} {...rest} />}</Field>;
};
export const Select = (p: React.SelectHTMLAttributes<HTMLSelectElement> & { label: string; options: { value: string; label: string }[]; placeholder?: string }) => {
  const { label, options, placeholder, ...rest } = p;
  return <Field label={label}>{(id) => <select id={id} {...rest}>{placeholder !== undefined && <option value="">{placeholder}</option>}{options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>}</Field>;
};

export const Loading = ({ what = 'data' }: { what?: string }) => <div className="state" role="status" aria-live="polite"><span className="spinner" aria-hidden /> Loading {what}…</div>;
export const Empty = ({ children }: { children: ReactNode }) => <div className="state empty">{children}</div>;
export const ErrorBox = ({ message, onRetry }: { message: string; onRetry?: () => void }) => (
  <div className="state error" role="alert">{message}{onRetry && <> <button className="link" onClick={onRetry}>Retry</button></>}</div>
);
export const Alert = ({ kind, children }: { kind: 'success' | 'error' | 'info'; children: ReactNode }) => <div className={`alert ${kind}`} role={kind === 'error' ? 'alert' : 'status'}>{children}</div>;

/** Loading/error/empty wrapper for async data. */
export function Async<T>({ q, what, empty, children }: { q: { data: T | null; loading: boolean; error: string | null; reload: () => void }; what?: string; empty?: (d: T) => boolean; children: (d: T) => ReactNode }) {
  if (q.loading && !q.data) return <Loading what={what} />;
  if (q.error) return <ErrorBox message={q.error} onRetry={q.reload} />;
  if (q.data === null) return null;
  if (empty?.(q.data)) return <Empty>Nothing here yet.</Empty>;
  return <>{children(q.data)}</>;
}

export function Table({ cols, rows, empty = 'No records.', caption }: { cols: { key: string; label: string; render?: (r: any) => ReactNode; align?: 'right' }[]; rows: any[]; empty?: string; caption?: string }) {
  if (!rows.length) return <Empty>{empty}</Empty>;
  return (
    <div className="table-wrap" tabIndex={0} role="region" aria-label={caption ?? 'table'}>
      <table>{caption && <caption className="sr-only">{caption}</caption>}
        <thead><tr>{cols.map((c) => <th key={c.key} scope="col" className={c.align}>{c.label}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={r.id ?? r.student_id ?? i}>{cols.map((c) => <td key={c.key} className={c.align}>{c.render ? c.render(r) : r[c.key] ?? '—'}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

/** Runs an async action and reports success/failure inline. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const run = async (fn: () => Promise<unknown>, ok = 'Done.') => {
    setBusy(true); setMsg(null);
    try { await fn(); setMsg({ kind: 'success', text: ok }); return true; } catch (e) { setMsg({ kind: 'error', text: errText(e) }); return false; } finally { setBusy(false); }
  };
  return { busy, msg, run, clear: () => setMsg(null), node: msg ? <Alert kind={msg.kind}>{msg.text}</Alert> : null };
}

export const BarSpark = ({ values, labels, max = 100 }: { values: number[]; labels: string[]; max?: number }) => (
  <div className="spark" role="img" aria-label={`Trend: ${labels.map((l, i) => `${l} ${values[i]}%`).join(', ')}`}>
    {values.map((v, i) => <div key={i} className="bar" style={{ height: `${Math.max(4, (v / max) * 100)}%` }} title={`${labels[i]}: ${v}%`} />)}
  </div>
);
