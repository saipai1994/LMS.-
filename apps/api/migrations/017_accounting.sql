create table accounts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  code text not null,
  name text not null,
  type text not null check (type in ('asset','liability','equity','income','expense')),
  is_bank boolean not null default false,
  is_active boolean not null default true,
  unique (tenant_id, code),
  unique (tenant_id, id)
);
create table cost_centres (
  tenant_id uuid not null references tenants(id),
  code text not null,
  name text not null,
  primary key (tenant_id, code)
);
create table journal_entries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  entry_no bigint not null,
  entry_date date not null,
  memo text not null,
  source text not null check (source in ('manual','invoice','payment','refund','adjustment','payroll','payroll_payment','vendor_bill','bill_payment','reversal')),
  source_ref text,
  posted_by uuid,
  reversal_of uuid,
  created_at timestamptz not null default now(),
  unique (tenant_id, entry_no),
  unique (tenant_id, id),
  foreign key (tenant_id, reversal_of) references journal_entries(tenant_id, id)
);
create unique index journal_source_once on journal_entries (tenant_id, source, source_ref) where source_ref is not null;
create table journal_lines (
  tenant_id uuid not null references tenants(id),
  entry_id uuid not null,
  line_no int not null,
  account_id uuid not null,
  debit_minor bigint not null default 0 check (debit_minor >= 0),
  credit_minor bigint not null default 0 check (credit_minor >= 0),
  cost_centre text,
  memo text,
  primary key (entry_id, line_no),
  check ((debit_minor > 0) <> (credit_minor > 0)),
  foreign key (tenant_id, entry_id) references journal_entries(tenant_id, id),
  foreign key (tenant_id, account_id) references accounts(tenant_id, id),
  foreign key (tenant_id, cost_centre) references cost_centres(tenant_id, code)
);
create index journal_lines_account on journal_lines (account_id);

-- Every entry must balance when the transaction commits.
create function journal_balanced() returns trigger language plpgsql as $$
declare d bigint; c bigint;
begin
  select coalesce(sum(debit_minor),0), coalesce(sum(credit_minor),0) into d, c from journal_lines where entry_id = new.entry_id;
  if d <> c then raise exception 'journal entry % is unbalanced (debit %, credit %)', new.entry_id, d, c; end if;
  return null;
end $$;
create constraint trigger journal_balanced after insert on journal_lines deferrable initially deferred for each row execute function journal_balanced();
create trigger journal_entries_immutable before update or delete on journal_entries for each row execute function audit_log_immutable();
create trigger journal_lines_immutable before update or delete on journal_lines for each row execute function audit_log_immutable();

create table budgets (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  academic_year_id uuid not null,
  cost_centre text not null,
  account_id uuid not null,
  amount_minor bigint not null check (amount_minor >= 0),
  foreign key (tenant_id, academic_year_id) references academic_years(tenant_id, id),
  foreign key (tenant_id, cost_centre) references cost_centres(tenant_id, code),
  foreign key (tenant_id, account_id) references accounts(tenant_id, id),
  unique (academic_year_id, cost_centre, account_id)
);
create table vendor_bills (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  number text not null,
  supplier_id uuid not null,
  po_id uuid,
  bill_date date not null,
  due_date date not null,
  total_minor bigint not null check (total_minor > 0),
  status text not null default 'open' check (status in ('open','paid')),
  paid_on date,
  created_by uuid not null,
  foreign key (tenant_id, supplier_id) references suppliers(tenant_id, id),
  foreign key (tenant_id, po_id) references purchase_orders(tenant_id, id),
  unique (tenant_id, supplier_id, number),
  unique (tenant_id, id)
);
create table bank_statement_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  stmt_date date not null,
  description text not null,
  amount_minor bigint not null check (amount_minor <> 0),   -- + inflow, - outflow
  reference text,
  matched_payment_id uuid,
  matched_at timestamptz,
  foreign key (tenant_id, matched_payment_id) references payments(tenant_id, id)
);
create unique index statement_line_unique on bank_statement_lines (tenant_id, stmt_date, amount_minor, coalesce(reference, ''), description);
create unique index one_statement_per_payment on bank_statement_lines (matched_payment_id) where matched_payment_id is not null;
do $$
declare t text;
begin
  foreach t in array array['accounts','cost_centres','journal_entries','journal_lines','budgets','vendor_bills','bank_statement_lines']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy tenant_isolation on %I using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  end loop;
end $$;
