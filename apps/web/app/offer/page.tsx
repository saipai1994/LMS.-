'use client';
import { FormEvent, useState } from 'react';
import { api, errText, fmtDate } from '@/lib/api';
import { Alert, Button, Card, Input } from '@/components/ui';

/** Public page where a guardian reviews and accepts/declines an admission offer using the token the school gave them. */
export default function Offer() {
  const [f, setF] = useState({ tenant: 'greenwood', token: '', name: '' });
  const [offer, setOffer] = useState<any>(null);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [agree, setAgree] = useState(false);
  async function view(e: FormEvent) { e.preventDefault(); setMsg(null); try { setOffer(await api('/admissions/public/offers/view', { body: { tenant: f.tenant, token: f.token } })); } catch (err) { setOffer(null); setMsg({ kind: 'error', text: errText(err) }); } }
  async function decide(decision: 'accepted' | 'declined') { setMsg(null); try { await api('/admissions/public/offers/decide', { body: { tenant: f.tenant, token: f.token, decision, signedName: f.name, agree: true } }); setMsg({ kind: 'success', text: decision === 'accepted' ? 'Thank you — the offer has been accepted and your consent recorded. The school will contact you about enrolment.' : 'The offer has been declined.' }); setOffer({ ...offer, decision }); } catch (err) { setMsg({ kind: 'error', text: errText(err) }); } }
  return <div className="login"><h1>Admission offer</h1><p className="sub">Enter the school code and the offer code you received from the admissions office.</p>
    <form className="card" onSubmit={view}><Input label="School code" value={f.tenant} onChange={(e) => setF({ ...f, tenant: e.target.value })} required /><Input label="Offer code" value={f.token} onChange={(e) => setF({ ...f, token: e.target.value })} required /><Button type="submit">View offer</Button></form>
    {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
    {offer && <Card title={`Offer for ${offer.applicant}`}><p style={{ whiteSpace: 'pre-wrap' }}>{offer.terms}</p><p className="sub">Valid until {fmtDate(offer.expiresOn)}.</p>
      {offer.decision ? <Alert kind="info">Decision recorded: {offer.decision}.</Alert> : <><Input label="Your full name (signature)" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
        <label><input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} /> I am the child’s parent/guardian and I agree to the terms above.</label>
        <div className="row" style={{ marginTop: '.75rem' }}><Button disabled={!agree || f.name.trim().length < 2} onClick={() => decide('accepted')}>Accept offer</Button><Button variant="secondary" disabled={!agree || f.name.trim().length < 2} onClick={() => decide('declined')}>Decline</Button></div></>}</Card>}</div>;
}
