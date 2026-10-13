create table early_dismissal_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  student_id uuid not null,
  requested_by uuid not null,
  for_date date not null,
  pickup_time time not null,
  reason text not null,
  status text not null default 'requested' check (status in ('requested','approved','rejected','cancelled')),
  decided_by uuid,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, student_id) references students(tenant_id, id),
  unique (tenant_id, id)
);
create unique index one_open_early_request on early_dismissal_requests (student_id, for_date) where status in ('requested','approved');

create table maintenance_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  hostel_id uuid not null,
  room_id uuid,
  description text not null,
  priority text not null default 'normal' check (priority in ('low','normal','urgent')),
  status text not null default 'open' check (status in ('open','assigned','done')),
  reported_by uuid not null,
  assigned_to text,
  done_note text,
  created_at timestamptz not null default now(),
  done_at timestamptz,
  foreign key (tenant_id, hostel_id) references hostels(tenant_id, id),
  foreign key (tenant_id, room_id) references rooms(tenant_id, id)
);
create table room_inspections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  room_id uuid not null,
  inspected_by uuid not null,
  inspected_on date not null default current_date,
  score int not null check (score between 1 and 5),
  issues text,
  maintenance_request_id uuid,
  foreign key (tenant_id, room_id) references rooms(tenant_id, id)
);
create table vacation_plans (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  student_id uuid not null,
  from_date date not null,
  to_date date not null,
  arrangement text not null check (arrangement in ('home','guardian','school_stay')),
  contact text not null,
  recorded_by uuid not null,
  check (to_date >= from_date),
  foreign key (tenant_id, student_id) references students(tenant_id, id),
  exclude using gist (student_id with =, daterange(from_date, to_date, '[]') with &&)
);

create table consent_forms (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  title text not null,
  body text not null,
  audience_type text not null check (audience_type in ('all','grade','section','activity')),
  audience_ref uuid,
  due_on date,
  status text not null default 'active' check (status in ('active','closed')),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, id)
);
create table consent_responses (
  tenant_id uuid not null references tenants(id),
  form_id uuid not null,
  student_id uuid not null,
  guardian_user_id uuid not null,
  decision text not null check (decision in ('agree','decline')),
  signed_name text not null,
  ip text,
  at timestamptz not null default now(),
  primary key (form_id, student_id),
  foreign key (tenant_id, form_id) references consent_forms(tenant_id, id),
  foreign key (tenant_id, student_id) references students(tenant_id, id),
  foreign key (tenant_id, guardian_user_id) references users(tenant_id, id)
);

create table discussion_threads (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  course_id uuid not null,
  title text not null,
  moderated boolean not null default true,
  locked boolean not null default false,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, course_id) references courses(tenant_id, id),
  unique (tenant_id, id)
);
create table discussion_posts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  thread_id uuid not null,
  author_user_id uuid not null,
  body text not null,
  status text not null check (status in ('approved','pending','removed')),
  moderated_by uuid,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, thread_id) references discussion_threads(tenant_id, id),
  foreign key (tenant_id, author_user_id) references users(tenant_id, id),
  unique (tenant_id, id)
);
create table competencies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  subject_id uuid not null,
  code text not null,
  description text not null,
  foreign key (tenant_id, subject_id) references subjects(tenant_id, id),
  unique (tenant_id, code),
  unique (tenant_id, id)
);
create table competency_assessments (   -- append-only history; the latest row is the current level
  id bigserial primary key,
  tenant_id uuid not null references tenants(id),
  student_id uuid not null,
  competency_id uuid not null,
  level int not null check (level between 1 and 4),
  evidence text,
  assessed_by uuid not null,
  at timestamptz not null default now(),
  foreign key (tenant_id, student_id) references students(tenant_id, id),
  foreign key (tenant_id, competency_id) references competencies(tenant_id, id)
);
create table learning_plans (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  student_id uuid not null,
  course_id uuid not null,
  kind text not null check (kind in ('remedial','enrichment')),
  goal text not null,
  starts_on date not null,
  ends_on date not null,
  status text not null default 'active' check (status in ('active','completed','cancelled')),
  outcome text,
  created_by uuid not null,
  check (ends_on >= starts_on),
  foreign key (tenant_id, student_id) references students(tenant_id, id),
  foreign key (tenant_id, course_id) references courses(tenant_id, id)
);
create table portfolio_entries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  student_id uuid not null,
  title text not null,
  reflection text not null,
  file_id uuid,
  teacher_comment text,
  commented_by uuid,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, student_id) references students(tenant_id, id),
  foreign key (tenant_id, file_id) references files(tenant_id, id)
);
create table report_remarks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  student_id uuid not null,
  academic_year_id uuid not null,
  remark text not null,
  author_user_id uuid not null,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, student_id) references students(tenant_id, id),
  foreign key (tenant_id, academic_year_id) references academic_years(tenant_id, id),
  unique (student_id, academic_year_id, author_user_id)
);
alter table file_links drop constraint file_links_entity_type_check;
alter table file_links add constraint file_links_entity_type_check check (entity_type in ('lesson','submission','student_document','portfolio'));
do $$
declare t text;
begin
  foreach t in array array['early_dismissal_requests','maintenance_requests','room_inspections','vacation_plans','consent_forms','consent_responses','discussion_threads','discussion_posts','competencies','competency_assessments','learning_plans','portfolio_entries','report_remarks']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy tenant_isolation on %I using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  end loop;
end $$;
create trigger competency_history_immutable before update or delete on competency_assessments for each row execute function audit_log_immutable();
