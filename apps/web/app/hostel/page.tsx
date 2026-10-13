'use client';
import { FormEvent, useState } from 'react';
import { api, fmtDateTime } from '@/lib/api';
import { useAsync, useSession } from '@/lib/hooks';
import { Async, Button, Card, Input, Select, Stat, StatusBadge, Table, useAction } from '@/components/ui';

export default function Hostel() {
  const s = useSession();
  const staff = s.can('hostel.read');
  const leave = useAsync(() => api<any[]>('/leave-requests'));
  const status = useAsync(() => (staff ? api<any>('/hostel/status') : Promise.resolve(null)));
  const act = useAction();
  const refresh = () => { leave.reload(); status.reload(); };
  const decide = (id: string, decision: string) => async () => { if (await act.run(() => api(`/leave-requests/${id}/decision`, { body: { decision } }), `Request ${decision}d.`)) refresh(); };
  const gate = (id: string, dir: 'gate-out' | 'gate-in') => async () => { if (await act.run(() => api(`/leave-requests/${id}/${dir}`, { method: 'POST', body: {} }), dir === 'gate-out' ? 'Gate-out recorded.' : 'Gate-in recorded.')) refresh(); };
  const cancel = (id: string) => async () => { if (await act.run(() => api(`/leave-requests/${id}/cancel`, { method: 'POST', body: {} }), 'Request cancelled.')) refresh(); };
  return <>
    <h1>{staff ? 'Hostel desk' : 'Leave requests'}</h1>
    <p className="sub">{staff ? 'Who is on campus, on approved leave or overdue — from the gate register.' : 'Request leave for your boarding child and track approval.'}</p>
    {staff && <Async q={status} what="hostel status">{(d) => d && <>
      <div className="grid g4" style={{ marginBottom: '1rem' }}><Stat label="On campus" value={d.summary.on_campus} tone="good" /><Stat label="On approved leave" value={d.summary.on_leave} tone="warn" /><Stat label="Overdue" value={d.summary.overdue} tone={d.summary.overdue ? 'bad' : 'good'} /></div>
      <Card title="Boarders off campus"><Table cols={[{ key: 'n', label: 'Student', render: (r) => `${r.first_name} ${r.last_name}` }, { key: 'hostel', label: 'Hostel' }, { key: 'room', label: 'Room' }, { key: 'presence', label: 'Status', render: (r) => <StatusBadge s={r.presence} /> }, { key: 'expected_return_at', label: 'Expected back', render: (r) => fmtDateTime(r.expected_return_at) }]}
        rows={d.students.filter((x: any) => x.presence !== 'on_campus')} empty="Everyone is on campus." /></Card></>}</Async>}
    <Card title="Leave requests">{act.node}
      <Async q={leave} what="leave requests" empty={(d) => !d.length}>{(d) => <Table cols={[
        { key: 'n', label: 'Student', render: (r) => `${r.first_name} ${r.last_name}` }, { key: 'leave_type', label: 'Type' }, { key: 'destination', label: 'Destination' }, { key: 'depart_at', label: 'Departs', render: (r) => fmtDateTime(r.depart_at) }, { key: 'expected_return_at', label: 'Return by', render: (r) => fmtDateTime(r.expected_return_at) },
        { key: 'status', label: 'Status', render: (r) => <StatusBadge s={r.overdue ? 'overdue' : r.status} /> },
        { key: 'a', label: 'Actions', render: (r) => <span className="row" style={{ gap: '.3rem' }}>
          {s.can('leave.approve') && r.status === 'requested' && <><Button small onClick={decide(r.id, 'approve')}>Approve</Button><Button small variant="danger" onClick={decide(r.id, 'reject')}>Reject</Button></>}
          {s.can('gate.record') && r.status === 'approved' && <Button small onClick={gate(r.id, 'gate-out')}>Gate out</Button>}
          {s.can('gate.record') && r.status === 'out' && <Button small onClick={gate(r.id, 'gate-in')}>Gate in</Button>}
          {['requested', 'approved'].includes(r.status) && <Button small variant="secondary" onClick={cancel(r.id)}>Cancel</Button>}</span> },
      ]} rows={d} />}</Async></Card>
    {s.hasRole('parent') && <NewLeave onCreated={refresh} />}
    {s.can('rollcall.record') && <RollCall />}
    {s.can('hostel.manage') && <Allocate />}
  </>;
}

function NewLeave({ onCreated }: { onCreated: () => void }) {
  const kids = useAsync(() => api<any[]>('/me/children'));
  const [f, setF] = useState<any>({ leaveType: 'weekend' });
  const act = useAction();
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (await act.run(() => api('/leave-requests', { body: { studentId: f.studentId, leaveType: f.leaveType, destination: f.destination, responsibleAdult: f.adult, departAt: new Date(f.depart).toISOString(), expectedReturnAt: new Date(f.back).toISOString() } }), 'Leave request sent to the warden.')) onCreated();
  }
  return <Card title="Request leave for a boarder"><Async q={kids} what="children" empty={(d) => !d.length}>{(d) => <form onSubmit={submit}>
    <div className="row"><Select label="Child" value={f.studentId ?? ''} onChange={set('studentId')} required placeholder="Choose…" options={d.map((k) => ({ value: k.id, label: `${k.first_name} ${k.last_name}` }))} />
      <Select label="Type" value={f.leaveType} onChange={set('leaveType')} options={['weekend', 'home_visit', 'overnight', 'outing', 'emergency'].map((v) => ({ value: v, label: v.replace('_', ' ') }))} /></div>
    <div className="row"><Input label="Destination" value={f.destination ?? ''} onChange={set('destination')} required /><Input label="Responsible adult" value={f.adult ?? ''} onChange={set('adult')} required /></div>
    <div className="row"><Input label="Departs" type="datetime-local" value={f.depart ?? ''} onChange={set('depart')} required /><Input label="Return by" type="datetime-local" value={f.back ?? ''} onChange={set('back')} required /><Button type="submit" busy={act.busy}>Send request</Button></div>{act.node}</form>}</Async></Card>;
}

