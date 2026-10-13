create extension if not exists fuzzystrmatch;
alter table file_links drop constraint file_links_entity_type_check;
alter table file_links add constraint file_links_entity_type_check check (entity_type in ('lesson','submission','student_document'));

create table student_documents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  student_id uuid not null,
  kind text not null,
  reference text,
  issued_on date,
  expires_on date,
  file_id uuid,
  verified_by uuid,
  verified_at timestamptz,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, student_id) references students(tenant_id, id),
  foreign key (tenant_id, file_id) references files(tenant_id, id)
);
create table previous_schools (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  student_id uuid not null,
  school_name text not null,
  last_grade text,
  from_year text,
  to_year text,
  summary text,
  foreign key (tenant_id, student_id) references students(tenant_id, id)
);
create table profile_corrections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  student_id uuid not null,
  field text not null check (field in ('first_name','last_name','date_of_birth','gender')),
  old_value text,
  new_value text not null,
  reason text not null,
  requested_by uuid not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  decided_by uuid,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, student_id) references students(tenant_id, id)
);
create table promotion_rules (
  tenant_id uuid not null references tenants(id),
  academic_year_id uuid not null,
  min_overall_percent numeric(5,2) not null default 40,
  min_subject_percent numeric(5,2) not null default 33,
  max_failed_subjects int not null default 2,
  min_attendance_percent numeric(5,2) not null default 0,
  primary key (tenant_id, academic_year_id),
  foreign key (tenant_id, academic_year_id) references academic_years(tenant_id, id)
);
create table withdrawal_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  student_id uuid not null,
  kind text not null check (kind in ('withdrawal','transfer_out')),
  reason text not null,
  destination_school text,
  effective_date date not null,
  requested_by uuid not null,
  status text not null default 'requested' check (status in ('requested','approved','rejected','completed','cancelled')),
  decided_by uuid,
  decided_at timestamptz,
  completed_at timestamptz,
  fees_waived_by uuid,
  clearance jsonb,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, student_id) references students(tenant_id, id),
  unique (tenant_id, id)
);
create unique index one_open_withdrawal on withdrawal_requests (student_id) where status in ('requested','approved');
do $$
declare t text;
begin
  foreach t in array array['student_documents','previous_schools','profile_corrections','promotion_rules','withdrawal_requests']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy tenant_isolation on %I using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  end loop;
end $$;
