'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { Async, Button, Card, Select, StatusBadge, Table, useAction } from '@/components/ui';

export default function Attendance() {
  const secs = useAsync(() => api<any[]>('/me/sections'));
  const [sectionId, setSectionId] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const roster = useAsync(() => (sectionId ? api<any[]>(`/sections/${sectionId}/attendance?date=${date}`) : Promise.resolve([])), [sectionId, date]);
  const [marks, setMarks] = useState<Record<string, string>>({});
  const act = useAction();
  useEffect(() => { setMarks(Object.fromEntries((roster.data ?? []).map((r) => [r.student_id, r.status ?? 'present']))); }, [roster.data]);
  async function save() {
    const entries = Object.entries(marks).map(([studentId, status]) => ({ studentId, status }));
    if (await act.run(() => api(`/sections/${sectionId}/attendance`, { body: { date, entries } }), 'Attendance saved. Parents of absent students were notified in-app.')) roster.reload();
  }
  const set = (v: string) => setMarks(Object.fromEntries(Object.keys(marks).map((k) => [k, v])));
  return <><h1>Attendance</h1><p className="sub">Mark the daily register. Records older than 24 hours need a correction request.</p>
    <Card><Async q={secs} what="classes" empty={(d) => !d.length}>{(d) => <div className="row">
      <Select label="Class" value={sectionId} onChange={(e) => setSectionId(e.target.value)} placeholder="Choose…" options={d.map((s) => ({ value: s.id, label: `${s.grade} ${s.name} (${s.students})` }))} />
      <div className="field"><label htmlFor="d">Date</label><input id="d" type="date" value={date} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setDate(e.target.value)} /></div></div>}</Async></Card>
    {sectionId && <Card title="Register" action={<span><Button small variant="secondary" onClick={() => set('present')}>All present</Button></span>}>
      <Async q={roster} what="register" empty={(d) => !d.length}>{(d) => <><Table cols={[{ key: 'admission_no', label: 'Adm. no.' }, { key: 'n', label: 'Student', render: (r) => `${r.first_name} ${r.last_name}` },
        { key: 'status', label: 'Status', render: (r) => <select aria-label={`Status for ${r.first_name} ${r.last_name}`} value={marks[r.student_id] ?? 'present'} onChange={(e) => setMarks({ ...marks, [r.student_id]: e.target.value })}>{['present', 'absent', 'late', 'excused'].map((v) => <option key={v}>{v}</option>)}</select> },
        { key: 's', label: 'Saved', render: (r) => (r.status ? <StatusBadge s={r.status} /> : '—') }]} rows={d} />
        <div style={{ marginTop: '.75rem' }}><Button onClick={save} busy={act.busy}>Save attendance</Button></div></>}</Async>{act.node}</Card>}
  </>;
}
