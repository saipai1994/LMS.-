create table attendance_records (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  student_id uuid not null,
  section_id uuid not null,
  att_date date not null,
  period int not null default 0 check (period between 0 and 20), -- 0 = full-day
  status text not null check (status in ('present','absent','late','excused')),
  reason text,
  marked_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (tenant_id, student_id) references students(tenant_id, id),
  foreign key (tenant_id, section_id) references sections(tenant_id, id),
  unique (student_id, att_date, period),
  unique (tenant_id, id)
);
create index attendance_section_date on attendance_records (section_id, att_date);

create table attendance_corrections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  record_id uuid not null,
  requested_by uuid not null,
  new_status text not null check (new_status in ('present','absent','late','excused')),
  reason text not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  decided_by uuid,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, record_id) references attendance_records(tenant_id, id)
);

-- In-app notification centre. Other channels (email/SMS/push) are not configured.
create table notifications (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  user_id uuid not null,
  kind text not null,
  title text not null,
  body text not null,
  channel text not null default 'in_app' check (channel in ('in_app')),
  created_at timestamptz not null default now(),
  read_at timestamptz,
  foreign key (tenant_id, user_id) references users(tenant_id, id)
);
create index notifications_user on notifications (user_id, created_at desc);

create table authorized_pickups (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  student_id uuid not null,
  full_name text not null,
  relationship text not null,
  id_hint text,                -- e.g. last 4 digits of ID document, for visual verification
  valid_from date not null default current_date,
  valid_until date,
  active boolean not null default true,
  added_by uuid not null,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, student_id) references students(tenant_id, id),
  unique (tenant_id, id)
);

create table pickup_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  student_id uuid not null,
  event_date date not null default current_date,
  guardian_id uuid,
  authorized_pickup_id uuid,
  collected_by_name text not null,
  id_verified boolean not null,
  recorded_by uuid not null,
  at timestamptz not null default now(),
  foreign key (tenant_id, student_id) references students(tenant_id, id),
  foreign key (tenant_id, guardian_id) references guardians(tenant_id, id),
  foreign key (tenant_id, authorized_pickup_id) references authorized_pickups(tenant_id, id),
  check ((guardian_id is not null) <> (authorized_pickup_id is not null)),
  unique (student_id, event_date)  -- one handover per student per day (duplicate scans rejected)
);

do $$
declare t text;
begin
  foreach t in array array['attendance_records','attendance_corrections','notifications','authorized_pickups','pickup_events']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy tenant_isolation on %I using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  end loop;
end $$;
