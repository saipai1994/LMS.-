'use client';
import Link from 'next/link';
import { useState } from 'react';
import { api, fmtDate, fmtDateTime, money, setToken } from '@/lib/api';
import { useAsync, useSession } from '@/lib/hooks';
import { Async, BarSpark, Button, Card, Empty, Stat, StatusBadge, Table, useAction } from './ui';

export function Dashboard() {
  const s = useSession();
  const r = s.profile!.roles;
  const has = (...k: string[]) => k.some((x) => r.includes(x));
  return (
    <>
      <h1>Welcome, {s.profile!.fullName.split(' ')[0]}</h1>
      <p className="sub">{r.map((x) => x.replace(/_/g, ' ')).join(' · ')}</p>
      {has('group_admin', 'campus_admin', 'principal', 'auditor') ? <Principal />
        : has('parent') ? <Parent />
        : has('student') ? <StudentDash />
        : has('teacher') ? <Teacher />
        : has('warden') ? <Warden />
        : has('accountant') ? <Accountant />
        : has('admissions_officer') ? <Admissions />
        : has('security_staff') ? <Gate />
        : has('nurse') ? <Nurse /> : has('transport') ? <TransportDash /> : has('librarian') ? <LibrarianDash /> : has('inventory_manager') ? <InventoryDash /> : has('hr_payroll') ? <HrDash /> : has('kitchen_manager') ? <KitchenDash /> : <Generic />}
      <Notices />
      {s.can('tenant.manage') && <DemoReset />}
    </>
  );
}

function Notices() {
  const q = useAsync(() => api<any[]>('/notifications'));
  return <Card title="Recent notifications" action={<Link href="/notifications">View all</Link>}>
    <Async q={q} what="notifications" empty={(d) => !d.length}>{(d) => <ul className="timeline">{d.slice(0, 4).map((n) => <li key={n.id}><strong>{n.title}</strong> — {n.body} <small>({fmtDateTime(n.created_at)})</small></li>)}</ul>}</Async>
  </Card>;
}
const Generic = () => <Card title="Your workspace"><Empty>Use the menu to open the modules available to your role.</Empty></Card>;

function Principal() {
  const q = useAsync(() => api<any>('/dashboard/principal'));
  const fin = useAsync(() => api<any>('/finance/summary').catch(() => null));
  return <Async q={q} what="school overview">{(d) => (
    <>
      <div className="grid g4" style={{ marginBottom: '1rem' }}>
        {d.students !== undefined && <><Stat label="Active students" value={d.students} /><Stat label="Boarders" value={d.boarders} /><Stat label="Day scholars" value={d.dayScholars} /></>}
        {d.hostel && <Stat label="Overdue returns" value={d.hostel.overdue} tone={d.hostel.overdue ? 'bad' : 'good'} />}
      </div>
      <div className="grid g2">
        {d.attendanceTrend && <Card title="Attendance — last school days (%)"><BarSpark values={d.attendanceTrend.map((x: any) => x.percent)} labels={d.attendanceTrend.map((x: any) => fmtDate(x.date))} />
          <small>Latest: {d.attendanceTrend.at(-1)?.percent}%</small></Card>}
        {d.hostel && <Card title="Boarders right now"><div className="grid g4"><Stat label="On campus" value={d.hostel.on_campus} tone="good" /><Stat label="On approved leave" value={d.hostel.on_leave} tone="warn" /><Stat label="Overdue" value={d.hostel.overdue} tone={d.hostel.overdue ? 'bad' : 'good'} /></div></Card>}
        {fin.data && <Card title="Fees" action={<Link href="/finance">Details</Link>}>
          <div className="grid g4"><Stat label="Invoiced" value={money(fin.data.invoiced)} /><Stat label="Collected" value={money(fin.data.collected)} tone="good" /><Stat label="Outstanding" value={money(fin.data.outstanding)} tone="warn" /><Stat label="Overdue invoices" value={fin.data.overdue_invoices} tone={fin.data.overdue_invoices ? 'bad' : 'good'} /></div></Card>}
        {d.openIncidents && <Card title="Open incidents" action={<Link href="/incidents">Manage</Link>}>
          <Table cols={[{ key: 'category', label: 'Category', render: (r) => r.category.replace('_', ' ') }, { key: 'severity', label: 'Severity', render: (r) => <StatusBadge s={r.severity} /> }, { key: 'n', label: 'Open' }]} rows={d.openIncidents} empty="No open incidents." /></Card>}
        {d.admissions && <Card title="Admissions pipeline" action={<Link href="/admissions">Open</Link>}><Table cols={[{ key: 'status', label: 'Stage', render: (r) => <StatusBadge s={r.status} /> }, { key: 'n', label: 'Applications' }]} rows={d.admissions} /></Card>}
      </div>
    </>)}</Async>;
}

