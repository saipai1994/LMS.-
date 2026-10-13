create table files (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  uploaded_by uuid not null,
  name text not null,
  mime text not null,
  size_bytes int not null,
  sha256 text not null,
  storage_key text not null,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, uploaded_by) references users(tenant_id, id),
  unique (tenant_id, id)
);
create table file_links (
  tenant_id uuid not null references tenants(id),
  file_id uuid not null,
  entity_type text not null check (entity_type in ('lesson','submission')),
  entity_id uuid not null,
  primary key (file_id, entity_type, entity_id),
  foreign key (tenant_id, file_id) references files(tenant_id, id)
);

create table lessons (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  course_id uuid not null,
  unit text,
  title text not null,
  body text,
  external_url text check (external_url is null or external_url ~ '^https?://'),
  position int not null default 0,
  release_at timestamptz,
  prerequisite_lesson_id uuid,
  published boolean not null default false,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, course_id) references courses(tenant_id, id),
  unique (tenant_id, id)
);
create table lesson_progress (
  tenant_id uuid not null references tenants(id),
  lesson_id uuid not null,
  student_id uuid not null,
  completed_at timestamptz not null default now(),
  primary key (lesson_id, student_id),
  foreign key (tenant_id, lesson_id) references lessons(tenant_id, id),
  foreign key (tenant_id, student_id) references students(tenant_id, id)
);

create table assignments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  course_id uuid not null,
  title text not null,
  instructions text not null default '',
  due_at timestamptz not null,
  max_marks numeric(7,2) not null check (max_marks > 0),
  allow_late boolean not null default true,
  published boolean not null default false,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, course_id) references courses(tenant_id, id),
  unique (tenant_id, id)
);
-- If any rows exist, the assignment is for those students only; otherwise for the whole course.
create table assignment_targets (
  tenant_id uuid not null references tenants(id),
  assignment_id uuid not null,
  student_id uuid not null,
  primary key (assignment_id, student_id),
  foreign key (tenant_id, assignment_id) references assignments(tenant_id, id),
  foreign key (tenant_id, student_id) references students(tenant_id, id)
);
create table submissions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  assignment_id uuid not null,
  student_id uuid not null,
  status text not null default 'draft' check (status in ('draft','submitted','graded','returned')),
  answer_text text not null default '',
  version int not null default 0,
  submitted_at timestamptz,
  is_late boolean not null default false,
  marks numeric(7,2),
  feedback text,
  graded_by uuid,
  graded_at timestamptz,
  foreign key (tenant_id, assignment_id) references assignments(tenant_id, id),
  foreign key (tenant_id, student_id) references students(tenant_id, id),
  unique (assignment_id, student_id),
  unique (tenant_id, id)
);
create table submission_history (
  id bigserial primary key,
  tenant_id uuid not null references tenants(id),
  submission_id uuid not null,
  event text not null,           -- submitted | graded | returned
  version int not null,
  answer_text text,
  marks numeric(7,2),
  feedback text,
  actor_user_id uuid,
  at timestamptz not null default now(),
  foreign key (tenant_id, submission_id) references submissions(tenant_id, id)
);

create table quizzes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  course_id uuid not null,
  title text not null,
  opens_at timestamptz not null,
  closes_at timestamptz not null,
  time_limit_minutes int not null check (time_limit_minutes between 1 and 300),
  attempts_allowed int not null default 1 check (attempts_allowed between 1 and 10),
  published boolean not null default false,
  created_by uuid not null,
  foreign key (tenant_id, course_id) references courses(tenant_id, id),
  check (closes_at > opens_at),
  unique (tenant_id, id)
);
create table quiz_questions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  quiz_id uuid not null,
  position int not null,
  kind text not null check (kind in ('mcq','short')),
  prompt text not null,
  options jsonb,                -- mcq: array of option strings
  answer_key jsonb not null,    -- RESTRICTED: never returned to students
  points numeric(6,2) not null check (points > 0),
  foreign key (tenant_id, quiz_id) references quizzes(tenant_id, id),
  unique (quiz_id, position),
  unique (tenant_id, id)
);
create table quiz_attempts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  quiz_id uuid not null,
  student_id uuid not null,
  attempt_no int not null,
  started_at timestamptz not null default now(),
  deadline_at timestamptz not null,
  submitted_at timestamptz,
  answers jsonb,
  auto_score numeric(7,2),
  manual_score numeric(7,2),    -- short answers marked by the teacher
  foreign key (tenant_id, quiz_id) references quizzes(tenant_id, id),
  foreign key (tenant_id, student_id) references students(tenant_id, id),
  unique (quiz_id, student_id, attempt_no),
  unique (tenant_id, id)
);

-- Official (ERP) results: only reach here via approved publications; immutable once approved.
create table grade_scales (
  tenant_id uuid not null references tenants(id),
  min_percent numeric(5,2) not null,
  grade text not null,
  points numeric(4,2),
  primary key (tenant_id, min_percent)
);
create table grade_publications (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  course_id uuid not null,
  assessment_name text not null,
  source_assignment_ids uuid[] not null,
  status text not null default 'submitted' check (status in ('submitted','approved','rejected')),
  submitted_by uuid not null,
  decided_by uuid,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, course_id) references courses(tenant_id, id),
  unique (tenant_id, id)
);
create table publication_entries (
  tenant_id uuid not null references tenants(id),
  publication_id uuid not null,
  student_id uuid not null,
  marks numeric(8,2) not null,
  max_marks numeric(8,2) not null,
  primary key (publication_id, student_id),
  foreign key (tenant_id, publication_id) references grade_publications(tenant_id, id),
  foreign key (tenant_id, student_id) references students(tenant_id, id)
);
create table official_marks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  student_id uuid not null,
  course_id uuid not null,
  academic_year_id uuid not null,
  assessment_name text not null,
  marks numeric(8,2) not null,
  max_marks numeric(8,2) not null,
  publication_id uuid not null,
  published_at timestamptz not null default now(),
  foreign key (tenant_id, student_id) references students(tenant_id, id),
  foreign key (tenant_id, course_id) references courses(tenant_id, id),
  foreign key (tenant_id, publication_id) references grade_publications(tenant_id, id),
  unique (student_id, course_id, assessment_name)
);

do $$
declare t text;
begin
  foreach t in array array['files','file_links','lessons','lesson_progress','assignments','assignment_targets','submissions','submission_history','quizzes','quiz_questions','quiz_attempts','grade_scales','grade_publications','publication_entries','official_marks']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy tenant_isolation on %I using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  end loop;
end $$;
create trigger official_marks_immutable before update or delete on official_marks for each row execute function audit_log_immutable();
create trigger submission_history_immutable before update or delete on submission_history for each row execute function audit_log_immutable();
