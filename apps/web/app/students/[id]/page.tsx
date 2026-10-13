'use client';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { api, errText, fmtDate, fmtDateTime, money, openDocument } from '@/lib/api';
import { useAsync, useSession } from '@/lib/hooks';
import { Async, Badge, Button, Card, Input, Select, StatusBadge, Table, useAction } from '@/components/ui';

const TABS = ['Overview', 'Attendance', 'Learning', 'Report card', 'Fees', 'Documents', 'Competencies', 'Activities', 'Transport', 'Library'] as const;

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
    {tab === 'Documents' && <Documents id={id} />}
    {tab === 'Competencies' && <Competencies id={id} />}
    {tab === 'Activities' && <ActivitiesTab id={id} />}
    {tab === 'Transport' && <TransportTab id={id} />}
    {tab === 'Library' && <LibraryTab id={id} />}
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
    {isGuardian && d.residence[0]?.residence_type === 'day_scholar' && <EarlyDismissal id={id} />}
    {isGuardian && d.student.status === 'active' && <Exit id={id} />}
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
    <Table cols={[{ key: 'subject', label: 'Subject' }, { key: 'assessment_name', label: 'Assessment' }, { key: 'marks', label: 'Marks', render: (r) => `${r.marks}/${r.max_marks}${r.revised ? ' (revised)' : ''}` }, { key: 'percent', label: '%' }, { key: 'grade', label: 'Grade' }]} rows={d.items} />
    <div style={{ marginTop: '.75rem' }}><Button variant="secondary" onClick={async () => { try { await openDocument(`/students/${id}/report-card.html`); } catch (e) { alert(errText(e)); } }}>Print report card</Button></div></> : <p className="sub">No results have been approved and published yet.</p>}</Async></Card>;
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

function Documents({ id }: { id: string }) {
  const q = useAsync(() => api<any[]>(`/students/${id}/documents`), [id]);
  return <Card title="Documents & certificates"><Async q={q} what="documents" empty={(d) => !d.length}>{(d) => <Table cols={[{ key: 'kind', label: 'Document' }, { key: 'reference', label: 'Reference' }, { key: 'expires_on', label: 'Expires', render: (r) => (r.expires_on ? <span style={{ color: r.expired ? 'var(--bad)' : undefined }}>{fmtDate(r.expires_on)}{r.expired ? ' · expired' : ''}</span> : '—') }, { key: 'verified', label: 'Verified', render: (r) => <StatusBadge s={r.verified ? 'approved' : 'pending'} /> }]} rows={d} />}</Async></Card>;
}
function Competencies({ id }: { id: string }) {
  const q = useAsync(() => api<any[]>(`/students/${id}/competencies`), [id]);
  const plans = useAsync(() => api<any[]>(`/students/${id}/learning-plans`), [id]);
  return <div className="grid g2"><Card title="Competency levels"><Async q={q} what="competencies" empty={(d) => !d.length}>{(d) => <Table cols={[{ key: 'subject', label: 'Subject' }, { key: 'code', label: 'Competency' }, { key: 'levelName', label: 'Level', render: (r) => <Badge tone={r.level >= 3 ? 'good' : r.level === 2 ? 'warn' : 'neutral'}>{r.levelName}</Badge> }, { key: 'evidence', label: 'Evidence' }]} rows={d} />}</Async></Card>
    <Card title="Support & enrichment plans"><Async q={plans} what="plans" empty={(d) => !d.length}>{(d) => <Table cols={[{ key: 'kind', label: 'Type' }, { key: 'course', label: 'Course' }, { key: 'goal', label: 'Goal' }, { key: 'status', label: 'Status', render: (r) => <StatusBadge s={r.status} /> }]} rows={d} />}</Async></Card></div>;
}
function ActivitiesTab({ id }: { id: string }) {
  const q = useAsync(() => api<any>(`/students/${id}/activities`), [id]);
  return <Card title="Activities & awards"><Async q={q} what="activities">{(d) => <><Table cols={[{ key: 'name', label: 'Activity' }, { key: 'kind', label: 'Type' }, { key: 'status', label: 'Status', render: (r) => <StatusBadge s={r.status === 'registered' ? 'active' : 'pending'} /> }]} rows={d.registrations} empty="Not registered for any activity." />
    <h3>Attendance</h3><Table cols={[{ key: 'name', label: 'Activity' }, { key: 'a', label: 'Sessions attended', render: (r) => `${r.attended}/${r.sessions}` }]} rows={d.attendance} empty="No sessions recorded." />
    <h3>Awards</h3><Table cols={[{ key: 'title', label: 'Award' }, { key: 'awarded_on', label: 'Date', render: (r) => fmtDate(r.awarded_on) }]} rows={d.awards} empty="No awards yet." /></>}</Async></Card>;
}
function TransportTab({ id }: { id: string }) {
  const q = useAsync(() => api<any>(`/transport/students/${id}`), [id]);
  return <Card title="School transport"><Async q={q} what="transport">{(d) => d.assignment ? <><dl className="kv"><dt>Route</dt><dd>{d.assignment.route}</dd><dt>Stop</dt><dd>{d.assignment.stop} (pickup {d.assignment.pickup_time?.slice(0, 5) ?? '—'})</dd><dt>Vehicle</dt><dd>{d.assignment.reg_no}</dd><dt>Driver</dt><dd>{d.assignment.driver} · {d.assignment.driver_phone}</dd><dt>Attendant</dt><dd>{d.assignment.attendant_name}</dd></dl>
    <h3>Today</h3><Table cols={[{ key: 'shift', label: 'Trip', render: (r) => (r.shift === 'am' ? 'Morning' : 'Afternoon') }, { key: 'status', label: 'Trip status', render: (r) => <StatusBadge s={r.status === 'completed' ? 'closed' : 'pending'} /> }, { key: 'events', label: 'Your child', render: (r) => (r.events ?? []).join(' → ') || 'not yet boarded' }]} rows={d.today} empty="No trips run yet today." /></> : <p className="sub">Not assigned to school transport.</p>}</Async></Card>;
}
function LibraryTab({ id }: { id: string }) {
  const q = useAsync(() => api<any>(`/library/students/${id}`), [id]);
  return <Card title="Library"><Async q={q} what="library">{(d) => <><Table cols={[{ key: 'title', label: 'Book' }, { key: 'due_on', label: 'Due', render: (r) => fmtDate(r.due_on) }, { key: 'returned_on', label: 'Returned', render: (r) => (r.returned_on ? fmtDate(r.returned_on) : r.overdue ? <StatusBadge s="overdue" /> : 'on loan') }, { key: 'fine_minor', label: 'Fine', align: 'right', render: (r) => (Number(r.fine_minor) ? `${money(r.fine_minor)}${r.fine_settled ? ' (paid)' : ''}` : '—') }]} rows={d.loans} empty="No loans." />
    {d.reservations.length > 0 && <><h3>Reservations</h3><Table cols={[{ key: 'title', label: 'Book' }, { key: 'status', label: 'Status', render: (r) => <StatusBadge s={r.status} /> }]} rows={d.reservations} /></>}</>}</Async></Card>;
}

