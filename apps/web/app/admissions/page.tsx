'use client';
import { FormEvent, useState } from 'react';
import { api, fmtDate, fmtDateTime } from '@/lib/api';
import { useAsync, useSession } from '@/lib/hooks';
import { Alert, Async, Button, Card, Input, Select, StatusBadge, Table, useAction } from '@/components/ui';

const NEXT: Record<string, string[]> = { submitted: ['under_review'], under_review: ['offered', 'waitlisted'], waitlisted: ['offered'], offered: ['accepted'] };

export default function Admissions() {
  const s = useSession();
  const [status, setStatus] = useState('');
  const apps = useAsync(() => api<any[]>(`/admissions${status ? `?status=${status}` : ''}`), [status]);
  const act = useAction();
  const [enrolling, setEnrolling] = useState<any>(null);
  const [result, setResult] = useState<any>(null);
  const [offerTok, setOfferTok] = useState<{ id: string; tok: string } | null>(null);
  const enq = useAsync(() => api<any[]>('/admissions/enquiries').catch(() => []));
  const funnel = useAsync(() => api<any>('/reports/admission-funnel').catch(() => null));
  return <>
    <h1>Admissions</h1><p className="sub">Enquiry → application → offer → enrolment. Enrolling creates the student ID, class placement, parent account and LMS access in one step.</p>
    <Card title="Applications" action={<Select label="Stage" value={status} onChange={(e) => setStatus(e.target.value)} placeholder="All" options={['submitted', 'under_review', 'waitlisted', 'offered', 'accepted', 'enrolled', 'rejected', 'withdrawn'].map((v) => ({ value: v, label: v.replace('_', ' ') }))} />}>
      <Async q={apps} what="applications" empty={(d) => !d.length}>{(d) => <Table cols={[
        { key: 'n', label: 'Applicant', render: (r) => `${r.applicant_first_name} ${r.applicant_last_name}` }, { key: 'guardian_name', label: 'Guardian' }, { key: 'residence_preference', label: 'Residence', render: (r) => r.residence_preference.replace('_', ' ') },
        { key: 'created_at', label: 'Applied', render: (r) => fmtDate(r.created_at) }, { key: 'status', label: 'Stage', render: (r) => <StatusBadge s={r.status} /> },
        { key: 'actions', label: 'Actions', render: (r) => <span className="row" style={{ gap: '.3rem' }}>
          {s.can('admissions.decide') && (NEXT[r.status] ?? []).map((to) => <Button key={to} small variant="secondary" onClick={async () => { let consentRef: string | undefined; if (to === 'accepted') { consentRef = window.prompt('Acceptance needs evidence of the guardian’s consent.\nEnter the signed paper-form reference (or cancel and use the online offer):') ?? undefined; if (!consentRef) return; } if (await act.run(() => api(`/admissions/${r.id}/transition`, { body: { to, ...(consentRef ? { consentRef } : {}) } }), `Moved to ${to.replace('_', ' ')}.`)) apps.reload(); }}>→ {to.replace('_', ' ')}</Button>)}
          {s.can('admissions.decide') && r.status === 'offered' && <Button small onClick={async () => { let tok = ''; if (await act.run(async () => { const o = await api<any>(`/admissions/${r.id}/offer`, { body: { expiresOn: new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10), terms: 'Annual fees as per the attached schedule. School rules and the code of conduct apply. Acceptance constitutes consent to the terms.' } }); tok = o.offerToken; setOfferTok({ id: r.id, tok }); }, 'Offer issued (14 days).')) apps.reload(); }}>Issue offer</Button>}
          {s.can('admissions.decide') && ['submitted', 'under_review', 'waitlisted', 'offered'].includes(r.status) && <Button small variant="danger" onClick={async () => { if (await act.run(() => api(`/admissions/${r.id}/transition`, { body: { to: 'rejected' } }), 'Application rejected.')) apps.reload(); }}>Reject</Button>}
          {s.can('admissions.enroll') && r.status === 'accepted' && <Button small onClick={() => { setEnrolling(r); setResult(null); }}>Enrol…</Button>}
        </span> },
      ]} rows={d} />}</Async>
      {act.node}
    </Card>
    {offerTok && <Alert kind="info">Offer code (give to the guardian securely — email is not configured): <code>{offerTok.tok}</code>. They accept at <code>/offer</code>.</Alert>}
    {enrolling && <Enrol app={enrolling} onDone={(r) => { setResult(r); setEnrolling(null); apps.reload(); }} onCancel={() => setEnrolling(null)} />}
    {result && <Card title="Enrolled"><dl className="kv"><dt>Admission no.</dt><dd>{result.admissionNo}</dd><dt>Parent invite</dt><dd>{result.parentInviteToken ? <><code>{result.parentInviteToken}</code><br /><small>{result.notice}</small></> : 'Existing parent account linked.'}</dd></dl></Card>}
    <Card title="Enquiries (CRM)"><Async q={enq} what="enquiries" empty={(d) => !d.length}>{(d) => <Table cols={[{ key: 'child_name', label: 'Child' }, { key: 'contact_name', label: 'Contact' }, { key: 'source', label: 'Source' }, { key: 'grade', label: 'Interested in' }, { key: 'status', label: 'Status', render: (r) => <StatusBadge s={r.status === 'visit_scheduled' ? 'pending' : r.status} /> }, { key: 'created_at', label: 'Received', render: (r) => fmtDateTime(r.created_at) }]} rows={d.slice(0, 12)} />}</Async></Card>
    <Async q={funnel as any} what="funnel">{(f: any) => f ? <Card title="Funnel"><p>{f.total} applications · offer rate {f.offerRatePercent}% · enrolment conversion {f.conversionPercent}%</p></Card> : null}</Async>
    {s.can('admissions.write') && <NewApplication onCreated={apps.reload} />}
  </>;
}

