create table staff_profiles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  user_id uuid not null,
  campus_id uuid not null,
  employee_no text not null,
  designation text not null,
  department text,
  join_date date not null,
  contract_end date,
  qualifications text,
  status text not null default 'active' check (status in ('active','exited')),
  exited_on date,
  foreign key (tenant_id, user_id) references users(tenant_id, id),
  foreign key (tenant_id, campus_id) references campuses(tenant_id, id),
  unique (tenant_id, user_id),
  unique (tenant_id, employee_no),
  unique (tenant_id, id)
);
create table staff_documents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  staff_id uuid not null,
  kind text not null,
  reference text,
  expires_on date,
  foreign key (tenant_id, staff_id) references staff_profiles(tenant_id, id)
);
create table staff_attendance (
  tenant_id uuid not null references tenants(id),
  staff_id uuid not null,
  att_date date not null,
  status text not null check (status in ('present','absent','late','on_leave')),
  marked_by uuid not null,
  primary key (staff_id, att_date),
  foreign key (tenant_id, staff_id) references staff_profiles(tenant_id, id)
);
create table staff_leave_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  staff_id uuid not null,
  kind text not null check (kind in ('casual','sick','earned','unpaid')),
  from_date date not null,
  to_date date not null,
  reason text,
  status text not null default 'requested' check (status in ('requested','approved','rejected','cancelled')),
  decided_by uuid,
  decided_at timestamptz,
  check (to_date >= from_date),
  foreign key (tenant_id, staff_id) references staff_profiles(tenant_id, id)
);
create table salary_structures (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  staff_id uuid not null,
  effective_from date not null,
  basic_minor bigint not null check (basic_minor > 0),
  allowances jsonb not null default '[]'::jsonb,
  deductions jsonb not null default '[]'::jsonb,
  created_by uuid not null,
  foreign key (tenant_id, staff_id) references staff_profiles(tenant_id, id),
  unique (staff_id, effective_from)
);
create table payroll_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  month text not null check (month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  status text not null default 'draft' check (status in ('draft','approved','paid')),
  created_by uuid not null,
  approved_by uuid,
  approved_at timestamptz,
  paid_at timestamptz,
  unique (tenant_id, month),
  unique (tenant_id, id)
);
create table payslips (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  run_id uuid not null,
  staff_id uuid not null,
  basic_minor bigint not null,
  allowances_minor bigint not null,
  deductions_minor bigint not null,
  absence_days int not null default 0,
  absence_deduction_minor bigint not null default 0,
  net_minor bigint not null,
  detail jsonb not null,
  foreign key (tenant_id, run_id) references payroll_runs(tenant_id, id),
  foreign key (tenant_id, staff_id) references staff_profiles(tenant_id, id),
  unique (run_id, staff_id)
);

create table clinic_visits (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  student_id uuid not null,
  visited_at timestamptz not null default now(),
  complaint text not null,
  treatment text,
  outcome text not null check (outcome in ('returned_to_class','rested','sent_home','referred','admitted')),
  recorded_by uuid not null,
  foreign key (tenant_id, student_id) references students(tenant_id, id)
);
create table medications (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  student_id uuid not null,
  name text not null,
  dose text not null,
  schedule text not null,
  start_date date not null,
  end_date date,
  guardian_consent boolean not null,
  prescribed_by text,
  foreign key (tenant_id, student_id) references students(tenant_id, id),
  unique (tenant_id, id)
);
create table medication_log (
  id bigserial primary key,
  tenant_id uuid not null references tenants(id),
  medication_id uuid not null,
  given_at timestamptz not null default now(),
  given_by uuid not null,
  note text,
  foreign key (tenant_id, medication_id) references medications(tenant_id, id)
);
create table medicine_stock (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  campus_id uuid not null,
  name text not null,
  qty int not null check (qty >= 0),
  expires_on date not null,
  foreign key (tenant_id, campus_id) references campuses(tenant_id, id)
);
create table counselling_referrals (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  student_id uuid not null,
  referred_by uuid not null,
  reason text not null,
  status text not null default 'open' check (status in ('open','scheduled','closed')),
  confidential_notes text,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, student_id) references students(tenant_id, id),
  unique (tenant_id, id)
);

create table visitors (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  campus_id uuid not null,
  kind text not null check (kind in ('visitor','contractor','vendor','guardian')),
  full_name text not null,
  phone text,
  purpose text not null,
  host text not null,
  id_type text not null,
  id_last4 text not null check (id_last4 ~ '^[A-Za-z0-9]{4}$'),
  badge_no text not null,
  checked_in_at timestamptz not null default now(),
  checked_out_at timestamptz,
  checked_in_by uuid not null,
  foreign key (tenant_id, campus_id) references campuses(tenant_id, id)
);
create unique index one_badge_on_site on visitors (tenant_id, campus_id, badge_no) where checked_out_at is null;
create table drills (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  campus_id uuid not null,
  kind text not null check (kind in ('fire','evacuation','lockdown','earthquake')),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  headcount_expected int,
  headcount_assembled int,
  notes text,
  started_by uuid not null,
  foreign key (tenant_id, campus_id) references campuses(tenant_id, id)
);
do $$
declare t text;
begin
  foreach t in array array['staff_profiles','staff_documents','staff_attendance','staff_leave_requests','salary_structures','payroll_runs','payslips','clinic_visits','medications','medication_log','medicine_stock','counselling_referrals','visitors','drills']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy tenant_isolation on %I using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  end loop;
end $$;
create trigger medication_log_immutable before update or delete on medication_log for each row execute function audit_log_immutable();
create or replace function payslip_locked() returns trigger language plpgsql as $$
begin
  if exists (select 1 from payroll_runs r where r.id = coalesce(new.run_id, old.run_id) and r.status <> 'draft') then raise exception 'payslips of an approved run are immutable'; end if;
  return coalesce(new, old);
end $$;
create trigger payslips_locked before update or delete on payslips for each row execute function payslip_locked();
