create table fee_settings (
  tenant_id uuid primary key references tenants(id),
  sibling_discount_percent numeric(5,2) not null default 0 check (sibling_discount_percent between 0 and 100),
  sibling_head_code text not null default 'TUI',
  late_fee_flat_minor bigint not null default 0 check (late_fee_flat_minor >= 0),
  late_fee_grace_days int not null default 7 check (late_fee_grace_days >= 0),
  configured_by uuid
);
create table student_concessions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  student_id uuid not null,
  academic_year_id uuid not null,
  kind text not null check (kind in ('scholarship','concession','staff_ward')),
  basis text not null check (basis in ('percent','fixed')),
  value numeric(12,2) not null check (value > 0),
  head_code text,                       -- null = applies to the whole invoice
  reason text not null,
  approved_by uuid not null,
  status text not null default 'active' check (status in ('active','revoked')),
  created_at timestamptz not null default now(),
  check (basis <> 'percent' or value <= 100),
  foreign key (tenant_id, student_id) references students(tenant_id, id),
  foreign key (tenant_id, academic_year_id) references academic_years(tenant_id, id)
);
alter table invoice_adjustments add column source text not null default 'credit_note' check (source in ('credit_note','concession','sibling_discount','write_off'));

create table enquiries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  campus_id uuid not null,
  contact_name text not null,
  email citext,
  phone text,
  child_name text not null,
  interest_grade_level_id uuid,
  source text not null default 'walk_in' check (source in ('walk_in','website','referral','phone','event')),
  status text not null default 'new' check (status in ('new','contacted','visit_scheduled','applied','lost')),
  notes text,
  assigned_to uuid,
  application_id uuid,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, campus_id) references campuses(tenant_id, id),
  foreign key (tenant_id, interest_grade_level_id) references grade_levels(tenant_id, id),
  foreign key (tenant_id, assigned_to) references users(tenant_id, id),
  foreign key (tenant_id, application_id) references admission_applications(tenant_id, id),
  check (email is not null or phone is not null)
);
create table admission_assessments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  application_id uuid not null,
  kind text not null check (kind in ('entrance_test','interview')),
  scheduled_at timestamptz not null,
  score numeric(6,2),
  max_score numeric(6,2) not null default 100,
  panel text,
  notes text,
  recorded_by uuid,
  check (score is null or (score >= 0 and score <= max_score)),
  foreign key (tenant_id, application_id) references admission_applications(tenant_id, id)
);
create table admission_documents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  application_id uuid not null,
  kind text not null,
  file_id uuid,
  verified_by uuid,
  verified_at timestamptz,
  rejected_reason text,
  created_by uuid not null,
  foreign key (tenant_id, application_id) references admission_applications(tenant_id, id),
  foreign key (tenant_id, file_id) references files(tenant_id, id)
);
create table admission_offers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  application_id uuid not null unique,
  token_hash text not null unique,
  terms text not null,
  expires_on date not null,
  decision text check (decision in ('accepted','declined')),
  decided_at timestamptz,
  decided_by_name text,
  consent_version text,
  consent_ip text,
  created_by uuid not null,
  foreign key (tenant_id, application_id) references admission_applications(tenant_id, id)
);
create table admission_consents (   -- evidence that acceptance was agreed by a guardian (online or on paper)
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  application_id uuid not null,
  method text not null check (method in ('online_offer','paper_form')),
  reference text not null,
  recorded_by uuid,
  at timestamptz not null default now(),
  foreign key (tenant_id, application_id) references admission_applications(tenant_id, id)
);
do $$
declare t text;
begin
  foreach t in array array['fee_settings','student_concessions','enquiries','admission_assessments','admission_documents','admission_offers','admission_consents']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy tenant_isolation on %I using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  end loop;
end $$;
