'use client';
import { useState } from 'react';
import { api, fmtDate, money } from '@/lib/api';
import { useAsync, useSession } from '@/lib/hooks';
import { Async, Button, Card, Input, Select, Stat, StatusBadge, Table, useAction } from '@/components/ui';

export default function Finance() {
  const s = useSession();
  return <><h1>Fees & finance</h1><p className="sub">All amounts are in INR. Online payments use a <strong>Demo / Simulated</strong> gateway.</p>{s.can('finance.read') ? <Staff /> : <ParentFees />}</>;
}

function ParentFees() {
  const q = useAsync(() => api<any[]>('/finance/me/invoices'));
  const act = useAction(); const [receipt, setReceipt] = useState<any>(null);
  async function pay(id: string) {
    await act.run(async () => {
      const intent = await api<any>('/finance/payment-intents', { body: { invoiceId: id } });
      const r = await api<any>(`/finance/payment-intents/${intent.id}/simulate`, { body: { outcome: 'succeeded' } });
      if (r.paymentId) setReceipt(await api(`/finance/payments/${r.paymentId}/receipt`)); q.reload();
    }, 'Simulated payment recorded.');
  }
  return <Card title="Invoices for your children"><Async q={q} what="invoices" empty={(d) => !d.length}>{(d) => <Table cols={[{ key: 'first_name', label: 'Child' }, { key: 'number', label: 'Invoice' }, { key: 'due_date', label: 'Due', render: (r) => fmtDate(r.due_date) }, { key: 'total_minor', label: 'Total', align: 'right', render: (r) => money(r.total_minor) }, { key: 'outstanding_minor', label: 'Outstanding', align: 'right', render: (r) => money(r.outstanding_minor) }, { key: 'display_status', label: 'Status', render: (r) => <StatusBadge s={r.display_status} /> },
    { key: 'p', label: '', render: (r) => (Number(r.outstanding_minor) > 0 ? <Button small onClick={() => pay(r.id)} busy={act.busy}>Pay (demo)</Button> : null) }]} rows={d} />}</Async>{act.node}
    {receipt && <div className="alert info"><strong>{receipt.receiptNo}</strong> — {money(receipt.amountMinor)} for {receipt.student}. {receipt.notice}</div>}</Card>;
}

function Staff() {
  const s = useSession();
  const [status, setStatus] = useState('');
  const sum = useAsync(() => api<any>('/finance/summary'));
  const inv = useAsync(() => api<any[]>(`/finance/invoices?limit=100${status ? `&status=${status}` : ''}`), [status]);
  const rec = useAsync(() => api<any>('/finance/reconciliation'));
  const [pay, setPay] = useState<any>(null);
  const refresh = () => { sum.reload(); inv.reload(); rec.reload(); };
  return <>
    <Async q={sum} what="summary">{(d) => <div className="grid g4" style={{ marginBottom: '1rem' }}><Stat label="Invoiced" value={money(d.invoiced)} /><Stat label="Collected" value={money(d.collected)} tone="good" /><Stat label="Outstanding" value={money(d.outstanding)} tone="warn" /><Stat label="Overdue invoices" value={d.overdue_invoices} tone={d.overdue_invoices ? 'bad' : 'good'} /></div>}</Async>
    <Card title="Invoices" action={<Select label="Status" value={status} onChange={(e) => setStatus(e.target.value)} placeholder="All" options={['issued', 'partially_paid', 'overdue', 'paid', 'void'].map((v) => ({ value: v, label: v.replace('_', ' ') }))} />}>
      <Async q={inv} what="invoices" empty={(d) => !d.length}>{(d) => <Table caption="Invoices" cols={[{ key: 'number', label: 'Invoice' }, { key: 'n', label: 'Student', render: (r) => `${r.first_name} ${r.last_name}` }, { key: 'due_date', label: 'Due', render: (r) => fmtDate(r.due_date) }, { key: 'total_minor', label: 'Total', align: 'right', render: (r) => money(r.total_minor) }, { key: 'outstanding_minor', label: 'Outstanding', align: 'right', render: (r) => money(r.outstanding_minor) }, { key: 'display_status', label: 'Status', render: (r) => <StatusBadge s={r.display_status} /> },
        { key: 'p', label: '', render: (r) => (s.can('finance.manage') && Number(r.outstanding_minor) > 0 ? <Button small variant="secondary" onClick={() => setPay(r)}>Record payment</Button> : null) }]} rows={d} />}</Async></Card>
    {pay && <RecordPayment inv={pay} onDone={() => { setPay(null); refresh(); }} />}
    <Card title="Reconciliation (today)"><Async q={rec} what="reconciliation">{(d) => <>
      <Table cols={[{ key: 'method', label: 'Method' }, { key: 'count', label: 'Payments' }, { key: 'total_minor', label: 'Total', align: 'right', render: (r) => money(r.total_minor) }]} rows={d.byMethod} empty="No payments recorded today." />
      <p>{d.discrepancies.length ? <span className="alert error">{d.discrepancies.length} ledger/invoice discrepancies</span> : '✔ Ledger agrees with invoices and payments for every student.'}</p></>}</Async></Card>
  </>;
}

function RecordPayment({ inv, onDone }: { inv: any; onDone: () => void }) {
  const [amount, setAmount] = useState(String(Number(inv.outstanding_minor) / 100));
  const [method, setMethod] = useState('cash');
  const [key] = useState(() => crypto.randomUUID()); // one key per form: a double-click cannot double-charge
  const act = useAction();
  const [receipt, setReceipt] = useState<any>(null);
  return <Card title={`Record payment — ${inv.number}`}>
    <form onSubmit={async (e) => { e.preventDefault(); let r: any; if (await act.run(async () => { r = await api('/finance/payments', { body: { studentId: inv.student_id, invoiceId: inv.id, amountMinor: Math.round(Number(amount) * 100), method, idempotencyKey: key } }); setReceipt(r); }, 'Payment recorded.')) { void r; } }}>
      <div className="row"><Input label="Amount (INR)" type="number" step="0.01" min="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} required /><Select label="Method" value={method} onChange={(e) => setMethod(e.target.value)} options={['cash', 'cheque', 'bank_transfer'].map((v) => ({ value: v, label: v.replace('_', ' ') }))} />
        <Button type="submit" busy={act.busy} disabled={!!receipt}>Record</Button><Button variant="secondary" onClick={onDone}>{receipt ? 'Done' : 'Cancel'}</Button></div>{act.node}
      {receipt && <p>Receipt <strong>{receipt.receiptNo}</strong> issued{receipt.idempotentReplay ? ' (already recorded — duplicate ignored)' : ''}.</p>}</form></Card>;
}
