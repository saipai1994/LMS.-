-- All money is stored as integer minor units (e.g. paise).
create table fee_heads (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  code text not null,
  name text not null,
  unique (tenant_id, code),
  unique (tenant_id, id)
);
create table fee_structures (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  academic_year_id uuid not null,
  grade_level_id uuid not null,
  residence_type text check (residence_type in ('boarder','day_scholar')), -- null = applies to all
  head_id uuid not null,
  amount_minor bigint not null check (amount_minor > 0),
  foreign key (tenant_id, academic_year_id) references academic_years(tenant_id, id),
  foreign key (tenant_id, grade_level_id) references grade_levels(tenant_id, id),
  foreign key (tenant_id, head_id) references fee_heads(tenant_id, id),
  unique nulls not distinct (academic_year_id, grade_level_id, residence_type, head_id)
);

create table invoices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  student_id uuid not null,
  number text not null,
  batch_key text,
  issue_date date not null default current_date,
  due_date date not null,
  status text not null default 'issued' check (status in ('issued','void')),
  total_minor bigint not null check (total_minor > 0),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, student_id) references students(tenant_id, id),
  unique (tenant_id, number),
  unique (tenant_id, id)
);
create unique index invoices_batch on invoices (student_id, batch_key) where batch_key is not null;
create table invoice_lines (
  tenant_id uuid not null references tenants(id),
  invoice_id uuid not null,
  line_no int not null,
  description text not null,
  head_id uuid,
  amount_minor bigint not null check (amount_minor > 0),
  primary key (invoice_id, line_no),
  foreign key (tenant_id, invoice_id) references invoices(tenant_id, id)
);
create table invoice_adjustments (  -- credit notes / approved waivers
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  invoice_id uuid not null,
  amount_minor bigint not null check (amount_minor > 0),
  reason text not null,
  approved_by uuid not null,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, invoice_id) references invoices(tenant_id, id)
);

create table payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  student_id uuid not null,
  receipt_no text not null,
  method text not null check (method in ('cash','cheque','bank_transfer','online_demo')),
  amount_minor bigint not null check (amount_minor > 0),
  reference text,
  idempotency_key text not null,
  request_hash text not null,
  received_by uuid,
  received_at timestamptz not null default now(),
  foreign key (tenant_id, student_id) references students(tenant_id, id),
  unique (tenant_id, idempotency_key),
  unique (tenant_id, receipt_no),
  unique (tenant_id, id)
);
create table payment_allocations ( -- negative amounts are refund reversals
  id bigserial primary key,
  tenant_id uuid not null references tenants(id),
  payment_id uuid not null,
  invoice_id uuid not null,
  amount_minor bigint not null check (amount_minor <> 0),
  created_at timestamptz not null default now(),
  foreign key (tenant_id, payment_id) references payments(tenant_id, id),
  foreign key (tenant_id, invoice_id) references invoices(tenant_id, id)
);
create index alloc_invoice on payment_allocations (invoice_id);

create table refunds (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  payment_id uuid not null,
  amount_minor bigint not null check (amount_minor > 0),
  reason text not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  requested_by uuid not null,
  decided_by uuid,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, payment_id) references payments(tenant_id, id),
  unique (tenant_id, id)
);

create table ledger_entries (  -- append-only student ledger; balance = sum(debit - credit)
  id bigserial primary key,
  tenant_id uuid not null references tenants(id),
  student_id uuid not null,
  entry_date date not null default current_date,
  kind text not null check (kind in ('invoice','payment','refund','credit_note','void')),
  ref_id uuid not null,
  debit_minor bigint not null default 0 check (debit_minor >= 0),
  credit_minor bigint not null default 0 check (credit_minor >= 0),
  description text not null,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, student_id) references students(tenant_id, id),
  check ((debit_minor > 0) <> (credit_minor > 0))
);
create index ledger_student on ledger_entries (student_id, id);

create table payment_intents (  -- online payment attempts (demo gateway only; no real provider configured)
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  invoice_id uuid not null,
  student_id uuid not null,
  amount_minor bigint not null check (amount_minor > 0),
  provider text not null default 'demo',
  status text not null default 'pending' check (status in ('pending','succeeded','failed','needs_review')),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, invoice_id) references invoices(tenant_id, id),
  foreign key (tenant_id, student_id) references students(tenant_id, id),
  unique (tenant_id, id)
);
create table webhook_events (
  tenant_id uuid not null references tenants(id),
  event_id text not null,
  provider text not null,
  received_at timestamptz not null default now(),
  primary key (tenant_id, event_id)
);

do $$
declare t text;
begin
  foreach t in array array['fee_heads','fee_structures','invoices','invoice_lines','invoice_adjustments','payments','payment_allocations','refunds','ledger_entries','payment_intents','webhook_events']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy tenant_isolation on %I using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  end loop;
end $$;
create trigger ledger_immutable before update or delete on ledger_entries for each row execute function audit_log_immutable();
