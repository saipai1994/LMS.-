'use client';
import { api, download, errText } from '@/lib/api';
import { useAsync, useSession } from '@/lib/hooks';
import { Alert, Async, Button, Card, StatusBadge, Table } from '@/components/ui';
import { useState } from 'react';

export default function Reports() {
  const s = useSession();
  const enr = useAsync(() => api<any[]>('/reports/enrollment').catch(() => []));
  const fun = useAsync(() => api<any>('/reports/admission-funnel').catch(() => null));
  const perf = useAsync(() => api<any[]>('/reports/academic-performance').catch(() => []));
  const [err, setErr] = useState<string | null>(null);
  const dl = (path: string, name: string) => async () => { setErr(null); try { await download(path, name); } catch (e) { setErr(errText(e)); } };
  const today = new Date().toISOString().slice(0, 10), from = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  return <><h1>Reports & analytics</h1><p className="sub">Figures are computed from stored records and limited to your campuses. Exports are written to the audit log.</p>
    {err && <Alert kind="error">{err}</Alert>}
    {s.can('reports.export') && <Card title="CSV exports"><div className="row" style={{ gap: '.5rem' }}>
      {s.can('student.read') && <Button variant="secondary" onClick={dl('/reports/students.csv', 'students.csv')}>Students</Button>}
      {s.can('finance.read') && <Button variant="secondary" onClick={dl('/reports/fees-outstanding.csv', 'fees-outstanding.csv')}>Outstanding fees</Button>}
      {s.can('attendance.read') && <Button variant="secondary" onClick={dl(`/reports/attendance.csv?from=${from}&to=${today}`, 'attendance.csv')}>Attendance (30 days)</Button>}</div></Card>}
    <div className="grid g2">
      <Card title="Admission funnel"><Async q={fun as any} what="funnel">{(d: any) => d ? <><p>{d.total} applications · offer rate {d.offerRatePercent}% · conversion {d.conversionPercent}%</p><Table cols={[{ key: 's', label: 'Stage', render: (r) => <StatusBadge s={r.s} /> }, { key: 'n', label: 'Applications' }]} rows={Object.entries(d.byStatus).map(([s, n]) => ({ s, n }))} /></> : <p className="sub">No access.</p>}</Async></Card>
      <Card title="Average results by grade and subject (approved marks)"><Async q={perf} what="results" empty={(d) => !d.length}>{(d) => <Table cols={[{ key: 'grade', label: 'Grade' }, { key: 'subject', label: 'Subject' }, { key: 'results', label: 'Results' }, { key: 'average_percent', label: 'Avg %' }]} rows={d} />}</Async></Card>
    </div>
    <Card title="Enrolment, capacity and residence"><Async q={enr} what="enrolment" empty={(d) => !d.length}>{(d) => <Table cols={[{ key: 'c', label: 'Class', render: (r) => `${r.grade} ${r.section}` }, { key: 'enrolled', label: 'Enrolled', render: (r) => `${r.enrolled}/${r.capacity}` }, { key: 'boarders', label: 'Boarders' }, { key: 'day_scholars', label: 'Day scholars' }]} rows={d} />}</Async></Card></>;
}
