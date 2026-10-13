create table menus (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  campus_id uuid not null,
  menu_date date not null,
  meal text not null check (meal in ('breakfast','lunch','dinner','snack')),
  items text not null,
  allergen_tags text[] not null default '{}',
  nutrition_note text,
  foreign key (tenant_id, campus_id) references campuses(tenant_id, id),
  unique (campus_id, menu_date, meal)
);
-- Kitchen sees only these tags, never the underlying medical record.
create table dietary_flags (
  tenant_id uuid not null references tenants(id),
  student_id uuid not null,
  tag text not null check (tag in ('peanut','dairy','gluten','egg','shellfish','soy','fish','meat','vegetarian','vegan','halal')),
  added_by uuid not null,
  primary key (student_id, tag),
  foreign key (tenant_id, student_id) references students(tenant_id, id)
);
create table meal_attendance (
  tenant_id uuid not null references tenants(id),
  student_id uuid not null,
  meal_date date not null,
  meal text not null check (meal in ('breakfast','lunch','dinner','snack')),
  recorded_by uuid not null,
  at timestamptz not null default now(),
  primary key (student_id, meal_date, meal),
  foreign key (tenant_id, student_id) references students(tenant_id, id)
);

create table activities (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  campus_id uuid not null,
  name text not null,
  kind text not null check (kind in ('sport','club','event','trip')),
  capacity int not null check (capacity > 0),
  coach_user_id uuid,
  requires_consent boolean not null default true,
  starts_on date,
  foreign key (tenant_id, campus_id) references campuses(tenant_id, id),
  foreign key (tenant_id, coach_user_id) references users(tenant_id, id),
  unique (campus_id, name),
  unique (tenant_id, id)
);
create table activity_registrations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  activity_id uuid not null,
  student_id uuid not null,
  status text not null check (status in ('registered','waitlisted','withdrawn')),
  consent_by uuid,
  consent_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, activity_id) references activities(tenant_id, id),
  foreign key (tenant_id, student_id) references students(tenant_id, id)
);
create unique index one_active_registration on activity_registrations (activity_id, student_id) where status <> 'withdrawn';
create table activity_attendance (
  tenant_id uuid not null references tenants(id),
  activity_id uuid not null,
  student_id uuid not null,
  session_date date not null,
  present boolean not null,
  primary key (activity_id, student_id, session_date),
  foreign key (tenant_id, activity_id) references activities(tenant_id, id),
  foreign key (tenant_id, student_id) references students(tenant_id, id)
);
create table awards (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  student_id uuid not null,
  activity_id uuid,
  title text not null,
  awarded_on date not null,
  awarded_by uuid not null,
  foreign key (tenant_id, student_id) references students(tenant_id, id),
  foreign key (tenant_id, activity_id) references activities(tenant_id, id)
);
create table calendar_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  campus_id uuid,
  title text not null,
  kind text not null check (kind in ('holiday','vacation','exam','ptm','event','trip','deadline')),
  starts_on date not null,
  ends_on date not null,
  created_by uuid not null,
  check (ends_on >= starts_on),
  foreign key (tenant_id, campus_id) references campuses(tenant_id, id)
);
create table ptm_slots (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  teacher_user_id uuid not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  booked_student_id uuid,
  booked_by uuid,
  check (ends_at > starts_at),
  foreign key (tenant_id, teacher_user_id) references users(tenant_id, id),
  foreign key (tenant_id, booked_student_id) references students(tenant_id, id),
  exclude using gist (teacher_user_id with =, tstzrange(starts_at, ends_at) with &&)
);
do $$
declare t text;
begin
  foreach t in array array['menus','dietary_flags','meal_attendance','activities','activity_registrations','activity_attendance','awards','calendar_events','ptm_slots']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy tenant_isolation on %I using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  end loop;
end $$;
