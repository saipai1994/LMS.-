'use client';
import { useState } from 'react';
import { api, errText, fmtDate, money, openDocument } from '@/lib/api';
import { useAsync, useSession } from '@/lib/hooks';
import { Alert, Async, Button, Card, Select, StatusBadge, Table, useAction } from '@/components/ui';

export default function Lifecycle() {
  const s = useSession();
  return <><h1>Student lifecycle</h1><p className="sub">Year-end progression, withdrawals and transfers, and alumni. Every change keeps the student’s history.</p>
    {s.can('students.promote') && <Promotion />}<Withdrawals /><Alumni /></>;
}

function Promotion() {
  const years = useAsync(() => api<any[]>('/academic-years'));
  const [yid, setYid] = useState('');
  const pv = useAsync(() => (yid ? api<any>(`/promotion/preview?academicYearId=${yid}`) : Promise.resolve(null)), [yid]);
  return <Card title="Promotion & retention (preview)">
    <Async q={years} what="years">{(d) => <Select label="Academic year" value={yid} onChange={(e) => setYid(e.target.value)} placeholder="Choose…" options={d.map((y) => ({ value: y.id, label: `${y.name}${y.is_current ? ' (current)' : ''}` }))} />}</Async>
    {yid && <Async q={pv} what="preview">{(d) => d && <>
      <Alert kind="info">Rule: overall ≥ {Number(d.rule.min_overall_percent)}%, at most {d.rule.max_failed_subjects} failed subjects{Number(d.rule.min_attendance_percent) ? `, attendance ≥ ${Number(d.rule.min_attendance_percent)}%` : ''}. Students without approved results are flagged for review — never promoted automatically. Applying decisions is done through <code>POST /promotion/apply</code> after review.</Alert>
      <div className="grid g4" style={{ margin: '.75rem 0' }}>{(['promote', 'retain', 'graduate', 'needs_review'] as const).map((k) => <div className="stat" key={k}><div className="stat-v">{d.students.filter((x: any) => x.suggestion === k).length}</div><div className="stat-l">{k.replace('_', ' ')}</div></div>)}</div>
      <Table cols={[{ key: 'admissionNo', label: 'Adm. no.' }, { key: 'name', label: 'Student' }, { key: 'c', label: 'Class', render: (r) => `${r.grade} ${r.section}` }, { key: 'overallPercent', label: 'Overall %', render: (r) => r.overallPercent ?? '—' }, { key: 'attendancePercent', label: 'Attendance', render: (r) => (r.attendancePercent === null ? '—' : `${r.attendancePercent}%`) },
        { key: 'suggestion', label: 'Suggestion', render: (r) => <StatusBadge s={r.suggestion === 'promote' ? 'approved' : r.suggestion === 'retain' ? 'warn' : r.suggestion === 'graduate' ? 'closed' : 'pending'} /> }, { key: 'reasons', label: 'Why', render: (r) => r.reasons.join('; ') }]} rows={d.students.filter((x: any) => x.suggestion !== 'needs_review').slice(0, 40)} empty="No students with approved results yet." /></>}</Async>}</Card>;
}

function Withdrawals() {
  const s = useSession();
  const q = useAsync(() => api<any[]>('/withdrawals'));
  const [sel, setSel] = useState<string | null>(null);
  const cl = useAsync(() => (sel ? api<any>(`/withdrawals/${sel}/clearance`) : Promise.resolve(null)), [sel]);
  const act = useAction();
  const call = (path: string, body: any, ok: string) => async () => { if (await act.run(() => api(path, { body }), ok)) { q.reload(); cl.reload(); } };
  return <Card title="Withdrawals & transfers">{act.node}
    <Async q={q} what="requests" empty={(d) => !d.length}>{(d) => <Table cols={[{ key: 'n', label: 'Student', render: (r) => `${r.first_name} ${r.last_name}` }, { key: 'kind', label: 'Type', render: (r) => r.kind.replace('_', ' ') }, { key: 'reason', label: 'Reason' }, { key: 'effective_date', label: 'Effective', render: (r) => fmtDate(r.effective_date) }, { key: 'status', label: 'Status', render: (r) => <StatusBadge s={r.status} /> },
      { key: 'a', label: '', render: (r) => <span className="row" style={{ gap: '.3rem' }}>
        {s.can('students.withdraw_approve') && r.status === 'requested' && <><Button small onClick={call(`/withdrawals/${r.id}/decision`, { decision: 'approve' }, 'Approved.')}>Approve</Button><Button small variant="danger" onClick={call(`/withdrawals/${r.id}/decision`, { decision: 'reject' }, 'Rejected.')}>Reject</Button></>}
        {r.status === 'approved' && <Button small variant="secondary" onClick={() => setSel(r.id)}>Clearance</Button>}
        {r.status === 'completed' && <Button small variant="secondary" onClick={async () => { try { await openDocument(`/students/${r.student_id}/leaving-certificate`); } catch (e) { alert(errText(e)); } }}>Leaving certificate</Button>}</span> }]} rows={d} />}</Async>
    {sel && <Async q={cl} what="clearance">{(c) => c && <div style={{ marginTop: '.75rem' }}><h3>Clearance</h3><Table cols={[{ key: 'k', label: 'Check' }, { key: 'v', label: 'Status' }]} rows={[
      { k: 'Fees outstanding', v: c.feesOutstandingMinor > 0 ? <StatusBadge s="overdue" /> : <StatusBadge s="paid" />, extra: money(c.feesOutstandingMinor) }, { k: 'Library items out', v: c.openLibraryLoans ? <StatusBadge s="overdue" /> : <StatusBadge s="paid" /> }, { k: 'Hostel bed assigned', v: c.hostelBedAssigned ? 'will be released' : '—' }, { k: 'Off campus on leave', v: c.currentlyOffCampusOnLeave ? <StatusBadge s="overdue" /> : <StatusBadge s="paid" /> }].map((r) => ({ ...r, v: <>{r.v} {(r as any).extra && <small>{(r as any).extra}</small>}</> }))} />
      <div className="row" style={{ marginTop: '.75rem' }}><Button disabled={c.blockers.length > 0 && !(c.blockers.length === 1 && c.blockers[0] === 'outstanding_fees')} onClick={call(`/withdrawals/${sel}/complete`, { waiveOutstandingFees: false }, 'Exit completed.')}>Complete exit</Button>
        {s.can('finance.approve') && c.feesOutstandingMinor > 0 && <Button variant="danger" onClick={call(`/withdrawals/${sel}/complete`, { waiveOutstandingFees: true }, 'Fees written off and exit completed.')}>Write off fees and complete</Button>}</div></div>}</Async>}</Card>;
}

function Alumni() {
  const q = useAsync(() => api<any[]>('/alumni').catch(() => []));
  return <Card title="Alumni and former students"><Async q={q} what="alumni" empty={(d) => !d.length}>{(d) => <Table cols={[{ key: 'admission_no', label: 'Adm. no.' }, { key: 'n', label: 'Name', render: (r) => `${r.first_name} ${r.last_name}` }, { key: 'status', label: 'Status', render: (r) => <StatusBadge s={r.status} /> }, { key: 'left_on', label: 'Left', render: (r) => fmtDate(r.left_on) }]} rows={d} />}</Async></Card>;
}
