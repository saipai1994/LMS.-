create table vehicles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  campus_id uuid not null,
  reg_no text not null,
  capacity int not null check (capacity between 1 and 80),
  insurance_expiry date,
  permit_expiry date,
  fitness_expiry date,
  status text not null default 'active' check (status in ('active','maintenance','retired')),
  foreign key (tenant_id, campus_id) references campuses(tenant_id, id),
  unique (tenant_id, reg_no),
  unique (tenant_id, id)
);
create table drivers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  campus_id uuid not null,
  full_name text not null,
  phone text,
  licence_no text not null,
  licence_expiry date not null,
  user_id uuid,
  foreign key (tenant_id, campus_id) references campuses(tenant_id, id),
  foreign key (tenant_id, user_id) references users(tenant_id, id),
  unique (tenant_id, licence_no),
  unique (tenant_id, id)
);
create table transport_routes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  campus_id uuid not null,
  name text not null,
  vehicle_id uuid,
  driver_id uuid,
  attendant_name text,
  foreign key (tenant_id, campus_id) references campuses(tenant_id, id),
  foreign key (tenant_id, vehicle_id) references vehicles(tenant_id, id),
  foreign key (tenant_id, driver_id) references drivers(tenant_id, id),
  unique (tenant_id, campus_id, name),
  unique (tenant_id, id)
);
create table route_stops (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  route_id uuid not null,
  seq int not null,
  name text not null,
  pickup_time time,
  drop_time time,
  foreign key (tenant_id, route_id) references transport_routes(tenant_id, id),
  unique (route_id, seq),
  unique (tenant_id, id)
);
create table student_transport (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  student_id uuid not null,
  route_id uuid not null,
  stop_id uuid not null,
  effective_from date not null,
  effective_to date,
  foreign key (tenant_id, student_id) references students(tenant_id, id),
  foreign key (tenant_id, route_id) references transport_routes(tenant_id, id),
  foreign key (tenant_id, stop_id) references route_stops(tenant_id, id),
  check (effective_to is null or effective_to >= effective_from),
  exclude using gist (student_id with =, daterange(effective_from, effective_to, '[]') with &&)
);
create table trips (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  route_id uuid not null,
  trip_date date not null,
  shift text not null check (shift in ('am','pm')),
  status text not null default 'in_progress' check (status in ('in_progress','completed')),
  started_by uuid not null,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  foreign key (tenant_id, route_id) references transport_routes(tenant_id, id),
  unique (route_id, trip_date, shift),
  unique (tenant_id, id)
);
create table trip_events (
  id bigserial primary key,
  tenant_id uuid not null references tenants(id),
  trip_id uuid not null,
  student_id uuid not null,
  event text not null check (event in ('boarded','dropped')),
  recorded_by uuid not null,
  at timestamptz not null default now(),
  foreign key (tenant_id, trip_id) references trips(tenant_id, id),
  foreign key (tenant_id, student_id) references students(tenant_id, id),
  unique (trip_id, student_id, event)
);
create table vehicle_maintenance (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  vehicle_id uuid not null,
  kind text not null check (kind in ('service','repair','inspection','fuel')),
  done_on date not null,
  cost_minor bigint not null default 0 check (cost_minor >= 0),
  notes text,
  next_due date,
  recorded_by uuid not null,
  foreign key (tenant_id, vehicle_id) references vehicles(tenant_id, id)
);
do $$
declare t text;
begin
  foreach t in array array['vehicles','drivers','transport_routes','route_stops','student_transport','trips','trip_events','vehicle_maintenance']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy tenant_isolation on %I using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  end loop;
end $$;
create trigger trip_events_immutable before update or delete on trip_events for each row execute function audit_log_immutable();