function Parent() {
  const kids = useAsync(() => api<any[]>('/me/children'));
  return <Async q={kids} what="your children" empty={(d) => !d.length}>{(d) => <div className="grid g2">{d.map((k) => <Child key={k.id} k={k} />)}</div>}</Async>;
}
function Child({ k }: { k: any }) {
  const att = useAsync(() => api<any>(`/students/${k.id}/attendance`));
  const learn = useAsync(() => api<any>(`/students/${k.id}/learning`));
  const led = useAsync(() => api<any>(`/finance/students/${k.id}/ledger`));
  return <Card title={`${k.first_name} ${k.last_name}`} action={<Link href={`/students/${k.id}`}>Open profile</Link>}>
    <div className="grid g4">
      <Stat label="Attendance" value={att.data?.summary.percentage != null ? `${att.data.summary.percentage}%` : '—'} tone={att.data?.summary.percentage < 90 ? 'warn' : 'good'} />
      <Stat label="Missing homework" value={learn.data?.missing ?? '—'} tone={learn.data?.missing ? 'bad' : 'good'} />
      <Stat label="Fees due" value={led.data ? money(led.data.balanceMinor) : '—'} tone={led.data?.balanceMinor > 0 ? 'warn' : 'good'} />
    </div>
    <h3>Upcoming homework</h3>
    <Async q={learn} what="homework" empty={(d) => !d.assignments.length}>{(d) => <Table cols={[{ key: 'course', label: 'Course' }, { key: 'title', label: 'Task' }, { key: 'due_at', label: 'Due', render: (r) => fmtDate(r.due_at) }, { key: 'status', label: 'Status', render: (r) => <StatusBadge s={r.missing ? 'missing' : r.status} /> }]}
      rows={d.assignments.filter((a: any) => a.status !== 'graded').slice(0, 5)} empty="Nothing pending." />}</Async>
  </Card>;
}

function StudentDash() {
  const q = useAsync(() => api<any>('/me/learning'));
  const courses = useAsync(() => api<any[]>('/me/courses'));
  return <div className="grid g2">
    <Card title="My homework" action={<Link href="/learning">Open learning</Link>}><Async q={q} what="homework" empty={(d) => !d.assignments.length}>{(d) => <Table cols={[{ key: 'course', label: 'Course' }, { key: 'title', label: 'Task' }, { key: 'due_at', label: 'Due', render: (r) => fmtDate(r.due_at) }, { key: 'status', label: 'Status', render: (r) => <StatusBadge s={r.missing ? 'missing' : r.status} /> }, { key: 'marks', label: 'Marks', render: (r) => (r.marks != null ? `${Number(r.marks)}/${Number(r.max_marks)}` : '—') }]} rows={d.assignments.slice(0, 8)} />}</Async></Card>
    <Card title="My courses"><Async q={courses} what="courses" empty={(d) => !d.length}>{(d) => <Table cols={[{ key: 'title', label: 'Course' }, { key: 'subject', label: 'Subject' }]} rows={d} />}</Async></Card>
  </div>;
}

function Teacher() {
  const courses = useAsync(() => api<any[]>('/me/courses'));
  const secs = useAsync(() => api<any[]>('/me/sections'));
  return <div className="grid g2">
    <Card title="Today's attendance" action={<Link href="/attendance">Mark</Link>}><Async q={secs} what="classes" empty={(d) => !d.length}>{(d) => <Table cols={[{ key: 'name', label: 'Class', render: (r) => `${r.grade} ${r.name}` }, { key: 'students', label: 'Students' }, { key: 'marked_today', label: 'Status', render: (r) => <StatusBadge s={r.marked_today ? 'present' : 'pending'} /> }]} rows={d} />}</Async></Card>
    <Card title="My courses" action={<Link href="/learning">Assignments & grading</Link>}><Async q={courses} what="courses" empty={(d) => !d.length}>{(d) => <Table cols={[{ key: 'title', label: 'Course' }, { key: 'students', label: 'Students' }]} rows={d.filter((c: any) => c.teaching).slice(0, 8)} />}</Async></Card>
  </div>;
}

