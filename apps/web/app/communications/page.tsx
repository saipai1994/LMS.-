'use client';
import { useState } from 'react';
import { api, fmtDateTime } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { Alert, Async, Button, Card, Input, Select, StatusBadge, Table, useAction } from '@/components/ui';

export default function Communications() {
  const list = useAsync(() => api<any[]>('/announcements'));
  const [f, setF] = useState<any>({ audienceType: 'all', priority: 'normal', email: false, sms: false });
  const [sel, setSel] = useState<string | null>(null);
  const delivery = useAsync(() => (sel ? api<any>(`/announcements/${sel}/delivery`) : Promise.resolve(null)), [sel]);
  const act = useAction();
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  return <><h1>Communications</h1><p className="sub">In-app notifications are delivered. <strong>Email and SMS providers are not configured</strong>, so those channels are recorded as “not delivered” rather than pretending to send.</p>
    <Card title="New announcement"><form onSubmit={async (e) => { e.preventDefault(); const channels = ['in_app', ...(f.email ? ['email'] : []), ...(f.sms ? ['sms'] : [])]; if (await act.run(() => api('/announcements', { body: { title: f.title, body: f.body, audienceType: f.audienceType, priority: f.priority, channels, ...(f.when ? { scheduledFor: new Date(f.when).toISOString() } : {}) } }), f.when ? 'Announcement scheduled.' : 'Announcement sent in-app.')) { setF({ ...f, title: '', body: '', when: '' }); list.reload(); } }}>
      <div className="row"><Input label="Title" value={f.title ?? ''} onChange={set('title')} required minLength={3} /><Select label="Audience" value={f.audienceType} onChange={set('audienceType')} options={['all', 'staff', 'parents', 'students'].map((v) => ({ value: v, label: v }))} /><Select label="Priority" value={f.priority} onChange={set('priority')} options={[{ value: 'normal', label: 'Normal' }, { value: 'emergency', label: 'Emergency (ignores opt-outs, sent immediately)' }]} /></div>
      <div className="field"><label htmlFor="b">Message</label><textarea id="b" value={f.body ?? ''} onChange={set('body')} required minLength={3} /></div>
      <div className="row"><Input label="Schedule for (optional)" type="datetime-local" value={f.when ?? ''} onChange={set('when')} disabled={f.priority === 'emergency'} /><label><input type="checkbox" checked={f.email} onChange={set('email')} /> Also email (not configured)</label><label><input type="checkbox" checked={f.sms} onChange={set('sms')} /> Also SMS (not configured)</label></div>
      <Button type="submit" busy={act.busy}>Send</Button>{act.node}</form></Card>
    <Card title="History" action={<Button small variant="secondary" onClick={async () => { await act.run(() => api('/announcements/dispatch-due', { method: 'POST', body: {} }), 'Checked for due scheduled messages.'); list.reload(); }}>Send due scheduled</Button>}>
      <Async q={list} what="announcements" empty={(d) => !d.length}>{(d) => <Table cols={[{ key: 'title', label: 'Title' }, { key: 'audience_type', label: 'Audience' }, { key: 'priority', label: 'Priority', render: (r) => <StatusBadge s={r.priority === 'emergency' ? 'critical' : 'neutral'} /> }, { key: 'status', label: 'Status', render: (r) => <StatusBadge s={r.status} /> }, { key: 'recipients', label: 'Recipients' }, { key: 'sent_at', label: 'Sent', render: (r) => fmtDateTime(r.sent_at) },
        { key: 'a', label: '', render: (r) => <Button small variant="secondary" onClick={() => setSel(r.id)}>Delivery</Button> }]} rows={d} />}</Async>
      {sel && <Async q={delivery} what="delivery">{(d) => d && <div style={{ marginTop: '.75rem' }}><p>In-app: <strong>{d.inApp}</strong></p>{d.note && <Alert kind="error">{d.note}</Alert>}<Table cols={[{ key: 'channel', label: 'Channel' }, { key: 'status', label: 'Status', render: (r) => <StatusBadge s={r.status === 'not_configured' ? 'failed' : r.status} /> }, { key: 'n', label: 'Messages' }]} rows={d.external} empty="No external channels requested." /></div>}</Async>}</Card></>;
}
