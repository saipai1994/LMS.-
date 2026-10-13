'use client';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { api, fmtDate, fmtDateTime, money } from '@/lib/api';
import { useAsync, useSession } from '@/lib/hooks';
import { Async, Badge, Button, Card, Input, StatusBadge, Table, useAction } from '@/components/ui';

const TABS = ['Overview', 'Attendance', 'Learning', 'Report card', 'Fees'] as const;

export default function StudentPage() {
  const { id } = useParams<{ id: string }>();
  const [tab, setTab] = useState<(typeof TABS)[number]>('Overview');
  const ov = useAsync(() => api<any>(`/students/${id}/overview`), [id]);
  return <Async q={ov} what="student">{(d) => <>
    <h1>{d.student.firstName} {d.student.lastName}</h1>
    <p className="sub">{d.student.admissionNo} · <StatusBadge s={d.student.status} /> · {d.residence[0] ? <Badge tone="info">{d.residence[0].residence_type.replace('_', ' ')}</Badge> : null}</p>
    <div className="tabs" role="tablist">{TABS.map((t) => <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>{t}</button>)}</div>
    {tab === 'Overview' && <Overview d={d} id={id} onChange={ov.reload} />}
    {tab === 'Attendance' && <Attendance id={id} />}
    {tab === 'Learning' && <Learning id={id} />}
    {tab === 'Report card' && <ReportCard id={id} />}
    {tab === 'Fees' && <Fees id={id} />}
  </>}</Async>;
}

function Overview({ d, id, onChange }: { d: any; id: string; onChange: () => void }) {
  const s = useSession();
  const act = useAction();
  const [name, setName] = useState(''); const [rel, setRel] = useState('');
  const isGuardian = s.hasRole('parent');
  return <div className="grid g2">
    <Card title="Enrollment history"><Table cols={[{ key: 'grade', label: 'Class', render: (r) => `${r.grade} ${r.section}` }, { key: 'academic_year', label: 'Year' }, { key: 'effective_from', label: 'From', render: (r) => fmtDate(r.effective_from) }, { key: 'effective_to', label: 'To', render: (r) => (r.effective_to ? fmtDate(r.effective_to) : 'current') }]} rows={d.enrollments} /></Card>
    <Card title="Residence history"><Table cols={[{ key: 'residence_type', label: 'Status', render: (r) => r.residence_type.replace('_', ' ') }, { key: 'effective_from', label: 'From', render: (r) => fmtDate(r.effective_from) }, { key: 'effective_to', label: 'To', render: (r) => (r.effective_to ? fmtDate(r.effective_to) : 'current') }]} rows={d.residence} /></Card>
    <Card title="LMS courses"><Table cols={[{ key: 'title', label: 'Course' }, { key: 'subject', label: 'Subject' }]} rows={d.courses} empty="Not enrolled in any course." /></Card>
    <Card title="Guardians">{d.guardians.length ? <Table cols={[{ key: 'full_name', label: 'Name' }, { key: 'relationship', label: 'Relationship' }, { key: 'phone', label: 'Phone' }, { key: 'can_pickup', label: 'May collect', render: (r) => (r.can_pickup ? 'Yes' : 'No') }]} rows={d.guardians} /> : <p className="sub">Family details are not shown for your role.</p>}</Card>
    {d.medicalAlerts && <Card title="Medical alerts (restricted — access is audited)"><Table cols={[{ key: 'severity', label: 'Severity', render: (r) => <StatusBadge s={r.severity} /> }, { key: 'alert', label: 'Alert' }]} rows={d.medicalAlerts} empty="No alerts recorded." /></Card>}
    {isGuardian && <Card title="Authorised pickup persons">
      <p className="sub">People who may collect this child from school. Gate staff will check their ID.</p>
      <form onSubmit={async (e) => { e.preventDefault(); if (await act.run(() => api(`/students/${id}/authorized-pickups`, { body: { fullName: name, relationship: rel } }), 'Pickup person added.')) { setName(''); setRel(''); onChange(); } }}>
        <div className="row"><Input label="Full name" value={name} onChange={(e) => setName(e.target.value)} required /><Input label="Relationship" value={rel} onChange={(e) => setRel(e.target.value)} required /><Button type="submit" busy={act.busy}>Add</Button></div>
      </form>{act.node}</Card>}
  </div>;
}