function Warden() {
  const st = useAsync(() => api<any>('/hostel/status'));
  const leave = useAsync(() => api<any[]>('/leave-requests'));
  return <>
    <Async q={st} what="hostel status">{(d) => <>
      <div className="grid g4" style={{ marginBottom: '1rem' }}><Stat label="On campus" value={d.summary.on_campus} tone="good" /><Stat label="On approved leave" value={d.summary.on_leave} tone="warn" /><Stat label="Overdue returns" value={d.summary.overdue} tone={d.summary.overdue ? 'bad' : 'good'} /></div>
      {d.summary.overdue > 0 && <Card title="Overdue returns — action needed"><Table cols={[{ key: 'name', label: 'Student', render: (r) => `${r.first_name} ${r.last_name}` }, { key: 'hostel', label: 'Hostel' }, { key: 'expected_return_at', label: 'Was due', render: (r) => fmtDateTime(r.expected_return_at) }]} rows={d.students.filter((x: any) => x.presence === 'overdue')} /></Card>}
    </>}</Async>
    <Card title="Leave requests awaiting decision" action={<Link href="/hostel">Open hostel desk</Link>}><Async q={leave} what="leave requests">{(d) => <Table cols={[{ key: 'name', label: 'Student', render: (r) => `${r.first_name} ${r.last_name}` }, { key: 'leave_type', label: 'Type' }, { key: 'depart_at', label: 'Departs', render: (r) => fmtDateTime(r.depart_at) }]} rows={d.filter((x) => x.status === 'requested')} empty="No pending requests." />}</Async></Card>
  </>;
}

function Accountant() {
  const q = useAsync(() => api<any>('/finance/summary'));
  return <Async q={q} what="finance summary">{(d) => <>
    <div className="grid g4" style={{ marginBottom: '1rem' }}><Stat label="Invoiced" value={money(d.invoiced)} /><Stat label="Collected" value={money(d.collected)} tone="good" /><Stat label="Outstanding" value={money(d.outstanding)} tone="warn" /><Stat label="Overdue" value={money(d.overdue_0_30 + d.overdue_31_60 + d.overdue_60_plus)} tone="bad" hint={`${d.overdue_invoices} invoices`} /></div>
    <Card title="Overdue ageing"><Table cols={[{ key: 'b', label: 'Bucket' }, { key: 'v', label: 'Amount', align: 'right' }]} rows={[{ b: '0–30 days', v: money(d.overdue_0_30) }, { b: '31–60 days', v: money(d.overdue_31_60) }, { b: '60+ days', v: money(d.overdue_60_plus) }]} /><p><Link href="/finance">Open fees & finance →</Link></p></Card>
  </>}</Async>;
}

function Admissions() {
  const q = useAsync(() => api<any[]>('/admissions'));
  return <Card title="Applications" action={<Link href="/admissions">Open admissions</Link>}><Async q={q} what="applications" empty={(d) => !d.length}>{(d) => <Table cols={[{ key: 'n', label: 'Applicant', render: (r) => `${r.applicant_first_name} ${r.applicant_last_name}` }, { key: 'residence_preference', label: 'Residence' }, { key: 'status', label: 'Stage', render: (r) => <StatusBadge s={r.status} /> }]} rows={d.slice(0, 8)} />}</Async></Card>;
}

function Gate() {
  const q = useAsync(() => api<any>('/dismissal/today'));
  return <Async q={q} what="dismissal">{(d) => <div className="grid g4"><Stat label="Collected today" value={d.collected} tone="good" /><Stat label="Still on campus" value={d.pending} tone="warn" /></div>}</Async>;
}
function Nurse() { return <Card title="Health desk"><p>Search a student in <Link href="/students">Students</Link> to view restricted medical alerts. Every access is audited.</p></Card>; }

