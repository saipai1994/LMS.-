'use client';
import { useState } from 'react';
import { api } from '@/lib/api';
import { useAsync, useSession } from '@/lib/hooks';
import { Async, Button, Card, Select, StatusBadge, Table, useAction } from '@/components/ui';

export default function Activities() {
  const s = useSession();
  const acts = useAsync(() => api<any[]>('/activities'));
  const kids = useAsync(() => (s.hasRole('parent') ? api<any[]>('/me/children') : Promise.resolve([])));
  const [kid, setKid] = useState('');
  const act = useAction();
  return <><h1>Sports, clubs & activities</h1><p className="sub">Registering a child records the guardian’s consent where an activity requires it.</p>
    {s.hasRole('parent') && <Card><Async q={kids} what="children">{(d) => <Select label="Register for" value={kid} onChange={(e) => setKid(e.target.value)} placeholder="Choose child…" options={d.map((k) => ({ value: k.id, label: `${k.first_name} ${k.last_name}` }))} />}</Async></Card>}
    <Card title="Activities">{act.node}<Async q={acts} what="activities" empty={(d) => !d.length}>{(d) => <Table cols={[{ key: 'name', label: 'Activity' }, { key: 'kind', label: 'Type' }, { key: 'coach', label: 'Coach' }, { key: 'registered', label: 'Places', render: (r) => `${r.registered}/${r.capacity}${r.waitlisted ? ` (+${r.waitlisted} waiting)` : ''}` },
      { key: 'a', label: '', render: (r) => (s.hasRole('parent') ? <Button small disabled={!kid} onClick={async () => { await act.run(() => api(`/activities/${r.id}/register`, { body: { studentId: kid } }), 'Registered — your consent has been recorded.'); acts.reload(); }}>Register</Button> : <StatusBadge s={r.registered >= r.capacity ? 'warn' : 'active'} />) }]} rows={d} />}</Async></Card></>;
}
