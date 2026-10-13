'use client';
import { api, fmtDateTime } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { Async, Badge, Button, Card } from '@/components/ui';

export default function Notifications() {
  const q = useAsync(() => api<any[]>('/notifications'));
  return <><h1>Notifications</h1><p className="sub">In-app notifications only. Email, SMS and push are not configured in this build.</p>
    <Card><Async q={q} what="notifications" empty={(d) => !d.length}>{(d) => <ul className="timeline">{d.map((n) => (
      <li key={n.id}><strong>{n.title}</strong> {!n.read_at && <Badge tone="info">new</Badge>}<br />{n.body}<br /><small>{fmtDateTime(n.created_at)}</small>{' '}
        {!n.read_at && <Button small variant="secondary" onClick={async () => { await api(`/notifications/${n.id}/read`, { method: 'POST', body: {} }); q.reload(); }}>Mark read</Button>}</li>))}</ul>}</Async></Card></>;
}
