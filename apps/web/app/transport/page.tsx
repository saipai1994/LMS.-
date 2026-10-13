'use client';
import { useState } from 'react';
import { api, fmtDate } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { Alert, Async, Button, Card, Select, Stat, StatusBadge, Table, useAction } from '@/components/ui';

export default function Transport() {
  const routes = useAsync(() => api<any[]>('/transport/routes'));
  const alerts = useAsync(() => api<any[]>('/transport/alerts?days=45'));
  const [routeId, setRouteId] = useState('');
  const [shift, setShift] = useState('am');
  const [trip, setTrip] = useState<string | null>(null);
  const act = useAction();
  const manifest = useAsync(() => (trip ? api<any>(`/transport/trips/${trip}`) : Promise.resolve(null)), [trip]);
  const loc = useAsync(() => (trip ? api<any>(`/transport/trips/${trip}/location`) : Promise.resolve(null)), [trip]);
  const today = new Date().toISOString().slice(0, 10);
  async function start() {
    await act.run(async () => {
      try { const t = await api<any>('/transport/trips', { body: { routeId, date: today, shift } }); setTrip(t.id); }
      catch (e: any) { if (e?.body?.tripId) setTrip(e.body.tripId); else throw e; }
    }, 'Trip opened.');
  }
  const mark = (studentId: string, event: string) => async () => { if (await act.run(() => api(`/transport/trips/${trip}/events`, { body: { studentId, event } }), `Recorded ${event}; guardian notified.`)) manifest.reload(); };
  return <><h1>Transport</h1><p className="sub">Routes, vehicles and document expiry. Live location is a <strong>Demo / Simulated</strong> provider — no GPS device is connected.</p>
    <Async q={routes} what="routes">{(d) => <div className="grid g4" style={{ marginBottom: '1rem' }}><Stat label="Routes" value={d.length} /><Stat label="Students riding" value={d.reduce((t, r) => t + r.riders, 0)} /><Stat label="Avg utilisation" value={`${Math.round(d.reduce((t, r) => t + (r.utilizationPercent ?? 0), 0) / Math.max(d.length, 1))}%`} /></div>}</Async>
    <Card title="Routes"><Async q={routes} what="routes" empty={(d) => !d.length}>{(d) => <Table cols={[{ key: 'name', label: 'Route' }, { key: 'reg_no', label: 'Vehicle' }, { key: 'driver', label: 'Driver' }, { key: 'attendant_name', label: 'Attendant' }, { key: 'riders', label: 'Riders', render: (r) => `${r.riders}/${r.capacity}` }, { key: 'utilizationPercent', label: 'Utilisation', render: (r) => `${r.utilizationPercent}%` }]} rows={d} />}</Async></Card>
    <Card title="Document & licence alerts (next 45 days)"><Async q={alerts} what="alerts" empty={(d) => !d.length}>{(d) => <Table cols={[{ key: 'kind', label: 'Type' }, { key: 'subject', label: 'Vehicle / driver' }, { key: 'doc', label: 'Document' }, { key: 'expires_on', label: 'Expires', render: (r) => fmtDate(r.expires_on) }, { key: 'expired', label: 'Status', render: (r) => <StatusBadge s={r.expired ? 'overdue' : 'pending'} /> }]} rows={d} />}</Async></Card>
    <Card title="Run a trip (boarding / drop-off confirmation)"><Async q={routes} what="routes">{(d) => <div className="row"><Select label="Route" value={routeId} onChange={(e) => setRouteId(e.target.value)} placeholder="Choose…" options={d.map((r) => ({ value: r.id, label: r.name }))} /><Select label="Shift" value={shift} onChange={(e) => setShift(e.target.value)} options={[{ value: 'am', label: 'Morning' }, { value: 'pm', label: 'Afternoon' }]} /><Button onClick={start} busy={act.busy} disabled={!routeId}>Open trip</Button></div>}</Async>{act.node}
      {trip && <Async q={manifest} what="manifest">{(m) => m && <><h3>Manifest — {m.trip.shift.toUpperCase()} · {m.trip.status}</h3>
        {loc.data && <Alert kind="info">{loc.data.notice}. Nearest stop: {loc.data.nearestStop}.</Alert>}
        <Table cols={[{ key: 'stop', label: 'Stop' }, { key: 'n', label: 'Student', render: (r) => `${r.first_name} ${r.last_name}` }, { key: 'boarded', label: 'Boarded', render: (r) => (r.boarded ? '✔' : '—') }, { key: 'dropped', label: 'Dropped', render: (r) => (r.dropped ? '✔' : '—') },
          { key: 'a', label: '', render: (r) => (m.trip.status === 'in_progress' ? <span className="row" style={{ gap: '.3rem' }}>{!r.boarded && <Button small onClick={mark(r.student_id, 'boarded')}>Boarded</Button>}{r.boarded && !r.dropped && <Button small variant="secondary" onClick={mark(r.student_id, 'dropped')}>Dropped</Button>}</span> : null) }]} rows={m.riders} />
        {m.trip.status === 'in_progress' && <div style={{ marginTop: '.75rem' }}><Button onClick={async () => { if (await act.run(() => api(`/transport/trips/${trip}/complete`, { method: 'POST', body: {} }), 'Trip completed.')) manifest.reload(); }}>Complete trip</Button></div>}</>}</Async>}</Card></>;
}
