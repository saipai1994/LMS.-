'use client';
import { useState } from 'react';
import { api, fmtDateTime } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { Async, Button, Card, Input, Select, Stat, Table, useAction } from '@/components/ui';

export default function Security() {
  const onsite = useAsync(() => api<any[]>('/security/visitors/on-site'));
  const roster = useAsync(() => api<any>('/security/evacuation-roster'));
  const moves = useAsync(() => api<any[]>('/security/movements'));
  const campuses = useAsync(async () => (await api<any[]>('/sections'))[0]?.campus_id as string);
  const [f, setF] = useState<any>({ kind: 'visitor' });
  const act = useAction();
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  return <><h1>Campus security</h1><p className="sub">Visitor register, gate movements and evacuation accountability.</p>
    <Async q={roster} what="roster">{(d) => <div className="grid g4" style={{ marginBottom: '1rem' }}><Stat label="To account for in an evacuation" value={d.expectedHeadcount} hint="boarders on campus + uncollected day scholars + visitors" /><Stat label="Visitors on site" value={d.visitors.length} /></div>}</Async>
    <Card title="Visitors on site"><Async q={onsite} what="visitors" empty={(d) => !d.length}>{(d) => <Table cols={[{ key: 'badge_no', label: 'Badge' }, { key: 'full_name', label: 'Name' }, { key: 'kind', label: 'Type' }, { key: 'purpose', label: 'Purpose' }, { key: 'host', label: 'Host' }, { key: 'checked_in_at', label: 'In', render: (r) => fmtDateTime(r.checked_in_at) },
      { key: 'a', label: '', render: (r) => <Button small variant="secondary" onClick={async () => { if (await act.run(() => api(`/security/visitors/${r.id}/checkout`, { method: 'POST', body: {} }), 'Checked out.')) { onsite.reload(); roster.reload(); } }}>Check out</Button> }]} rows={d} />}</Async>{act.node}</Card>
    <Card title="Check in a visitor"><form onSubmit={async (e) => { e.preventDefault(); if (await act.run(() => api('/security/visitors', { body: { campusId: campuses.data, kind: f.kind, fullName: f.name, purpose: f.purpose, host: f.host, idType: f.idType, idLast4: f.idLast4, badgeNo: f.badge } }), 'Visitor checked in.')) { setF({ kind: 'visitor' }); onsite.reload(); roster.reload(); } }}>
      <div className="row"><Input label="Full name" value={f.name ?? ''} onChange={set('name')} required /><Select label="Type" value={f.kind} onChange={set('kind')} options={['visitor', 'contractor', 'vendor', 'guardian'].map((v) => ({ value: v, label: v }))} /><Input label="Badge no." value={f.badge ?? ''} onChange={set('badge')} required /></div>
      <div className="row"><Input label="Purpose" value={f.purpose ?? ''} onChange={set('purpose')} required /><Input label="Host" value={f.host ?? ''} onChange={set('host')} required /><Input label="ID type" value={f.idType ?? ''} onChange={set('idType')} required /><Input label="ID last 4" maxLength={4} pattern="[A-Za-z0-9]{4}" value={f.idLast4 ?? ''} onChange={set('idLast4')} required hint="Only the last 4 characters are stored." /></div>
      <Button type="submit" busy={act.busy}>Check in</Button></form></Card>
    <Card title="Recent student gate movements"><Async q={moves} what="movements" empty={(d) => !d.length}>{(d) => <Table cols={[{ key: 'at', label: 'Time', render: (r) => fmtDateTime(r.at) }, { key: 'n', label: 'Student', render: (r) => `${r.first_name} ${r.last_name}` }, { key: 'direction', label: 'Direction' }]} rows={d.slice(0, 15)} />}</Async></Card></>;
}
