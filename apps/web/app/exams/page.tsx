'use client';
import { useState } from 'react';
import { api, fmtDate } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { Async, Card, Select, StatusBadge, Table } from '@/components/ui';

export default function Exams() {
  const exams = useAsync(() => api<any[]>('/exams'));
  const [id, setId] = useState('');
  return <><h1>Examinations</h1><p className="sub">Schedules for your classes (or your children’s classes). Published results appear on the report card.</p>
    <Card><Async q={exams} what="exams" empty={(d) => !d.length}>{(d) => <Select label="Exam" value={id} onChange={(e) => setId(e.target.value)} placeholder="Choose…" options={d.map((x) => ({ value: x.id, label: `${x.name} (${fmtDate(x.starts_on)} – ${fmtDate(x.ends_on)})` }))} />}</Async></Card>
    {id && <Schedule id={id} />}</>;
}
function Schedule({ id }: { id: string }) {
  const q = useAsync(() => api<any[]>(`/exams/${id}/schedule`), [id]);
  return <Card title="Schedule"><Async q={q} what="schedule" empty={(d) => !d.length}>{(d) => <Table cols={[{ key: 'paper_date', label: 'Date', render: (r) => fmtDate(r.paper_date) }, { key: 'start_time', label: 'Start', render: (r) => r.start_time.slice(0, 5) }, { key: 'duration_min', label: 'Minutes' }, { key: 'course', label: 'Paper' }, { key: 'room', label: 'Room' }, { key: 'max_marks', label: 'Max', render: (r) => Number(r.max_marks) }, { key: 'status', label: 'Status', render: (r) => <StatusBadge s={r.status} /> }]} rows={d} />}</Async></Card>;
}
