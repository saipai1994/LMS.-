'use client';
import { useState } from 'react';
import { api, fmtDate, fmtDateTime } from '@/lib/api';
import { useAsync, useSession } from '@/lib/hooks';
import { Async, Badge, Button, Card, Select, Table, useAction } from '@/components/ui';

export default function Calendar() {
  const s = useSession();
  const ev = useAsync(() => api<any[]>(`/calendar?from=${new Date().toISOString().slice(0, 10)}`));
  const slots = useAsync(() => api<any[]>('/ptm/slots'));
  const kids = useAsync(() => (s.hasRole('parent') ? api<any[]>('/me/children') : Promise.resolve([])));
  const [kid, setKid] = useState('');
  const act = useAction();
  return <><h1>Calendar & meetings</h1>
    <Card title="Upcoming"><Async q={ev} what="events" empty={(d) => !d.length}>{(d) => <Table cols={[{ key: 'starts_on', label: 'When', render: (r) => (r.starts_on === r.ends_on ? fmtDate(r.starts_on) : `${fmtDate(r.starts_on)} – ${fmtDate(r.ends_on)}`) }, { key: 'title', label: 'Event' }, { key: 'kind', label: 'Type', render: (r) => <Badge tone={r.kind === 'holiday' || r.kind === 'vacation' ? 'info' : r.kind === 'deadline' ? 'warn' : 'neutral'}>{r.kind}</Badge> }]} rows={d} />}</Async></Card>
    <Card title="Parent–teacher meeting slots">{s.hasRole('parent') && <Async q={kids} what="children">{(d) => <Select label="Book for" value={kid} onChange={(e) => setKid(e.target.value)} placeholder="Choose child…" options={d.map((k) => ({ value: k.id, label: `${k.first_name} ${k.last_name}` }))} />}</Async>}
      {act.node}<Async q={slots} what="slots" empty={(d) => !d.length}>{(d) => <Table cols={[{ key: 'teacher', label: 'Teacher' }, { key: 'starts_at', label: 'Time', render: (r) => fmtDateTime(r.starts_at) }, { key: 'booked', label: 'Status', render: (r) => (r.mine ? <Badge tone="good">your booking</Badge> : r.booked ? <Badge>booked</Badge> : <Badge tone="info">free</Badge>) },
        { key: 'a', label: '', render: (r) => (s.hasRole('parent') ? r.mine ? <Button small variant="secondary" onClick={async () => { if (await act.run(() => api(`/ptm/slots/${r.id}/cancel`, { method: 'POST', body: {} }), 'Booking cancelled.')) slots.reload(); }}>Cancel</Button> : !r.booked ? <Button small disabled={!kid} onClick={async () => { if (await act.run(() => api(`/ptm/slots/${r.id}/book`, { body: { studentId: kid } }), 'Meeting booked; the teacher has been notified.')) slots.reload(); }}>Book</Button> : null : null) }]} rows={d} />}</Async></Card></>;
}