function Enrol({ app, onDone, onCancel }: { app: any; onDone: (r: any) => void; onCancel: () => void }) {
  const secs = useAsync(() => api<any[]>('/sections'));
  const [sectionId, setSectionId] = useState('');
  const act = useAction();
  const candidates = (secs.data ?? []).filter((x) => x.grade_level_id === app.grade_level_id && x.academic_year_id === app.academic_year_id);
  return <Card title={`Enrol ${app.applicant_first_name} ${app.applicant_last_name}`}>
    <Async q={secs} what="classes">{() => candidates.length ? <form onSubmit={async (e) => { e.preventDefault(); let r: any; if (await act.run(async () => { r = await api(`/admissions/${app.id}/enroll`, { body: { sectionId } }); }, 'Enrolled.')) onDone(r); }}>
      <Select label="Class section" value={sectionId} onChange={(e) => setSectionId(e.target.value)} required placeholder="Choose…" options={candidates.map((c) => ({ value: c.id, label: `${c.grade_name} ${c.name} — ${c.enrolled}/${c.capacity} seats used` }))} />
      <div className="row"><Button type="submit" busy={act.busy} disabled={!sectionId}>Confirm enrolment</Button><Button variant="secondary" onClick={onCancel}>Cancel</Button></div>{act.node}</form> : <p>No class sections exist for this grade and year yet.</p>}</Async></Card>;
}

function NewApplication({ onCreated }: { onCreated: () => void }) {
  const meta = useAsync(async () => ({ years: await api<any[]>('/academic-years'), grades: await api<any[]>('/grade-levels'), secs: await api<any[]>('/sections') }));
  const [f, setF] = useState<any>({ residencePreference: 'day_scholar' });
  const act = useAction();
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  async function submit(e: FormEvent) {
    e.preventDefault();
    const campusId = meta.data!.secs[0]?.campus_id;
    if (await act.run(() => api('/admissions', { body: { campusId, academicYearId: f.year, gradeLevelId: f.grade, applicantFirstName: f.first, applicantLastName: f.last, applicantDob: f.dob, guardianName: f.gname, guardianEmail: f.gemail, residencePreference: f.residencePreference } }), 'Application recorded.')) { setF({ residencePreference: 'day_scholar' }); onCreated(); }
  }
  return <Card title="New application"><Async q={meta} what="form">{(m) => <form onSubmit={submit}><div className="row">
    <Input label="Applicant first name" value={f.first ?? ''} onChange={set('first')} required /><Input label="Last name" value={f.last ?? ''} onChange={set('last')} required /><Input label="Date of birth" type="date" value={f.dob ?? ''} onChange={set('dob')} required /></div><div className="row">
    <Select label="Academic year" value={f.year ?? ''} onChange={set('year')} required placeholder="Choose…" options={m.years.map((y: any) => ({ value: y.id, label: y.name }))} /><Select label="Grade" value={f.grade ?? ''} onChange={set('grade')} required placeholder="Choose…" options={m.grades.map((g: any) => ({ value: g.id, label: g.name }))} />
    <Select label="Residence" value={f.residencePreference} onChange={set('residencePreference')} options={[{ value: 'day_scholar', label: 'Day scholar' }, { value: 'boarder', label: 'Boarder' }]} /></div><div className="row">
    <Input label="Guardian name" value={f.gname ?? ''} onChange={set('gname')} required /><Input label="Guardian email" type="email" value={f.gemail ?? ''} onChange={set('gemail')} required /><Button type="submit" busy={act.busy}>Record application</Button></div>{act.node}</form>}</Async></Card>;
}
