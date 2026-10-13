'use client';
import { api, fmtDate } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { Async, Button, Card, StatusBadge, Table, useAction } from '@/components/ui';

export default function Grades() {
  const q = useAsync(() => api<any[]>('/grade-publications?status=submitted'));
  const act = useAction();
  const decide = (id: string, decision: string) => async () => { if (await act.run(() => api(`/grade-publications/${id}/decision`, { body: { decision } }), `Publication ${decision}d.`)) q.reload(); };
  return <><h1>Result approvals</h1><p className="sub">Teachers propose marks; only approved results reach official records and report cards. Approved results cannot be edited.</p>
    <Card title="Awaiting approval"><Async q={q} what="submissions" empty={(d) => !d.length}>{(d) => <Table cols={[{ key: 'course', label: 'Course' }, { key: 'assessment_name', label: 'Assessment' }, { key: 'students', label: 'Students' }, { key: 'created_at', label: 'Submitted', render: (r) => fmtDate(r.created_at) }, { key: 'status', label: 'Status', render: (r) => <StatusBadge s={r.status} /> },
      { key: 'a', label: '', render: (r) => <span className="row" style={{ gap: '.3rem' }}><Button small onClick={decide(r.id, 'approve')}>Approve</Button><Button small variant="danger" onClick={decide(r.id, 'reject')}>Reject</Button></span> }]} rows={d} />}</Async>{act.node}</Card></>;
}