function TransportDash() {
  const q = useAsync(() => api<any[]>('/transport/routes'));
  const al = useAsync(() => api<any[]>('/transport/alerts?days=30'));
  return <div className="grid g2">
    <Card title="Routes" action={<Link href="/transport">Open transport</Link>}><Async q={q} what="routes" empty={(d) => !d.length}>{(d) => <Table cols={[{ key: 'name', label: 'Route' }, { key: 'driver', label: 'Driver' }, { key: 'riders', label: 'Riders', render: (r) => `${r.riders}/${r.capacity}` }]} rows={d} />}</Async></Card>
    <Card title="Expiring or expired documents"><Async q={al} what="alerts" empty={(d) => !d.length}>{(d) => <Table cols={[{ key: 'subject', label: 'Vehicle / driver' }, { key: 'doc', label: 'Document' }, { key: 'expires_on', label: 'Expires', render: (r) => fmtDate(r.expires_on) }, { key: 'expired', label: '', render: (r) => <StatusBadge s={r.expired ? 'overdue' : 'pending'} /> }]} rows={d} />}</Async></Card>
  </div>;
}
function LibrarianDash() {
  const q = useAsync(() => api<any[]>('/library/overdue'));
  return <Card title="Overdue loans" action={<Link href="/library">Open library desk</Link>}><Async q={q} what="loans" empty={(d) => !d.length}>{(d) => <><div className="grid g4" style={{ marginBottom: '.75rem' }}><Stat label="Overdue items" value={d.length} tone="bad" /></div><Table cols={[{ key: 'title', label: 'Title' }, { key: 'n', label: 'Borrower', render: (r) => `${r.first_name} ${r.last_name}` }, { key: 'days_overdue', label: 'Days late' }, { key: 'fine_so_far_minor', label: 'Fine', align: 'right', render: (r) => money(r.fine_so_far_minor) }]} rows={d.slice(0, 10)} /></>}</Async></Card>;
}
function InventoryDash() {
  const low = useAsync(() => api<any[]>('/inventory/low-stock'));
  const reqs = useAsync(() => api<any[]>('/procurement/requisitions'));
  return <div className="grid g2">
    <Card title="Below reorder level" action={<Link href="/inventory">Open inventory</Link>}><Async q={low} what="stock" empty={(d) => !d.length}>{(d) => <Table cols={[{ key: 'name', label: 'Item' }, { key: 'on_hand', label: 'On hand' }, { key: 'reorder_level', label: 'Reorder at' }]} rows={d} />}</Async></Card>
    <Card title="Requisitions"><Async q={reqs} what="requisitions" empty={(d) => !d.length}>{(d) => <Table cols={[{ key: 'number', label: 'No.' }, { key: 'justification', label: 'Purpose' }, { key: 'status', label: 'Status', render: (r) => <StatusBadge s={r.status} /> }]} rows={d.slice(0, 8)} />}</Async></Card>
  </div>;
}
function HrDash() {
  const docs = useAsync(() => api<any[]>('/hr/document-alerts'));
  const leave = useAsync(() => api<any[]>('/hr/leave'));
  const runs = useAsync(() => api<any[]>('/payroll/runs'));
  return <div className="grid g2">
    <Card title="Leave awaiting decision" action={<Link href="/hr">People & payroll</Link>}><Async q={leave} what="leave">{(d) => <Table cols={[{ key: 'full_name', label: 'Staff' }, { key: 'kind', label: 'Type' }, { key: 'from_date', label: 'From', render: (r) => fmtDate(r.from_date) }]} rows={d.filter((x) => x.status === 'requested')} empty="Nothing pending." />}</Async></Card>
    <Card title="Expiring staff documents"><Async q={docs} what="documents" empty={(d) => !d.length}>{(d) => <Table cols={[{ key: 'full_name', label: 'Staff' }, { key: 'kind', label: 'Document' }, { key: 'expires_on', label: 'Expires', render: (r) => fmtDate(r.expires_on) }]} rows={d.slice(0, 8)} />}</Async></Card>
    <Card title="Payroll"><Async q={runs} what="payroll" empty={(d) => !d.length}>{(d) => <Table cols={[{ key: 'month', label: 'Month' }, { key: 'payslips', label: 'Payslips' }, { key: 'total_net_minor', label: 'Net', align: 'right', render: (r) => money(r.total_net_minor) }, { key: 'status', label: 'Status', render: (r) => <StatusBadge s={r.status === 'paid' ? 'closed' : r.status === 'approved' ? 'approved' : 'draft'} /> }]} rows={d} />}</Async></Card>
  </div>;
}
function KitchenDash() {
  const today = new Date().toISOString().slice(0, 10);
  const q = useAsync(() => api<any>(`/meals/headcount?date=${today}&meal=lunch`));
  return <Card title="Today’s lunch" action={<Link href="/meals">Open meals</Link>}><Async q={q} what="headcount">{(d) => <><div className="grid g4"><Stat label="Expected" value={d.expected} /><Stat label="Served" value={d.served} tone="good" /><Stat label="Dietary alerts" value={d.allergenAlerts.length} tone={d.allergenAlerts.length ? 'bad' : 'good'} /></div><p>{d.menu ? d.menu.items : 'No menu set.'}</p></>}</Async></Card>;
}

function DemoReset() {
  const info = useAsync(() => api<any>('/demo/info').catch(() => null));
  const [confirm, setConfirm] = useState(false);
  const act = useAction();
  if (!info.data?.demo) return null;
  return <Card title="Demo controls"><p className="sub">This build runs on fictional demo data. Resetting restores the original known state (all changes are lost, everyone is signed out).</p>
    {!confirm ? <Button variant="secondary" onClick={() => setConfirm(true)}>Reset demo data…</Button> : <div className="row"><Button variant="danger" busy={act.busy} onClick={async () => { await act.run(async () => { await api('/demo/reset', { body: { confirm: 'RESET DEMO DATA' } }); setToken(null); location.href = '/login'; }, 'Reset complete.'); }}>Yes, wipe and reseed</Button><Button variant="secondary" onClick={() => setConfirm(false)}>Cancel</Button></div>}{act.node}</Card>;
}
