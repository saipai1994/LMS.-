import { Tx } from '../db/db.service';

/** Default chart of accounts, created lazily the first time a tenant posts. Tenants may add accounts. */
export const DEFAULT_CHART: [string, string, 'asset' | 'liability' | 'equity' | 'income' | 'expense', boolean][] = [
  ['1000', 'Cash on hand', 'asset', false], ['1010', 'Bank – main account', 'asset', true], ['1100', 'Fees receivable', 'asset', false], ['1200', 'Inventory', 'asset', false],
  ['2000', 'Accounts payable', 'liability', false], ['2100', 'Salaries payable', 'liability', false], ['2150', 'Statutory deductions payable', 'liability', false],
  ['3000', 'Accumulated fund', 'equity', false],
  ['4000', 'Tuition fee income', 'income', false], ['4010', 'Boarding & mess income', 'income', false], ['4020', 'Other fee income', 'income', false], ['4900', 'Scholarships & discounts', 'income', false],
  ['5000', 'Salaries & wages', 'expense', false], ['5100', 'Procurement & supplies', 'expense', false], ['5200', 'Repairs & maintenance', 'expense', false], ['5900', 'Fee write-offs', 'expense', false],
];
export const INCOME_BY_HEAD: Record<string, string> = { TUI: '4000', BRD: '4010' };
export const CASH_BY_METHOD: Record<string, string> = { cash: '1000', cheque: '1010', bank_transfer: '1010', online_demo: '1010' };

export async function ensureChart(tx: Tx, tenantId: string) {
  const has = await tx.query('select 1 from accounts limit 1');
  if (has.rowCount) return;
  for (const [code, name, type, bank] of DEFAULT_CHART) await tx.query('insert into accounts(tenant_id, code, name, type, is_bank) values ($1,$2,$3,$4,$5)', [tenantId, code, name, type, bank]);
}

export interface JournalLine { account: string; debit?: number; credit?: number; costCentre?: string | null; memo?: string }
export interface JournalInput { date?: string; memo: string; source: 'manual' | 'invoice' | 'payment' | 'refund' | 'adjustment' | 'payroll' | 'payroll_payment' | 'vendor_bill' | 'bill_payment' | 'reversal'; sourceRef?: string | null; postedBy?: string | null; reversalOf?: string | null; lines: JournalLine[] }

/** Posts a balanced entry. Idempotent per (source, sourceRef): posting the same business event twice is a no-op. */
export async function postJournal(tx: Tx, tenantId: string, e: JournalInput): Promise<string | null> {
  await ensureChart(tx, tenantId);
  if (e.sourceRef) {
    const dup = await tx.query('select id from journal_entries where source = $1 and source_ref = $2', [e.source, e.sourceRef]);
    if (dup.rowCount) return dup.rows[0].id;
  }
  const lines = e.lines.filter((l) => (l.debit ?? 0) > 0 || (l.credit ?? 0) > 0);
  const d = lines.reduce((t, l) => t + (l.debit ?? 0), 0), c = lines.reduce((t, l) => t + (l.credit ?? 0), 0);
  if (!lines.length) return null;
  if (d !== c) throw new Error(`unbalanced journal (${d} vs ${c}) for ${e.source}`);
  const { rows: [no] } = await tx.query(`insert into document_sequences(tenant_id, key, prefix, next_value) values ($1,'journal','JE-',2) on conflict (tenant_id, key) do update set next_value = document_sequences.next_value + 1 returning next_value - 1 as v`, [tenantId]);
  const { rows: [je] } = await tx.query('insert into journal_entries(tenant_id, entry_no, entry_date, memo, source, source_ref, posted_by, reversal_of) values ($1,$2,coalesce($3::date, current_date),$4,$5,$6,$7,$8) returning id', [tenantId, no.v, e.date ?? null, e.memo, e.source, e.sourceRef ?? null, e.postedBy ?? null, e.reversalOf ?? null]);
  const ids = new Map((await tx.query('select code, id from accounts')).rows.map((r) => [r.code as string, r.id as string]));
  let n = 1;
  for (const l of lines) {
    const acc = ids.get(l.account);
    if (!acc) throw new Error(`unknown account ${l.account}`);
    await tx.query('insert into journal_lines(tenant_id, entry_id, line_no, account_id, debit_minor, credit_minor, cost_centre, memo) values ($1,$2,$3,$4,$5,$6,$7,$8)', [tenantId, je.id, n++, acc, l.debit ?? 0, l.credit ?? 0, l.costCentre ?? null, l.memo ?? null]);
  }
  return je.id;
}

/** Posts the mirror image of an existing entry. */
export async function reverseJournal(tx: Tx, tenantId: string, entryId: string, by: string | null, memo: string, sourceRef: string | null = null): Promise<string | null> {
  const lines = (await tx.query('select a.code, l.debit_minor, l.credit_minor, l.cost_centre from journal_lines l join accounts a on a.id = l.account_id where l.entry_id = $1 order by l.line_no', [entryId])).rows;
  return postJournal(tx, tenantId, { memo, source: 'reversal', sourceRef, postedBy: by, reversalOf: entryId, lines: lines.map((l) => ({ account: l.code, debit: Number(l.credit_minor), credit: Number(l.debit_minor), costCentre: l.cost_centre })) });
}
