-- SIS, admissions, class structure, minimal LMS course enrollment.
create table grade_levels (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  name text not null,
  ordinal int not null,
  unique (tenant_id, name),
  unique (tenant_id, id)
);

create table sections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  campus_id uuid not null,
  academic_year_id uuid not null,
  grade_level_id uuid not null,
  name text not null,
  capacity int not null check (capacity > 0),
  class_teacher_user_id uuid,
  foreign key (tenant_id, campus_id) references campuses(tenant_id, id),
  foreign key (tenant_id, academic_year_id) references academic_years(tenant_id, id),
  foreign key (tenant_id, grade_level_id) references grade_levels(tenant_id, id),
  foreign key (tenant_id, class_teacher_user_id) references users(tenant_id, id),
  unique (campus_id, academic_year_id, grade_level_id, name),
  unique (tenant_id, id)
);

create table subjects (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  code text not null,
  name text not null,
  unique (tenant_id, code),
  unique (tenant_id, id)
);

create table students (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  campus_id uuid not null,
  admission_no text not null,
  first_name text not null,
  last_name text not null,
  date_of_birth date not null check (date_of_birth < current_date),
  gender text,
  status text not null default 'active' check (status in ('active','transferred','withdrawn','graduated','alumni')),
  user_id uuid,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, campus_id) references campuses(tenant_id, id),
  foreign key (tenant_id, user_id) references users(tenant_id, id),
  unique (tenant_id, admission_no),
  unique (tenant_id, id)
);

create table guardians (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  user_id uuid,
  full_name text not null,
  phone text,
  email citext,
  foreign key (tenant_id, user_id) references users(tenant_id, id),
  unique (tenant_id, id)
);

create table student_guardians (
  tenant_id uuid not null references tenants(id),
  student_id uuid not null,
  guardian_id uuid not null,
  relationship text not null,
  is_primary boolean not null default false,
  is_emergency_contact boolean not null default true,
  can_pickup boolean not null default false,
  primary key (student_id, guardian_id),
  foreign key (tenant_id, student_id) references students(tenant_id, id),
  foreign key (tenant_id, guardian_id) references guardians(tenant_id, id)
);

-- Effective-dated, non-overlapping enrollment history (never overwritten).
create table enrollments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  student_id uuid not null,
  section_id uuid not null,
  academic_year_id uuid not null,
  effective_from date not null,
  effective_to date,
  end_reason text,
  foreign key (tenant_id, student_id) references students(tenant_id, id),
  foreign key (tenant_id, section_id) references sections(tenant_id, id),
  foreign key (tenant_id, academic_year_id) references academic_years(tenant_id, id),
  check (effective_to is null or effective_to >= effective_from),
  exclude using gist (student_id with =, daterange(effective_from, effective_to, '[]') with &&)
);

-- Boarder / day-scholar history on the same student identity.
create table residence_assignments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  student_id uuid not null,
  residence_type text not null check (residence_type in ('boarder','day_scholar')),
  effective_from date not null,
  effective_to date,
  note text,
  foreign key (tenant_id, student_id) references students(tenant_id, id),
  check (effective_to is null or effective_to >= effective_from),
  exclude using gist (student_id with =, daterange(effective_from, effective_to, '[]') with &&)
);

create table student_medical_alerts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  student_id uuid not null,
  alert text not null,
  severity text not null check (severity in ('info','important','critical')),
  created_by uuid,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, student_id) references students(tenant_id, id)
);

create table admission_applications (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  campus_id uuid not null,
  academic_year_id uuid not null,
  grade_level_id uuid not null,
  applicant_first_name text not null,
  applicant_last_name text not null,
  applicant_dob date not null check (applicant_dob < current_date),
  applicant_gender text,
  guardian_name text not null,
  guardian_email citext not null,
  guardian_phone text,
  guardian_relationship text not null default 'parent',
  residence_preference text not null default 'day_scholar' check (residence_preference in ('boarder','day_scholar')),
  status text not null default 'submitted' check (status in ('submitted','under_review','waitlisted','offered','accepted','rejected','withdrawn','enrolled')),
  decision_note text,
  student_id uuid,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (tenant_id, campus_id) references campuses(tenant_id, id),
  foreign key (tenant_id, academic_year_id) references academic_years(tenant_id, id),
  foreign key (tenant_id, grade_level_id) references grade_levels(tenant_id, id),
  foreign key (tenant_id, student_id) references students(tenant_id, id),
  unique (tenant_id, id)
);
create unique index admission_one_student on admission_applications (student_id) where student_id is not null;

create table courses (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  section_id uuid not null,
  subject_id uuid not null,
  teacher_user_id uuid,
  title text not null,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, section_id) references sections(tenant_id, id),
  foreign key (tenant_id, subject_id) references subjects(tenant_id, id),
  foreign key (tenant_id, teacher_user_id) references users(tenant_id, id),
  unique (section_id, subject_id),
  unique (tenant_id, id)
);

create table course_enrollments (
  tenant_id uuid not null references tenants(id),
  course_id uuid not null,
  student_id uuid not null,
  status text not null default 'active' check (status in ('active','dropped')),
  enrolled_at timestamptz not null default now(),
  primary key (course_id, student_id),
  foreign key (tenant_id, course_id) references courses(tenant_id, id),
  foreign key (tenant_id, student_id) references students(tenant_id, id)
);

do $$
declare t text;
begin
  foreach t in array array['grade_levels','sections','subjects','students','guardians','student_guardians','enrollments','residence_assignments','student_medical_alerts','admission_applications','courses','course_enrollments']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format($p$create policy tenant_isolation on %I using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid) with check (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)$p$, t);
  end loop;
end $$;
