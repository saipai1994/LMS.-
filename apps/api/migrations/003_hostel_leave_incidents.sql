create table hostels (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  campus_id uuid not null,
  name text not null,
  foreign key (tenant_id, campus_id) references campuses(tenant_id, id),
  unique (tenant_id, campus_id, name),
  unique (tenant_id, id)
);
create table rooms (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  hostel_id uuid not null,
  floor int not null default 0,
  number text not null,
  foreign key (tenant_id, hostel_id) references hostels(tenant_id, id),
  unique (hostel_id, number),
  unique (tenant_id, id)
);
create table beds (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  room_id uuid not null,
  label text not null,
  out_of_service boolean not null default false,
  foreign key (tenant_id, room_id) references rooms(tenant_id, id),
  unique (room_id, label),
  unique (tenant_id, id)
);
-- A bed holds at most one student at a time; a student holds at most one bed at a time.
create table bed_assignments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  student_id uuid not null,
  bed_id uuid not null,
  effective_from date not null,
  effective_to date,
  foreign key (tenant_id, student_id) references students(tenant_id, id),
  foreign key (tenant_id, bed_id) references beds(tenant_id, id),
  check (effective_to is null or effective_to >= effective_from),
  exclude using gist (student_id with =, daterange(effective_from, effective_to, '[]') with &&),
  exclude using gist (bed_id with =, daterange(effective_from, effective_to, '[]') with &&)
);

create table leave_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  student_id uuid not null,
  requested_by uuid not null,
  leave_type text not null check (leave_type in ('weekend','home_visit','overnight','outing','emergency')),
  destination text not null,
  responsible_adult text not null,
  depart_at timestamptz not null,
  expected_return_at timestamptz not null,
  status text not null default 'requested' check (status in ('requested','approved','rejected','cancelled','out','returned')),
  decided_by uuid,
  decided_at timestamptz,
  decision_note text,
  gate_out_at timestamptz,
  gate_in_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, student_id) references students(tenant_id, id),
  foreign key (tenant_id, requested_by) references users(tenant_id, id),
  check (expected_return_at > depart_at),
  unique (tenant_id, id)
);
create index leave_student on leave_requests (student_id, status);

-- Append-only movement register (gate-out / gate-in), the record of who is on/off campus.
create table gate_movements (
  id bigserial primary key,
  tenant_id uuid not null references tenants(id),
  student_id uuid not null,
  direction text not null check (direction in ('out','in')),
  leave_request_id uuid,
  recorded_by uuid not null,
  at timestamptz not null default now(),
  foreign key (tenant_id, student_id) references students(tenant_id, id)
);

create table roll_calls (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  hostel_id uuid not null,
  session text not null check (session in ('morning','evening','bedtime')),
  roll_date date not null,
  recorded_by uuid not null,
  recorded_at timestamptz not null default now(),
  foreign key (tenant_id, hostel_id) references hostels(tenant_id, id),
  unique (hostel_id, session, roll_date),
  unique (tenant_id, id)
);
create table roll_call_entries (
  tenant_id uuid not null references tenants(id),
  roll_call_id uuid not null,
  student_id uuid not null,
  status text not null check (status in ('present','absent','on_leave','excused')),
  flag text,
  primary key (roll_call_id, student_id),
  foreign key (tenant_id, roll_call_id) references roll_calls(tenant_id, id),
  foreign key (tenant_id, student_id) references students(tenant_id, id)
);

create table incidents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  campus_id uuid not null,
  category text not null check (category in ('safety','discipline','medical','safeguarding','maintenance','missing_student')),
  severity text not null check (severity in ('low','medium','high','critical')),
  title text not null,
  description text not null,
  student_id uuid,
  reported_by uuid not null,
  assigned_to uuid,
  status text not null default 'open' check (status in ('open','investigating','escalated','closed')),
  closure_note text,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, campus_id) references campuses(tenant_id, id),
  foreign key (tenant_id, student_id) references students(tenant_id, id),
  foreign key (tenant_id, assigned_to) references users(tenant_id, id),
  unique (tenant_id, id)
);
create table incident_events (
  id bigserial primary key,
  tenant_id uuid not null references tenants(id),
  incident_id uuid not null,
  actor_user_id uuid,
  action text not null,
  note text,
  at timestamptz not null default now(),
  foreign key (tenant_id, incident_id) references incidents(tenant_id, id)
);

do $$
declare t text;
begin
  foreach t in array array['hostels','rooms','beds','bed_assignments','leave_requests','gate_movements','roll_calls','roll_call_entries','incidents','incident_events']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy tenant_isolation on %I using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  end loop;
end $$;
create trigger gate_movements_immutable before update or delete on gate_movements for each row execute function audit_log_immutable();
create trigger incident_events_immutable before update or delete on incident_events for each row execute function audit_log_immutable();