function Attendance({ id }: { id: string }) {
  const q = useAsync(() => api<any>(`/students/${id}/attendance`), [id]);
  return <Card title="Attendance"><Async q={q} what="attendance">{(d) => <>
    <p><strong>{d.summary.percentage ?? '—'}%</strong> present over {d.summary.days} recorded days</p>
    <Table cols={[{ key: 'att_date', label: 'Date', render: (r) => fmtDate(r.att_date) }, { key: 'status', label: 'Status', render: (r) => <StatusBadge s={r.status} /> }, { key: 'reason', label: 'Reason' }]} rows={d.records.slice(0, 30)} empty="No attendance recorded yet." /></>}</Async></Card>;
}
function Learning({ id }: { id: string }) {
  const q = useAsync(() => api<any>(`/students/${id}/learning`), [id]);
  return <Card title="Homework & marks"><Async q={q} what="homework" empty={(d) => !d.assignments.length}>{(d) =>
    <Table cols={[{ key: 'course', label: 'Course' }, { key: 'title', label: 'Task' }, { key: 'due_at', label: 'Due', render: (r) => fmtDate(r.due_at) }, { key: 'status', label: 'Status', render: (r) => <StatusBadge s={r.missing ? 'missing' : r.status} /> }, { key: 'marks', label: 'Marks', render: (r) => (r.marks != null ? `${Number(r.marks)}/${Number(r.max_marks)}` : '—') }, { key: 'feedback', label: 'Feedback' }]} rows={d.assignments} />}</Async></Card>;
}
function ReportCard({ id }: { id: string }) {
  const q = useAsync(() => api<any>(`/students/${id}/report-card`), [id]);
  return <Card title="Report card (approved results only)"><Async q={q} what="report card">{(d) => d.items.length ? <>
    <p>Overall: <strong>{d.overallPercent}%</strong> — grade <strong>{d.overallGrade}</strong>{d.note && <small> ({d.note})</small>}</p>
    <Table cols={[{ key: 'subject', label: 'Subject' }, { key: 'assessment_name', label: 'Assessment' }, { key: 'marks', label: 'Marks', render: (r) => `${r.marks}/${r.max_marks}` }, { key: 'percent', label: '%' }, { key: 'grade', label: 'Grade' }]} rows={d.items} /></> : <p className="sub">No results have been approved and published yet.</p>}</Async></Card>;
}
function Fees({ id }: { id: string }) {
  const s = useSession();
  const led = useAsync(() => api<any>(`/finance/students/${id}/ledger`), [id]);
  const inv = useAsync(() => api<any[]>(s.can('finance.read') ? `/finance/invoices?studentId=${id}` : '/finance/me/invoices').then((r) => r.filter((x) => x.student_id === id)), [id]);
  const act = useAction();
  const [receipt, setReceipt] = useState<any>(null);
  async function payOnline(invoiceId: string) {
    await act.run(async () => {
      const intent = await api<any>('/finance/payment-intents', { body: { invoiceId } });
      const r = await api<any>(`/finance/payment-intents/${intent.id}/simulate`, { body: { outcome: 'succeeded' } });
      if (r.paymentId) setReceipt(await api(`/finance/payments/${r.paymentId}/receipt`));
      inv.reload(); led.reload();
    }, 'Simulated payment recorded.');
  }
  return <div className="grid g2">
    <Card title="Invoices"><Async q={inv} what="invoices" empty={(d) => !d.length}>{(d) => <Table cols={[{ key: 'number', label: 'Invoice' }, { key: 'due_date', label: 'Due', render: (r) => fmtDate(r.due_date) }, { key: 'total_minor', label: 'Total', align: 'right', render: (r) => money(r.total_minor) }, { key: 'outstanding_minor', label: 'Outstanding', align: 'right', render: (r) => money(r.outstanding_minor) }, { key: 'display_status', label: 'Status', render: (r) => <StatusBadge s={r.display_status} /> },
      { key: 'pay', label: '', render: (r) => (Number(r.outstanding_minor) > 0 && s.hasRole('parent') ? <Button small onClick={() => payOnline(r.id)} busy={act.busy}>Pay (demo)</Button> : null) }]} rows={d} />}</Async>
      <small>Online payment uses a <strong>Demo / Simulated</strong> gateway — no real money moves.</small>{act.node}
      {receipt && <div className="alert info">Receipt {receipt.receiptNo}: {money(receipt.amountMinor)} {receipt.notice && <strong> — {receipt.notice}</strong>}</div>}</Card>
    <Card title="Ledger"><Async q={led} what="ledger" empty={(d) => !d.entries.length}>{(d) => <><p>Balance due: <strong>{money(d.balanceMinor)}</strong></p>
      <Table cols={[{ key: 'entry_date', label: 'Date', render: (r) => fmtDate(r.entry_date) }, { key: 'description', label: 'Description' }, { key: 'debit_minor', label: 'Charge', align: 'right', render: (r) => (r.debit_minor ? money(r.debit_minor) : '') }, { key: 'credit_minor', label: 'Paid', align: 'right', render: (r) => (r.credit_minor ? money(r.credit_minor) : '') }, { key: 'balance_minor', label: 'Balance', align: 'right', render: (r) => money(r.balance_minor) }]} rows={d.entries} /></>}</Async></Card>
  </div>;
}
void fmtDateTime;
