'use client';
import { useState } from 'react';
import { api, fmtDate } from '@/lib/api';
import { useAsync, useSession } from '@/lib/hooks';
import { Alert, Async, Badge, Button, Card, Input, Select, StatusBadge, Table, useAction } from '@/components/ui';

export default function Consents() {
  const s = useSession();
  return <><h1>Consent forms</h1><p className="sub">Digital acknowledgements are recorded per child with the signer’s name, time and network address, and cannot be changed afterwards.</p>
    {s.hasRole('parent') && <Mine />}{s.can('consents.manage') && <Manage />}</>;
}

function Mine() {
  const q = useAsync(() => api<any[]>('/consents/mine'));
  const [name, setName] = useState('');
  const act = useAction();
  const respond = (formId: string, studentId: string, decision: 'agree' | 'decline') => async () => { if (await act.run(() => api(`/consents/${formId}/respond`, { body: { studentId, decision, signedName: name, confirm: true } }), decision === 'agree' ? 'Consent recorded.' : 'Declined — recorded.')) q.reload(); };
  return <Card title="Needs your response"><Input label="Your full name (used as your signature)" value={name} onChange={(e) => setName(e.target.value)} />
    {act.node}<Async q={q} what="forms" empty={(d) => !d.length}>{(d) => <Table cols={[{ key: 'title', label: 'Form' }, { key: 'student', label: 'Child' }, { key: 'body', label: 'Details' }, { key: 'dueOn', label: 'Due', render: (r) => fmtDate(r.dueOn) },
      { key: 'a', label: 'Response', render: (r) => (r.response ? <Badge tone={r.response.decision === 'agree' ? 'good' : 'warn'}>{r.response.decision === 'agree' ? 'agreed' : 'declined'}</Badge> : <span className="row" style={{ gap: '.3rem' }}><Button small disabled={name.trim().length < 2} onClick={respond(r.formId, r.studentId, 'agree')}>I agree</Button><Button small variant="secondary" disabled={name.trim().length < 2} onClick={respond(r.formId, r.studentId, 'decline')}>Decline</Button></span>) }]} rows={d} />}</Async></Card>;
}

function Manage() {
  const list = useAsync(() => api<any[]>('/consents'));
  const [sel, setSel] = useState<string | null>(null);
  const st = useAsync(() => (sel ? api<any>(`/consents/status/${sel}`) : Promise.resolve(null)), [sel]);
  const [f, setF] = useState<any>({ audienceType: 'all' });
  const act = useAction();
  return <>
    <Card title="Forms issued">{act.node}<Async q={list} what="forms" empty={(d) => !d.length}>{(d) => <Table cols={[{ key: 'title', label: 'Form' }, { key: 'audience_type', label: 'Audience' }, { key: 'due_on', label: 'Due', render: (r) => fmtDate(r.due_on) }, { key: 'responses', label: 'Responses' }, { key: 'agreed', label: 'Agreed' }, { key: 'status', label: 'Status', render: (r) => <StatusBadge s={r.status} /> },
      { key: 'a', label: '', render: (r) => <Button small variant="secondary" onClick={() => setSel(r.id)}>Who has not replied</Button> }]} rows={d} />}</Async></Card>
    {sel && <Card title="Outstanding responses"><Async q={st} what="status">{(d) => d && <><p><strong>{d.agreed}</strong> agreed · <strong>{d.declined}</strong> declined · <strong>{d.outstanding.length}</strong> of {d.total} outstanding</p>
      <Table cols={[{ key: 'admissionNo', label: 'Adm. no.' }, { key: 'name', label: 'Student' }]} rows={d.outstanding.slice(0, 30)} empty="Everyone has responded." />
      {d.outstanding.length > 0 && <div style={{ marginTop: '.75rem' }}><Button onClick={async () => { await act.run(async () => { const r = await api<any>(`/consents/${sel}/remind`, { method: 'POST', body: {} }); void r; }, 'Reminders sent in-app.'); }}>Remind guardians</Button></div>}</>}</Async></Card>}
    <Card title="New consent form"><form onSubmit={async (e) => { e.preventDefault(); if (await act.run(() => api('/consents', { body: { title: f.title, body: f.body, audienceType: f.audienceType, ...(f.ref ? { audienceRef: f.ref } : {}), ...(f.due ? { dueOn: f.due } : {}) } }), 'Form issued and guardians notified.')) { setF({ audienceType: 'all' }); list.reload(); } }}>
      <div className="row"><Input label="Title" value={f.title ?? ''} onChange={(e) => setF({ ...f, title: e.target.value })} required minLength={3} /><Select label="Audience" value={f.audienceType} onChange={(e) => setF({ ...f, audienceType: e.target.value })} options={[{ value: 'all', label: 'All students' }]} /><Input label="Due" type="date" value={f.due ?? ''} onChange={(e) => setF({ ...f, due: e.target.value })} /></div>
      <div className="field"><label htmlFor="cb">Text the guardian will agree to</label><textarea id="cb" value={f.body ?? ''} onChange={(e) => setF({ ...f, body: e.target.value })} required minLength={10} /></div><Button type="submit" busy={act.busy}>Issue form</Button>
      <Alert kind="info">Grade-, class- and activity-specific forms are available through the API (`audienceType` + `audienceRef`).</Alert></form></Card></>;
}
