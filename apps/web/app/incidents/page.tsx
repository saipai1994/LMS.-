'use client';
import { useState } from 'react';
import { api, fmtDateTime } from '@/lib/api';
import { useAsync, useSession } from '@/lib/hooks';
import { Async, Button, Card, Input, Select, StatusBadge, Table, useAction } from '@/components/ui';

export default function Incidents() {
  const s = useSession();
  const q = useAsync(() => api<any[]>('/incidents'));
  const [openId, setOpenId] = useState<string | null>(null);
  return <><h1>Incidents</h1><p className="sub">Safety, welfare and operational incidents with full timelines. Safeguarding cases are visible only to safeguarding staff.</p>
    <Card title="Incident register"><Async q={q} what="incidents" empty={(d) => !d.length}>{(d) => <Table cols={[{ key: 'created_at', label: 'Raised', render: (r) => fmtDateTime(r.created_at) }, { key: 'category', label: 'Category', render: (r) => r.category.replace('_', ' ') }, { key: 'severity', label: 'Severity', render: (r) => <StatusBadge s={r.severity} /> }, { key: 'title', label: 'Title' }, { key: 'status', label: 'Status', render: (r) => <StatusBadge s={r.status} /> },
      { key: 'o', label: '', render: (r) => <Button small variant="secondary" onClick={() => setOpenId(r.id)}>Open</Button> }]} rows={d} />}</Async></Card>
    {openId && <Detail id={openId} onChange={q.reload} canManage={s.can('incident.manage') || s.can('safeguarding.manage')} />}
    <Report onCreated={q.reload} />
  </>;
}

function Detail({ id, onChange, canManage }: { id: string; onChange: () => void; canManage: boolean }) {
  const q = useAsync(() => api<any>(`/incidents/${id}`), [id]);
  const [note, setNote] = useState('');
  const act = useAction();
  const call = (path: string, body: any, ok: string) => async () => { if (await act.run(() => api(`/incidents/${id}/${path}`, { body }), ok)) { setNote(''); q.reload(); onChange(); } };
  return <Card title="Incident detail"><Async q={q} what="incident">{(d) => <>
    <h3>{d.title} <StatusBadge s={d.status} /></h3><p>{d.description}</p>
    <ul className="timeline">{d.events.map((e: any, i: number) => <li key={i}><strong>{e.action}</strong>{e.note && ` — ${e.note}`} <small>{fmtDateTime(e.at)}</small></li>)}</ul>
    {canManage && d.status !== 'closed' && <><div className="field"><label htmlFor="note">Note / reason</label><input id="note" value={note} onChange={(e) => setNote(e.target.value)} /></div>
      <div className="row"><Button variant="secondary" disabled={note.length < 3} onClick={call('note', { note }, 'Note added.')}>Add note</Button><Button variant="secondary" disabled={note.length < 3} onClick={call('escalate', { note }, 'Escalated.')}>Escalate</Button><Button disabled={note.length < 3} onClick={call('close', { note }, 'Incident closed.')}>Close with note</Button></div></>}
    {act.node}</>}</Async></Card>;
}

function Report({ onCreated }: { onCreated: () => void }) {
  const secs = useAsync(() => api<any[]>('/me/sections'));
  const prof = useSession();
  const [f, setF] = useState<any>({ category: 'safety', severity: 'medium' });
  const act = useAction();
  const campusId = prof.profile?.grants.find((g) => g.permission === 'incident.report')?.campusId;
  const campus = useAsync(() => api<any[]>('/hostels').then((h) => h[0]?.campus_id ?? null).catch(() => null));
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  void secs;
  return <Card title="Report an incident"><form onSubmit={async (e) => { e.preventDefault(); const cid = campusId ?? campus.data; if (await act.run(() => api('/incidents', { body: { campusId: cid, category: f.category, severity: f.severity, title: f.title, description: f.description } }), 'Incident reported.')) { setF({ category: 'safety', severity: 'medium' }); onCreated(); } }}>
    <div className="row"><Select label="Category" value={f.category} onChange={set('category')} options={['safety', 'discipline', 'medical', 'safeguarding', 'maintenance'].map((v) => ({ value: v, label: v }))} /><Select label="Severity" value={f.severity} onChange={set('severity')} options={['low', 'medium', 'high', 'critical'].map((v) => ({ value: v, label: v }))} /></div>
    <Input label="Title" value={f.title ?? ''} onChange={set('title')} required minLength={3} />
    <div className="field"><label htmlFor="desc">What happened</label><textarea id="desc" value={f.description ?? ''} onChange={set('description')} required minLength={3} /></div>
    <Button type="submit" busy={act.busy}>Submit report</Button>{act.node}</form></Card>;
}
