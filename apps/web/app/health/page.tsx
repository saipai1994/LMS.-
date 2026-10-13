'use client';
import { useState } from 'react';
import { api, fmtDate, fmtDateTime } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { Async, Button, Card, Input, Select, StatusBadge, Table, useAction } from '@/components/ui';

export default function Health() {
  const stock = useAsync(() => api<any[]>('/health/medicine-alerts'));
  const refs = useAsync(() => api<any[]>('/counselling/referrals'));
  const students = useAsync(() => api<any[]>('/students?limit=200'));
  const [f, setF] = useState<any>({ outcome: 'rested' });
  const act = useAction();
  return <><h1>Health & wellbeing</h1><p className="sub">Restricted records. Every view of clinical or counselling data is written to the audit log.</p>
    <Card title="Record a clinic visit"><Async q={students} what="students">{(d) => <form onSubmit={async (e) => { e.preventDefault(); if (await act.run(() => api('/health/visits', { body: { studentId: f.studentId, complaint: f.complaint, treatment: f.treatment, outcome: f.outcome } }), 'Visit recorded. Guardians are notified for send-home, referral or admission.')) setF({ outcome: 'rested' }); }}>
      <div className="row"><Select label="Student" value={f.studentId ?? ''} onChange={(e) => setF({ ...f, studentId: e.target.value })} required placeholder="Choose…" options={d.map((x) => ({ value: x.id, label: `${x.admission_no} ${x.first_name} ${x.last_name}` }))} /><Select label="Outcome" value={f.outcome} onChange={(e) => setF({ ...f, outcome: e.target.value })} options={['returned_to_class', 'rested', 'sent_home', 'referred', 'admitted'].map((v) => ({ value: v, label: v.replace(/_/g, ' ') }))} /></div>
      <Input label="Complaint" value={f.complaint ?? ''} onChange={(e) => setF({ ...f, complaint: e.target.value })} required minLength={3} /><Input label="Treatment given" value={f.treatment ?? ''} onChange={(e) => setF({ ...f, treatment: e.target.value })} /><Button type="submit" busy={act.busy}>Save visit</Button>{act.node}</form>}</Async></Card>
    <div className="grid g2">
      <Card title="Medicine stock alerts"><Async q={stock} what="stock" empty={(d) => !d.length}>{(d) => <Table cols={[{ key: 'name', label: 'Medicine' }, { key: 'qty', label: 'Qty' }, { key: 'expires_on', label: 'Expires', render: (r) => fmtDate(r.expires_on) }, { key: 'expired', label: '', render: (r) => <StatusBadge s={r.expired ? 'overdue' : 'pending'} /> }]} rows={d} />}</Async></Card>
      <Card title="Counselling referrals (confidential)"><Async q={refs} what="referrals" empty={(d) => !d.length}>{(d) => <Table cols={[{ key: 'n', label: 'Student', render: (r) => `${r.first_name} ${r.last_name}` }, { key: 'reason', label: 'Reason' }, { key: 'status', label: 'Status', render: (r) => <StatusBadge s={r.status} /> }, { key: 'created_at', label: 'Referred', render: (r) => fmtDateTime(r.created_at) }]} rows={d} />}</Async></Card>
    </div></>;
}
