'use client';
import { useState } from 'react';
import { api, fmtDate, money } from '@/lib/api';
import { useAsync, useSession } from '@/lib/hooks';
import { Async, Button, Card, Input, Select, StatusBadge, Table, useAction } from '@/components/ui';

export default function Hr() {
  const s = useSession();
  return <><h1>People & payroll</h1><p className="sub">Staff records, leave and payroll. Payroll data is restricted to payroll roles; staff see only their own payslips.</p>
    {s.can('hr.read') && <HrDesk />}{s.can('payroll.manage') && <Payroll />}<MyPay /><MyLeave /></>;
}
function HrDesk() {
  const s = useSession();
  const staff = useAsync(() => api<any[]>('/hr/staff'));
  const docs = useAsync(() => api<any[]>('/hr/document-alerts'));
  const leave = useAsync(() => api<any[]>('/hr/leave'));
  const act = useAction();
  return <>
    <Card title="Document expiry alerts"><Async q={docs} what="alerts" empty={(d) => !d.length}>{(d) => <Table cols={[{ key: 'full_name', label: 'Staff' }, { key: 'kind', label: 'Document' }, { key: 'expires_on', label: 'Expires', render: (r) => fmtDate(r.expires_on) }, { key: 'expired', label: '', render: (r) => <StatusBadge s={r.expired ? 'overdue' : 'pending'} /> }]} rows={d} />}</Async></Card>
    <Card title="Leave requests">{act.node}<Async q={leave} what="leave" empty={(d) => !d.length}>{(d) => <Table cols={[{ key: 'full_name', label: 'Staff' }, { key: 'kind', label: 'Type' }, { key: 'from_date', label: 'From', render: (r) => fmtDate(r.from_date) }, { key: 'to_date', label: 'To', render: (r) => fmtDate(r.to_date) }, { key: 'status', label: 'Status', render: (r) => <StatusBadge s={r.status} /> },
      { key: 'a', label: '', render: (r) => (s.can('hr.manage') && r.status === 'requested' ? <span className="row" style={{ gap: '.3rem' }}><Button small onClick={async () => { if (await act.run(() => api(`/hr/leave/${r.id}/decision`, { body: { decision: 'approve' } }), 'Approved.')) leave.reload(); }}>Approve</Button><Button small variant="danger" onClick={async () => { if (await act.run(() => api(`/hr/leave/${r.id}/decision`, { body: { decision: 'reject' } }), 'Rejected.')) leave.reload(); }}>Reject</Button></span> : null) }]} rows={d.slice(0, 15)} />}</Async></Card>
    <Card title="Staff directory"><Async q={staff} what="staff" empty={(d) => !d.length}>{(d) => <Table cols={[{ key: 'employee_no', label: 'Emp. no.' }, { key: 'full_name', label: 'Name' }, { key: 'designation', label: 'Role' }, { key: 'department', label: 'Department' }, { key: 'join_date', label: 'Joined', render: (r) => fmtDate(r.join_date) }, { key: 'status', label: 'Status', render: (r) => <StatusBadge s={r.status} /> }]} rows={d.slice(0, 30)} />}</Async></Card></>;
}
function Payroll() {
  const s = useSession();
  const runs = useAsync(() => api<any[]>('/payroll/runs'));
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const act = useAction();
  return <Card title="Payroll runs">{act.node}
    <Async q={runs} what="runs" empty={(d) => !d.length}>{(d) => <Table cols={[{ key: 'month', label: 'Month' }, { key: 'payslips', label: 'Payslips' }, { key: 'total_net_minor', label: 'Net total', align: 'right', render: (r) => money(r.total_net_minor) }, { key: 'status', label: 'Status', render: (r) => <StatusBadge s={r.status === 'paid' ? 'closed' : r.status === 'approved' ? 'approved' : 'draft'} /> },
      { key: 'a', label: '', render: (r) => <span className="row" style={{ gap: '.3rem' }}>
        {s.can('payroll.approve') && r.status === 'draft' && <Button small onClick={async () => { if (await act.run(() => api(`/payroll/runs/${r.id}/decision`, { body: { decision: 'approve' } }), 'Run approved (a different person from the preparer is required).')) runs.reload(); }}>Approve</Button>}
        {s.can('payroll.approve') && r.status === 'approved' && <Button small variant="secondary" onClick={async () => { if (await act.run(() => api(`/payroll/runs/${r.id}/decision`, { body: { decision: 'mark_paid' } }), 'Marked paid (bank transfer is outside this system).')) runs.reload(); }}>Mark paid</Button>}</span> }]} rows={d} />}</Async>
    <form onSubmit={async (e) => { e.preventDefault(); if (await act.run(() => api('/payroll/runs', { body: { month } }), 'Draft run created from attendance and salary structures.')) runs.reload(); }}><div className="row"><Input label="Month (YYYY-MM)" pattern="\d{4}-(0[1-9]|1[0-2])" value={month} onChange={(e) => setMonth(e.target.value)} required /><Button type="submit" busy={act.busy}>Create draft run</Button></div></form></Card>;
}
function MyPay() {
  const q = useAsync(() => api<any[]>('/me/payslips').catch(() => []));
  return <Card title="My payslips"><Async q={q} what="payslips" empty={(d) => !d.length}>{(d) => <Table cols={[{ key: 'month', label: 'Month' }, { key: 'basic_minor', label: 'Basic', align: 'right', render: (r) => money(r.basic_minor) }, { key: 'allowances_minor', label: 'Allowances', align: 'right', render: (r) => money(r.allowances_minor) }, { key: 'deductions_minor', label: 'Deductions', align: 'right', render: (r) => money(r.deductions_minor + r.absence_deduction_minor) }, { key: 'net_minor', label: 'Net pay', align: 'right', render: (r) => money(r.net_minor) }]} rows={d} />}</Async></Card>;
}
function MyLeave() {
  const [f, setF] = useState<any>({ kind: 'casual' }); const act = useAction();
  return <Card title="Request leave"><form onSubmit={async (e) => { e.preventDefault(); await act.run(() => api('/me/staff-leave', { body: { kind: f.kind, fromDate: f.from, toDate: f.to, reason: f.reason } }), 'Leave request sent to HR.'); }}>
    <div className="row"><Select label="Type" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })} options={['casual', 'sick', 'earned', 'unpaid'].map((v) => ({ value: v, label: v }))} /><Input label="From" type="date" value={f.from ?? ''} onChange={(e) => setF({ ...f, from: e.target.value })} required /><Input label="To" type="date" value={f.to ?? ''} onChange={(e) => setF({ ...f, to: e.target.value })} required /><Button type="submit" busy={act.busy}>Send</Button></div>{act.node}</form></Card>;
}
