'use client';
import { useState } from 'react';
import { api, fmtDate, money } from '@/lib/api';
import { useAsync, useSession } from '@/lib/hooks';
import { Alert, Async, Badge, Button, Card, Select, Stat, StatusBadge, Table, useAction } from '@/components/ui';

export default function Accounting() {
  const tb = useAsync(() => api<any>('/accounting/trial-balance'));
  const today = new Date().toISOString().slice(0, 10), y0 = `${new Date().getFullYear()}-01-01`;
  const is = useAsync(() => api<any>(`/accounting/reports/income-statement?from=${y0}&to=${today}`));
  const bs = useAsync(() => api<any>(`/accounting/reports/balance-sheet?asOf=${today}`));
  const bills = useAsync(() => api<any>('/accounting/payables'));
  const je = useAsync(() => api<any[]>('/accounting/journals?limit=12'));
  const rec = useAsync(() => api<any>('/accounting/bank-reconciliation'));
  const years = useAsync(() => api<any[]>('/academic-years'));
  const s = useSession();
  const act = useAction();
  const [yid, setYid] = useState('');
  const bva = useAsync(() => (yid ? api<any[]>(`/accounting/budget-vs-actual?academicYearId=${yid}`) : Promise.resolve([])), [yid]);
  return <><h1>Accounting</h1><p className="sub">Double-entry ledger, posted automatically from invoices, payments, refunds, payroll and vendor bills. Entries cannot be edited — only reversed by a second person.</p>
    <Async q={tb} what="trial balance">{(d) => <div className="grid g4" style={{ marginBottom: '1rem' }}><Stat label="Trial balance" value={d.balanced ? 'Balanced' : 'OUT OF BALANCE'} tone={d.balanced ? 'good' : 'bad'} /><Stat label="Total debits" value={money(d.totalDebit)} /><Stat label="Total credits" value={money(d.totalCredit)} /></div>}</Async>
    {act.node}
    <div className="grid g2">
      <Card title="Income & expenditure (this year)"><Async q={is} what="statement">{(d) => <><Table cols={[{ key: 'name', label: 'Account' }, { key: 'amount', label: 'Amount', align: 'right', render: (r) => money(r.amount) }]} rows={[...d.income.map((r: any) => ({ ...r, name: `Income — ${r.name}` })), ...d.expenses.map((r: any) => ({ ...r, name: `Expense — ${r.name}` }))]} empty="No postings yet." />
        <p><strong>Surplus / (deficit): {money(d.surplus)}</strong></p></>}</Async></Card>
      <Card title="Balance sheet (today)"><Async q={bs} what="balance sheet">{(d) => <><Table cols={[{ key: 'name', label: 'Account' }, { key: 'amount', label: 'Amount', align: 'right', render: (r) => money(r.amount) }]} rows={[...d.assets.map((r: any) => ({ ...r, name: `Asset — ${r.name}` })), ...d.liabilities.map((r: any) => ({ ...r, name: `Liability — ${r.name}` })), { name: 'Current surplus', amount: d.currentSurplus }]} />
        <p>{d.balanced ? <Badge tone="good">balanced</Badge> : <Badge tone="bad">does not balance</Badge>} Assets {money(d.totalAssets)} = Liabilities + funds {money(d.totalLiabilitiesAndEquity)}</p></>}</Async></Card>
    </div>
    <Card title="Accounts payable"><Async q={bills} what="bills">{(d) => <><p>Open bills: <strong>{money(d.total)}</strong></p><Table cols={[{ key: 'number', label: 'Bill' }, { key: 'supplier', label: 'Supplier' }, { key: 'due_date', label: 'Due', render: (r) => fmtDate(r.due_date) }, { key: 'days_overdue', label: 'Days late', render: (r) => (r.days_overdue > 0 ? r.days_overdue : '—') }, { key: 'total_minor', label: 'Amount', align: 'right', render: (r) => money(r.total_minor) },
      { key: 'a', label: '', render: (r) => (s.can('accounting.approve') ? <Button small variant="secondary" onClick={async () => { if (await act.run(() => api(`/accounting/bills/${r.id}/pay`, { body: {} }), 'Bill marked paid and posted to the ledger.')) { bills.reload(); tb.reload(); } }}>Pay</Button> : null) }]} rows={d.bills} empty="No open bills." /></>}</Async></Card>
    <Card title="Budget vs actual"><Async q={years} what="years">{(d) => <Select label="Academic year" value={yid} onChange={(e) => setYid(e.target.value)} placeholder="Choose…" options={d.map((y) => ({ value: y.id, label: y.name }))} />}</Async>
      {yid && <Async q={bva} what="budgets" empty={(d) => !d.length}>{(d) => <Table cols={[{ key: 'cost_centre_name', label: 'Cost centre' }, { key: 'name', label: 'Account' }, { key: 'budget', label: 'Budget', align: 'right', render: (r) => money(r.budget) }, { key: 'actual', label: 'Actual', align: 'right', render: (r) => money(r.actual) }, { key: 'usedPercent', label: 'Used', render: (r) => <span style={{ color: r.overBudget ? 'var(--bad)' : undefined }}>{r.usedPercent}%{r.overBudget ? ' over' : ''}</span> }]} rows={d} />}</Async>}</Card>
    <Card title="Bank reconciliation" action={s.can('accounting.manage') ? <Button small onClick={async () => { if (await act.run(async () => { const r = await api<any>('/accounting/bank-reconciliation/auto-match', { method: 'POST', body: {} }); void r; }, 'Auto-match complete (exact amount + receipt reference).')) rec.reload(); }}>Auto-match</Button> : undefined}>
      <Async q={rec} what="reconciliation">{(d) => <><p>Book balance (bank account 1010): <strong>{money(d.bookBalance)}</strong> · statement total loaded: <strong>{money(d.statementTotal)}</strong></p>
        <div className="grid g2"><div><h3>Statement lines not matched</h3><Table cols={[{ key: 'stmt_date', label: 'Date', render: (r) => fmtDate(r.stmt_date) }, { key: 'description', label: 'Description' }, { key: 'amount_minor', label: 'Amount', align: 'right', render: (r) => money(r.amount_minor) }]} rows={d.unmatchedStatement.slice(0, 10)} empty="All matched." /></div>
          <div><h3>Receipts not on the statement</h3><Table cols={[{ key: 'receipt_no', label: 'Receipt' }, { key: 'method', label: 'Method' }, { key: 'amount_minor', label: 'Amount', align: 'right', render: (r) => money(r.amount_minor) }]} rows={d.unmatchedPayments.slice(0, 10)} empty="All receipts appear on the statement." /></div></div></>}</Async></Card>
    <Card title="Recent journal entries"><Async q={je} what="journals" empty={(d) => !d.length}>{(d) => <Table cols={[{ key: 'entry_no', label: 'JE' }, { key: 'entry_date', label: 'Date', render: (r) => fmtDate(r.entry_date) }, { key: 'source', label: 'Source', render: (r) => <StatusBadge s={r.source === 'reversal' ? 'warn' : 'neutral'} /> }, { key: 'memo', label: 'Memo' }, { key: 'amount', label: 'Amount', align: 'right', render: (r) => money(r.amount) }]} rows={d} />}</Async></Card>
    <Alert kind="info">Manual journals, new accounts, cost centres, budgets and bank-statement import are available through the API (see docs/API.md).</Alert></>;
}
