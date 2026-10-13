create table periods (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  seq int not null,
  name text not null,
  start_time time not null,
  end_time time not null,
  is_break boolean not null default false,
  check (end_time > start_time),
  unique (tenant_id, seq),
  unique (tenant_id, id)
);
create table timetable_slots (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  section_id uuid not null,
  day_of_week int not null check (day_of_week between 1 and 6),
  period_id uuid not null,
  course_id uuid not null,
  room text,
  foreign key (tenant_id, section_id) references sections(tenant_id, id),
  foreign key (tenant_id, period_id) references periods(tenant_id, id),
  foreign key (tenant_id, course_id) references courses(tenant_id, id),
  unique (section_id, day_of_week, period_id),
  unique (tenant_id, id)
);
create table substitutions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  slot_id uuid not null,
  sub_date date not null,
  substitute_user_id uuid not null,
  reason text,
  created_by uuid not null,
  foreign key (tenant_id, slot_id) references timetable_slots(tenant_id, id),
  foreign key (tenant_id, substitute_user_id) references users(tenant_id, id),
  unique (slot_id, sub_date)
);
create table exams (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  academic_year_id uuid not null,
  name text not null,
  starts_on date not null,
  ends_on date not null,
  check (ends_on >= starts_on),
  foreign key (tenant_id, academic_year_id) references academic_years(tenant_id, id),
  unique (tenant_id, name),
  unique (tenant_id, id)
);
create table exam_papers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  exam_id uuid not null,
  course_id uuid not null,
  paper_date date not null,
  start_time time not null,
  duration_min int not null check (duration_min between 10 and 360),
  room text not null,
  max_marks numeric(6,2) not null check (max_marks > 0),
  invigilator_user_id uuid,
  status text not null default 'scheduled' check (status in ('scheduled','submitted','approved','rejected')),
  submitted_by uuid,
  decided_by uuid,
  foreign key (tenant_id, exam_id) references exams(tenant_id, id),
  foreign key (tenant_id, course_id) references courses(tenant_id, id),
  foreign key (tenant_id, invigilator_user_id) references users(tenant_id, id),
  unique (exam_id, course_id),
  unique (tenant_id, id)
);
create table exam_marks (
  tenant_id uuid not null references tenants(id),
  paper_id uuid not null,
  student_id uuid not null,
  marks numeric(6,2),
  absent boolean not null default false,
  entered_by uuid not null,
  primary key (paper_id, student_id),
  check ((absent and marks is null) or (not absent and marks is not null)),
  foreign key (tenant_id, paper_id) references exam_papers(tenant_id, id),
  foreign key (tenant_id, student_id) references students(tenant_id, id)
);
create table exam_seating (
  tenant_id uuid not null references tenants(id),
  paper_id uuid not null,
  student_id uuid not null,
  seat_no int not null,
  primary key (paper_id, student_id),
  unique (paper_id, seat_no),
  foreign key (tenant_id, paper_id) references exam_papers(tenant_id, id),
  foreign key (tenant_id, student_id) references students(tenant_id, id)
);
create table revaluations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  paper_id uuid not null,
  student_id uuid not null,
  requested_by uuid not null,
  reason text not null,
  status text not null default 'requested' check (status in ('requested','approved','rejected')),
  new_marks numeric(6,2),
  decided_by uuid,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, paper_id) references exam_papers(tenant_id, id),
  foreign key (tenant_id, student_id) references students(tenant_id, id),
  unique (paper_id, student_id)
);
-- Official marks stay immutable; approved re-evaluations are layered on top, preserving history.
create table official_mark_corrections (
  id bigserial primary key,
  tenant_id uuid not null references tenants(id),
  official_mark_id uuid not null,
  old_marks numeric(8,2) not null,
  new_marks numeric(8,2) not null,
  reason text not null,
  approved_by uuid not null,
  at timestamptz not null default now(),
  foreign key (official_mark_id) references official_marks(id)
);
do $$
declare t text;
begin
  foreach t in array array['periods','timetable_slots','substitutions','exams','exam_papers','exam_marks','exam_seating','revaluations','official_mark_corrections']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy tenant_isolation on %I using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  end loop;
end $$;
create trigger corrections_immutable before update or delete on official_mark_corrections for each row execute function audit_log_immutable();
