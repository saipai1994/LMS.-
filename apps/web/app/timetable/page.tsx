'use client';
import { api } from '@/lib/api';
import { useAsync, useSession } from '@/lib/hooks';
import { Async, Card, Empty } from '@/components/ui';
import { useState } from 'react';
import { Select } from '@/components/ui';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export default function Timetable() {
  const s = useSession();
  const staff = s.can('academic.read') && !s.hasRole('teacher');
  const secs = useAsync(() => (staff ? api<any[]>('/sections') : Promise.resolve([])));
  const [sec, setSec] = useState('');
  const mine = useAsync(() => api<any[]>('/me/timetable'), []);
  const sel = useAsync(() => (sec ? api<any[]>(`/sections/${sec}/timetable`) : Promise.resolve(null)), [sec]);
  const cover = useAsync(() => api<any[]>('/me/cover').catch(() => []));
  return <><h1>Timetable</h1><p className="sub">Built with clash detection for teachers, rooms and classes.</p>
    {staff && <Card><Async q={secs} what="classes">{(d) => <Select label="Class" value={sec} onChange={(e) => setSec(e.target.value)} placeholder="Choose…" options={d.map((x) => ({ value: x.id, label: `${x.grade_name} ${x.name}` }))} />}</Async></Card>}
    <Card title={sec ? 'Class timetable' : 'My timetable'}><Async q={sec ? (sel as any) : mine} what="timetable">{(rows: any[] | null) => rows && rows.length ? <Grid rows={rows} /> : <Empty>No lessons scheduled.</Empty>}</Async></Card>
    <Card title="Cover duties assigned to me"><Async q={cover} what="cover" empty={(d) => !d.length}>{(d) => <ul className="timeline">{d.map((c, i) => <li key={i}><strong>{c.sub_date}</strong> — {c.period} ({c.start_time}): {c.course}</li>)}</ul>}</Async></Card></>;
}
function Grid({ rows }: { rows: any[] }) {
  const periods = [...new Map(rows.map((r) => [r.seq, `${r.period} ${r.start_time.slice(0, 5)}`])).entries()].sort((a, b) => a[0] - b[0]);
  return <div className="table-wrap" tabIndex={0} role="region" aria-label="Weekly timetable"><table><caption className="sr-only">Weekly timetable</caption>
    <thead><tr><th scope="col">Period</th>{DAYS.slice(0, 5).map((d) => <th key={d} scope="col">{d}</th>)}</tr></thead>
    <tbody>{periods.map(([seq, label]) => <tr key={seq}><th scope="row">{label}</th>{[1, 2, 3, 4, 5].map((d) => { const c = rows.find((r) => r.seq === seq && r.day_of_week === d); return <td key={d}>{c ? <><strong>{c.subject}</strong><br /><small>{c.teacher ?? ''}{c.section ? ` · ${c.grade} ${c.section}` : ''} {c.room ? `· ${c.room}` : ''}</small></> : '—'}</td>; })}</tr>)}</tbody></table></div>;
}
