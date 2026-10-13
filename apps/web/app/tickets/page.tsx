'use client';
import { useState } from 'react';
import { api, fmtDateTime } from '@/lib/api';
import { useAsync, useSession } from '@/lib/hooks';
import { Async, Button, Card, Input, Select, StatusBadge, Table, useAction } from '@/components/ui';

export default function Tickets() {
  const s = useSession();
  const list = useAsync(() => api<any[]>('/tickets'));
  const [open, setOpen] = useState<string | null>(null);
  const [f, setF] = useState<any>({ category: 'request' });
  const act = useAction();
  return <><h1>Support & requests</h1><p className="sub">Requests and complaints with service-level deadlines.</p>
    <Card title="Open a request"><form onSubmit={async (e) => { e.preventDefault(); if (await act.run(() => api('/tickets', { body: { category: f.category, subject: f.subject, body: f.body } }), 'Request submitted.')) { setF({ category: 'request' }); list.reload(); } }}>
      <div className="row"><Select label="Category" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} options={['request', 'complaint', 'fees', 'academic', 'transport', 'hostel', 'other'].map((v) => ({ value: v, label: v }))} /><Input label="Subject" value={f.subject ?? ''} onChange={(e) => setF({ ...f, subject: e.target.value })} required minLength={3} /></div>
      <div className="field"><label htmlFor="tb">Details</label><textarea id="tb" value={f.body ?? ''} onChange={(e) => setF({ ...f, body: e.target.value })} required minLength={3} /></div><Button type="submit" busy={act.busy}>Submit</Button>{act.node}</form></Card>
    <Card title={s.can('tickets.manage') ? 'All requests' : 'My requests'}><Async q={list} what="requests" empty={(d) => !d.length}>{(d) => <Table cols={[{ key: 'subject', label: 'Subject' }, { key: 'category', label: 'Category' }, { key: 'requester', label: 'From' }, { key: 'status', label: 'Status', render: (r) => <StatusBadge s={r.status} /> }, { key: 'sla_due_at', label: 'Respond by', render: (r) => <span style={{ color: r.sla_breached ? 'var(--bad)' : undefined }}>{fmtDateTime(r.sla_due_at)}{r.sla_breached ? ' · SLA breached' : ''}</span> }, { key: 'a', label: '', render: (r) => <Button small variant="secondary" onClick={() => setOpen(r.id)}>Open</Button> }]} rows={d} />}</Async></Card>
    {open && <Thread id={open} onChange={list.reload} />}</>;
}
function Thread({ id, onChange }: { id: string; onChange: () => void }) {
  const s = useSession();
  const q = useAsync(() => api<any>(`/tickets/${id}`), [id]);
  const [body, setBody] = useState(''); const [internal, setInternal] = useState(false);
  const act = useAction();
  return <Card title="Conversation"><Async q={q} what="ticket">{(t) => <>
    <h3>{t.subject} <StatusBadge s={t.status} /></h3><p>{t.body}</p>
    <ul className="timeline">{t.comments.map((c: any, i: number) => <li key={i}><strong>{c.author}</strong>{c.internal && ' (internal note)'}: {c.body} <small>{fmtDateTime(c.at)}</small></li>)}</ul>
    <form onSubmit={async (e) => { e.preventDefault(); if (await act.run(() => api(`/tickets/${id}/comments`, { body: { body, internal } }), 'Reply added.')) { setBody(''); q.reload(); onChange(); } }}>
      <Input label="Reply" value={body} onChange={(e) => setBody(e.target.value)} required />{s.can('tickets.manage') && <label><input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} /> Internal note (hidden from requester)</label>}
      <div className="row" style={{ marginTop: '.5rem' }}><Button type="submit" busy={act.busy}>Send</Button>{s.can('tickets.manage') && t.status !== 'resolved' && <Button variant="secondary" onClick={async () => { if (await act.run(() => api(`/tickets/${id}/status`, { body: { status: 'resolved' } }), 'Marked resolved.')) { q.reload(); onChange(); } }}>Resolve</Button>}</div>{act.node}</form></>}</Async></Card>;
}