function RollCall() {
  const hostels = useAsync(() => api<any[]>('/hostels'));
  const [hostelId, setHostelId] = useState('');
  const [session, setSession] = useState('bedtime');
  const rooms = useAsync(() => (hostelId ? api<any[]>(`/hostels/${hostelId}/rooms`) : Promise.resolve([])), [hostelId]);
  const [absent, setAbsent] = useState<Record<string, boolean>>({});
  const act = useAction();
  const [result, setResult] = useState<any>(null);
  const residents = (rooms.data ?? []).filter((r) => r.student_id);
  async function submit() {
    const entries = residents.map((r) => ({ studentId: r.student_id, status: absent[r.student_id] ? 'absent' : 'present' }));
    await act.run(async () => { setResult(await api(`/hostels/${hostelId}/roll-calls`, { body: { session, date: new Date().toISOString().slice(0, 10), entries } })); }, 'Roll call recorded.');
  }
  return <Card title="Roll call"><Async q={hostels} what="hostels">{(h) => <>
    <div className="row"><Select label="Hostel" value={hostelId} onChange={(e) => { setHostelId(e.target.value); setAbsent({}); setResult(null); }} placeholder="Choose…" options={h.map((x) => ({ value: x.id, label: `${x.name} (${x.occupied} residents)` }))} />
      <Select label="Session" value={session} onChange={(e) => setSession(e.target.value)} options={['morning', 'evening', 'bedtime'].map((v) => ({ value: v, label: v }))} /></div>
    {hostelId && <><p className="sub">Tick students who are <strong>not</strong> present. Students on approved leave who have not returned must be marked absent/on-leave per the gate register; unaccounted absences open a critical incident.</p>
      <Table cols={[{ key: 'room', label: 'Room', render: (r) => `${r.number}${r.label}` }, { key: 'n', label: 'Student', render: (r) => `${r.first_name} ${r.last_name}` }, { key: 'a', label: 'Not present', render: (r) => <input type="checkbox" aria-label={`${r.first_name} not present`} checked={!!absent[r.student_id]} onChange={(e) => setAbsent({ ...absent, [r.student_id]: e.target.checked })} /> }]} rows={residents} empty="No residents allocated." />
      <Button onClick={submit} busy={act.busy} disabled={!residents.length}>Submit roll call</Button></>}
    {act.node}{result && (result.unaccounted.length || result.conflicts.length) ? <div className="alert error" role="alert">{result.unaccounted.length} unaccounted-for student(s) — incident(s) opened. {result.conflicts.length} conflict(s) with the gate register.</div> : null}</>}</Async></Card>;
}

function Allocate() {
  const students = useAsync(() => api<any[]>('/students?limit=200'));
  const [hostelId, setHostelId] = useState(''); const [studentId, setStudentId] = useState(''); const [bedId, setBedId] = useState('');
  const hostels = useAsync(() => api<any[]>('/hostels'));
  const rooms = useAsync(() => (hostelId ? api<any[]>(`/hostels/${hostelId}/rooms`) : Promise.resolve([])), [hostelId]);
  const act = useAction();
  return <Card title="Allocate or transfer a bed"><Async q={students} what="students">{(st) => <form onSubmit={async (e) => { e.preventDefault(); if (await act.run(() => api('/hostel/allocations', { body: { studentId, bedId, effectiveFrom: new Date().toISOString().slice(0, 10) } }), 'Bed allocated.')) { rooms.reload(); hostels.reload(); } }}>
    <div className="row"><Select label="Student" value={studentId} onChange={(e) => setStudentId(e.target.value)} required placeholder="Choose…" options={st.map((x) => ({ value: x.id, label: `${x.admission_no} ${x.first_name} ${x.last_name}` }))} />
      <Select label="Hostel" value={hostelId} onChange={(e) => setHostelId(e.target.value)} required placeholder="Choose…" options={(hostels.data ?? []).map((h) => ({ value: h.id, label: `${h.name} — ${h.vacant} vacant` }))} />
      <Select label="Free bed" value={bedId} onChange={(e) => setBedId(e.target.value)} required placeholder="Choose…" options={(rooms.data ?? []).filter((r) => !r.student_id && !r.out_of_service).map((r) => ({ value: r.bed_id, label: `Room ${r.number} bed ${r.label}` }))} />
      <Button type="submit" busy={act.busy}>Allocate</Button></div>{act.node}</form>}</Async></Card>;
}
