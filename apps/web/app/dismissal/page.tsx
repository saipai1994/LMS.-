'use client';
import { useState } from 'react';
import { api, fmtDateTime } from '@/lib/api';
import { useAsync } from '@/lib/hooks';
import { Alert, Async, Button, Card, Stat, StatusBadge, Table, useAction } from '@/components/ui';

export default function Dismissal() {
  const q = useAsync(() => api<any>('/dismissal/today'));
  const [sel, setSel] = useState<any>(null);
  const [notice, setNotice] = useState<string | null>(null);
  return <><h1>Day-scholar dismissal</h1><p className="sub">Hand over each child only to a listed guardian or an authorised pickup person after checking photo ID.</p>
    <Async q={q} what="dismissal list">{(d) => <>
      <div className="grid g4" style={{ marginBottom: '1rem' }}><Stat label="Collected" value={d.collected} tone="good" /><Stat label="Still on campus" value={d.pending} tone="warn" /></div>
      {notice && <Alert kind="success">{notice}</Alert>}
      {sel && <Handover s={sel} onDone={(msg) => { setSel(null); if (msg) setNotice(msg); q.reload(); }} />}
      <Card title="Today"><Table cols={[{ key: 'admission_no', label: 'Adm. no.' }, { key: 'n', label: 'Student', render: (r) => `${r.first_name} ${r.last_name}` }, { key: 'collected', label: 'Status', render: (r) => <StatusBadge s={r.collected ? 'closed' : 'pending'} /> }, { key: 'collected_by_name', label: 'Collected by' }, { key: 'at', label: 'Time', render: (r) => fmtDateTime(r.at) },
        { key: 'a', label: '', render: (r) => (!r.collected ? <Button small onClick={() => setSel(r)}>Hand over…</Button> : null) }]} rows={[...d.students].sort((a: any, b: any) => Number(a.collected) - Number(b.collected))} /></Card></>}</Async></>;
}

function Handover({ s, onDone }: { s: any; onDone: (msg?: string) => void }) {
  const list = useAsync(() => api<any>(`/students/${s.id}/pickup-list`), [s.id]);
  const [who, setWho] = useState('');
  const [checked, setChecked] = useState(false);
  const act = useAction();
  return <Card title={`Hand over ${s.first_name} ${s.last_name}`}><Async q={list} what="authorised persons">{(d) => {
    const opts = [...d.guardians.map((g: any) => ({ v: `g:${g.id}`, l: `${g.full_name} (${g.relationship})` })), ...d.authorized.map((p: any) => ({ v: `a:${p.id}`, l: `${p.full_name} (${p.relationship})${p.id_hint ? ` — ID ends ${p.id_hint}` : ''}` }))];
    return <form onSubmit={async (e) => { e.preventDefault(); const [t, id] = who.split(':'); let r: any; if (await act.run(async () => { r = await api('/dismissal/handover', { body: { studentId: s.id, idVerified: checked, ...(t === 'g' ? { guardianId: id } : { authorizedPickupId: id }) } }); }, 'Handover recorded.')) onDone(`Handover recorded: ${s.first_name} ${s.last_name} collected by ${r.collectedBy}. Guardians notified in-app.`); }}>
      <div className="field"><label htmlFor="who">Person collecting</label><select id="who" value={who} onChange={(e) => setWho(e.target.value)} required><option value="">Choose…</option>{opts.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}</select></div>
      <label><input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} /> I have checked this person's photo ID</label>
      <div className="row" style={{ marginTop: '.75rem' }}><Button type="submit" busy={act.busy} disabled={!who || !checked}>Confirm handover</Button><Button variant="secondary" onClick={() => onDone()}>Cancel</Button></div>{act.node}</form>;
  }}</Async></Card>;
}