function EarlyDismissal({ id }: { id: string }) {
  const [f, setF] = useState<any>({ date: new Date().toISOString().slice(0, 10), time: '13:00' }); const act = useAction();
  return <Card title="Request early dismissal"><form onSubmit={async (e) => { e.preventDefault(); await act.run(() => api('/dismissal/early-requests', { body: { studentId: id, forDate: f.date, pickupTime: f.time, reason: f.reason } }), 'Request sent to the class teacher.'); }}>
    <div className="row"><Input label="Date" type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} required /><Input label="Pickup time" type="time" value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} required /><Input label="Reason" value={f.reason ?? ''} onChange={(e) => setF({ ...f, reason: e.target.value })} required minLength={3} /><Button type="submit" busy={act.busy}>Send</Button></div>{act.node}</form></Card>;
}
function Exit({ id }: { id: string }) {
  const [f, setF] = useState<any>({ kind: 'transfer_out' }); const [open, setOpen] = useState(false); const act = useAction();
  return <Card title="Withdrawal or transfer">{!open ? <Button variant="secondary" onClick={() => setOpen(true)}>Request withdrawal or transfer…</Button> : <form onSubmit={async (e) => { e.preventDefault(); await act.run(() => api('/withdrawals', { body: { studentId: id, kind: f.kind, reason: f.reason, destinationSchool: f.dest || undefined, effectiveDate: f.date } }), 'Request submitted for approval. Fees and library dues must be cleared before completion.'); }}>
    <div className="row"><Select label="Type" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })} options={[{ value: 'transfer_out', label: 'Transfer to another school' }, { value: 'withdrawal', label: 'Withdrawal' }]} /><Input label="Last day" type="date" value={f.date ?? ''} onChange={(e) => setF({ ...f, date: e.target.value })} required /></div>
    <Input label="Reason" value={f.reason ?? ''} onChange={(e) => setF({ ...f, reason: e.target.value })} required minLength={5} /><Input label="New school (if any)" value={f.dest ?? ''} onChange={(e) => setF({ ...f, dest: e.target.value })} />
    <div className="row"><Button type="submit" busy={act.busy}>Submit</Button><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button></div>{act.node}</form>}</Card>;
}
