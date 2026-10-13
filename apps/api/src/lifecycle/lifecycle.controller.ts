import { Body, ConflictException, Controller, Get, NotFoundException, Param, Post, Put, Query, Res, UnprocessableEntityException } from '@nestjs/common';
import { z } from 'zod';
import { DbService, Tx } from '../db/db.service';
import { Auth, AuthContext, campusScope, can, needs, parse, pid, uuid } from '../common/http';
import { audit } from '../common/audit';
import { guardianUserIds, isGuardianOf, notify, scopedStudent, studentAccess } from '../sis/access';
import { postJournal } from '../common/gl';

const docS = z.object({ kind: z.string().min(2).max(60), reference: z.string().max(100).optional(), issuedOn: z.string().date().optional(), expiresOn: z.string().date().optional(), fileId: uuid.optional() });
const prevS = z.object({ schoolName: z.string().min(2).max(200), lastGrade: z.string().max(40).optional(), fromYear: z.string().max(9).optional(), toYear: z.string().max(9).optional(), summary: z.string().max(500).optional() });
const corrS = z.object({ field: z.enum(['first_name', 'last_name', 'date_of_birth', 'gender']), newValue: z.string().min(1).max(100), reason: z.string().min(5).max(300) });
const ruleS = z.object({ academicYearId: uuid, minOverallPercent: z.number().min(0).max(100).default(40), minSubjectPercent: z.number().min(0).max(100).default(33), maxFailedSubjects: z.number().int().min(0).max(20).default(2), minAttendancePercent: z.number().min(0).max(100).default(0) });
const wdS = z.object({ studentId: uuid, kind: z.enum(['withdrawal', 'transfer_out']), reason: z.string().min(5).max(500), destinationSchool: z.string().max(200).optional(), effectiveDate: z.string().date() });
const applyS = z.object({
  fromAcademicYearId: uuid, toAcademicYearId: uuid, effectiveFrom: z.string().date(),
  decisions: z.array(z.object({ studentId: uuid, action: z.enum(['promote', 'retain', 'graduate']), targetSectionId: uuid.optional() })).min(1).max(1000),
});
const dayBefore = (d: string) => new Date(Date.parse(d) - 86_400_000).toISOString().slice(0, 10);
const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

@Controller()
export class LifecycleController {
  constructor(private db: DbService) {}

  // ---------------- documents, previous schools, corrections, duplicates ----------------
  @Post('students/:id/documents')
  addDoc(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id); const b = parse(docS, body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const s = await scopedStudent(tx, a, id, 'student.write');
      const d = (await tx.query('insert into student_documents(tenant_id, student_id, kind, reference, issued_on, expires_on, file_id, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id', [a.tenantId, id, b.kind, b.reference ?? null, b.issuedOn ?? null, b.expiresOn ?? null, b.fileId ?? null, a.userId])).rows[0];
      if (b.fileId) {
        const own = await tx.query('select 1 from files where id = $1 and uploaded_by = $2', [b.fileId, a.userId]);
        if (!own.rowCount) throw new UnprocessableEntityException({ error: 'file_not_owned' });
        await tx.query(`insert into file_links(tenant_id, file_id, entity_type, entity_id) values ($1,$2,'student_document',$3)`, [a.tenantId, b.fileId, d.id]);
      }
      await audit(tx, a, a.tenantId, 'student.document_add', 'student', id, s.campus_id, { kind: b.kind });
      return d;
    });
  }
  @Post('student-documents/:id/verify')
  verifyDoc(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [d] } = await tx.query('select d.*, s.campus_id from student_documents d join students s on s.id = d.student_id where d.id = $1 for update of d', [id]);
      if (!d || !can(a, 'student.write', d.campus_id)) throw new NotFoundException({ error: 'not_found' });
      if (d.verified_at) throw new ConflictException({ error: 'already_verified' });
      if (d.created_by === a.userId) throw new UnprocessableEntityException({ error: 'verifier_must_differ_from_uploader' });
      await tx.query('update student_documents set verified_by = $2, verified_at = now() where id = $1', [id, a.userId]);
      await audit(tx, a, a.tenantId, 'student.document_verify', 'student_document', id, d.campus_id);
      return { verified: true };
    });
  }
  @Get('students/:id/documents')
  docs(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [s] } = await tx.query('select * from students where id = $1', [id]);
      const acc = s && await studentAccess(tx, a, s);
      if (!s || !acc || acc === 'teacher') throw new NotFoundException({ error: 'not_found' });
      return (await tx.query('select id, kind, reference, issued_on, expires_on, verified_at is not null as verified, (expires_on is not null and expires_on < current_date) as expired from student_documents where student_id = $1 order by created_at desc', [id])).rows;
    });
  }
  @Get('students/:id/previous-schools')
  prevList(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id);
    return this.db.withTenant(a.tenantId, async (tx) => {
      await scopedStudent(tx, a, id, 'student.read');
      return (await tx.query('select school_name, last_grade, from_year, to_year, summary from previous_schools where student_id = $1 order by to_year desc nulls last', [id])).rows;
    });
  }
  @Get('student-documents/expiring')
  expiring(@Auth() a: AuthContext, @Query('days') days = '60') {
    needs(a, 'student.write'); const scope = campusScope(a, 'student.write'); const d = Math.min(Math.max(parseInt(days) || 60, 1), 365);
    return this.db.withTenant(a.tenantId, async (tx) => (await tx.query(
      `select d.id, d.kind, d.expires_on, (d.expires_on < current_date) as expired, s.first_name, s.last_name, s.admission_no from student_documents d join students s on s.id = d.student_id
       where d.expires_on is not null and d.expires_on <= current_date + $1::int and s.status = 'active' and ($2::uuid[] is null or s.campus_id = any($2)) order by d.expires_on`, [d, scope])).rows);
  }
  @Post('students/:id/previous-schools')
  prev(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id); const b = parse(prevS, body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      await scopedStudent(tx, a, id, 'student.write');
      return (await tx.query('insert into previous_schools(tenant_id, student_id, school_name, last_grade, from_year, to_year, summary) values ($1,$2,$3,$4,$5,$6,$7) returning id', [a.tenantId, id, b.schoolName, b.lastGrade ?? null, b.fromYear ?? null, b.toYear ?? null, b.summary ?? null])).rows[0];
    });
  }

  /** Corrections to identity fields are requests; a different user approves, the old value is preserved. */
  @Post('students/:id/corrections')
  requestCorrection(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id); const b = parse(corrS, body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [s] } = await tx.query('select * from students where id = $1', [id]);
      if (!s || !(can(a, 'student.write', s.campus_id) || (await isGuardianOf(tx, a.userId, id)))) throw new NotFoundException({ error: 'not_found' });
      if (b.field === 'date_of_birth' && !/^\d{4}-\d{2}-\d{2}$/.test(b.newValue)) throw new UnprocessableEntityException({ error: 'invalid_date' });
      const old = String(s[b.field] ?? '');
      if (old === b.newValue) throw new UnprocessableEntityException({ error: 'no_change' });
      const c = (await tx.query('insert into profile_corrections(tenant_id, student_id, field, old_value, new_value, reason, requested_by) values ($1,$2,$3,$4,$5,$6,$7) returning id, status', [a.tenantId, id, b.field, old, b.newValue, b.reason, a.userId])).rows[0];
      await audit(tx, a, a.tenantId, 'student.correction_request', 'student', id, s.campus_id, { field: b.field });
      return c;
    });
  }
  @Post('corrections/:id/decision')
  decideCorrection(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id); const { decision } = parse(z.object({ decision: z.enum(['approve', 'reject']) }), body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [c] } = await tx.query('select c.*, s.campus_id from profile_corrections c join students s on s.id = c.student_id where c.id = $1 for update of c', [id]);
      if (!c || !can(a, 'student.write', c.campus_id)) throw new NotFoundException({ error: 'not_found' });
      if (c.status !== 'pending') throw new ConflictException({ error: 'already_decided' });
      if (c.requested_by === a.userId) throw new UnprocessableEntityException({ error: 'cannot_approve_own_request' });
      if (decision === 'approve') await tx.query(`update students set ${c.field} = $2 where id = $1`, [c.student_id, c.new_value]);
      await tx.query('update profile_corrections set status = $2, decided_by = $3, decided_at = now() where id = $1', [id, decision === 'approve' ? 'approved' : 'rejected', a.userId]);
      await audit(tx, a, a.tenantId, `student.correction_${decision}`, 'student', c.student_id, c.campus_id, { field: c.field, from: c.old_value, to: c.new_value });
      return { decision };
    });
  }
  @Get('students/:id/corrections')
  corrections(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id);
    return this.db.withTenant(a.tenantId, async (tx) => {
      await scopedStudent(tx, a, id, 'student.read');
      return (await tx.query('select field, old_value, new_value, reason, status, created_at, decided_at from profile_corrections where student_id = $1 order by created_at desc', [id])).rows;
    });
  }

  /** Possible duplicates: same date of birth with similar names, or same guardian email + same first name. */
  @Get('students/duplicates')
  duplicates(@Auth() a: AuthContext) {
    needs(a, 'student.read'); const scope = campusScope(a, 'student.read');
    return this.db.withTenant(a.tenantId, async (tx) => (await tx.query(
      `select s1.id as a_id, s1.admission_no as a_no, s1.first_name || ' ' || s1.last_name as a_name, s2.id as b_id, s2.admission_no as b_no, s2.first_name || ' ' || s2.last_name as b_name, s1.date_of_birth,
         case when lower(s1.first_name) = lower(s2.first_name) and lower(s1.last_name) = lower(s2.last_name) then 'same_name_and_dob' else 'similar_name_and_dob' end as reason
       from students s1 join students s2 on s1.id < s2.id and s1.date_of_birth = s2.date_of_birth and s1.tenant_id = s2.tenant_id
         and (levenshtein_less_equal(lower(s1.first_name || s1.last_name), lower(s2.first_name || s2.last_name), 2) <= 2)
       where ($1::uuid[] is null or s1.campus_id = any($1)) order by s1.admission_no`, [scope])).rows);
  }

  // ---------------- promotion / retention / graduation ----------------
  @Put('promotion/rules')
  setRule(@Auth() a: AuthContext, @Body() body: unknown) {
    needs(a, 'students.promote'); const b = parse(ruleS, body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      await tx.query(`insert into promotion_rules(tenant_id, academic_year_id, min_overall_percent, min_subject_percent, max_failed_subjects, min_attendance_percent) values ($1,$2,$3,$4,$5,$6)
        on conflict (tenant_id, academic_year_id) do update set min_overall_percent = excluded.min_overall_percent, min_subject_percent = excluded.min_subject_percent, max_failed_subjects = excluded.max_failed_subjects, min_attendance_percent = excluded.min_attendance_percent`,
        [a.tenantId, b.academicYearId, b.minOverallPercent, b.minSubjectPercent, b.maxFailedSubjects, b.minAttendancePercent]);
      await audit(tx, a, a.tenantId, 'promotion.rule_set', 'academic_year', b.academicYearId);
      return b;
    });
  }
  /** Applies the configured rule to approved official marks and attendance. Students without results are flagged for review, never auto-promoted. */
  @Get('promotion/preview')
  preview(@Auth() a: AuthContext, @Query('academicYearId') yid: string, @Query('sectionId') sectionId?: string) {
    needs(a, 'students.promote'); const y = parse(uuid, yid); const scope = campusScope(a, 'students.promote');
    return this.db.withTenant(a.tenantId, async (tx) => {
      const rule = (await tx.query('select * from promotion_rules where academic_year_id = $1', [y])).rows[0] ?? { min_overall_percent: 40, min_subject_percent: 33, max_failed_subjects: 2, min_attendance_percent: 0 };
      const rows = (await tx.query(
        `select s.id, s.admission_no, s.first_name, s.last_name, sec.id as section_id, sec.name as section, g.name as grade, g.ordinal, sec.campus_id,
           (select coalesce(sum(coalesce((select new_marks from official_mark_corrections oc where oc.official_mark_id = om.id order by oc.id desc limit 1), om.marks)), 0) from official_marks om where om.student_id = s.id and om.academic_year_id = $1) as marks,
           (select coalesce(sum(om.max_marks), 0) from official_marks om where om.student_id = s.id and om.academic_year_id = $1) as max_marks,
           (select count(*) from (select om.course_id from official_marks om where om.student_id = s.id and om.academic_year_id = $1 group by om.course_id
              having sum(coalesce((select new_marks from official_mark_corrections oc where oc.official_mark_id = om.id order by oc.id desc limit 1), om.marks)) / nullif(sum(om.max_marks), 0) * 100 < $3) f)::int as failed_subjects,
           (select round(100.0 * count(*) filter (where ar.status in ('present','late')) / nullif(count(*), 0), 1) from attendance_records ar where ar.student_id = s.id and ar.period = 0) as attendance
         from enrollments e join students s on s.id = e.student_id join sections sec on sec.id = e.section_id join grade_levels g on g.id = sec.grade_level_id
         where e.academic_year_id = $1 and e.effective_to is null and s.status = 'active' and ($2::uuid is null or sec.id = $2) and ($4::uuid[] is null or sec.campus_id = any($4))
         order by g.ordinal, sec.name, s.admission_no`, [y, sectionId ? parse(uuid, sectionId) : null, Number(rule.min_subject_percent), scope])).rows;
      const top = Number((await tx.query('select max(ordinal) m from grade_levels')).rows[0].m);
      return {
        rule,
        students: rows.map((r) => {
          const pct = Number(r.max_marks) > 0 ? Math.round((Number(r.marks) / Number(r.max_marks)) * 1000) / 10 : null;
          let suggestion: 'promote' | 'retain' | 'graduate' | 'needs_review' = 'needs_review'; const reasons: string[] = [];
          if (pct === null) reasons.push('no approved results');
          else {
            if (pct < Number(rule.min_overall_percent)) reasons.push(`overall ${pct}% below ${rule.min_overall_percent}%`);
            if (r.failed_subjects > rule.max_failed_subjects) reasons.push(`${r.failed_subjects} failed subjects (max ${rule.max_failed_subjects})`);
            if (Number(rule.min_attendance_percent) > 0 && (r.attendance === null || Number(r.attendance) < Number(rule.min_attendance_percent))) reasons.push(`attendance ${r.attendance ?? 'n/a'}% below ${rule.min_attendance_percent}%`);
            suggestion = reasons.length ? 'retain' : r.ordinal >= top ? 'graduate' : 'promote';
          }
          return { studentId: r.id, admissionNo: r.admission_no, name: `${r.first_name} ${r.last_name}`, grade: r.grade, section: r.section, overallPercent: pct, failedSubjects: r.failed_subjects, attendancePercent: r.attendance === null ? null : Number(r.attendance), suggestion, reasons };
        }),
      };
    });
  }
  /** Applies reviewed decisions. History is preserved: current enrolment is closed, a new one opened; graduates become alumni. */
  @Post('promotion/apply')
  apply(@Auth() a: AuthContext, @Body() body: unknown) {
    needs(a, 'students.promote'); const b = parse(applyS, body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const out = { promoted: 0, retained: 0, graduated: 0 };
      for (const d of b.decisions) {
        const s = await scopedStudent(tx, a, d.studentId, 'students.promote');
        const { rows: [cur] } = await tx.query('select e.*, sec.grade_level_id from enrollments e join sections sec on sec.id = e.section_id where e.student_id = $1 and e.effective_to is null and e.academic_year_id = $2 for update of e', [d.studentId, b.fromAcademicYearId]);
        if (!cur) throw new UnprocessableEntityException({ error: 'no_current_enrolment_in_year', studentId: d.studentId });
        const reason = d.action === 'promote' ? 'promoted' : d.action === 'retain' ? 'retained' : 'graduated';
        await tx.query('update enrollments set effective_to = $2, end_reason = $3 where id = $1', [cur.id, dayBefore(b.effectiveFrom), reason]);
        await tx.query(`update course_enrollments set status = 'dropped' where student_id = $1 and course_id in (select id from courses where section_id = $2)`, [d.studentId, cur.section_id]);
        if (d.action === 'graduate') {
          await tx.query(`update students set status = 'alumni' where id = $1`, [d.studentId]);
          await tx.query(`update residence_assignments set effective_to = $2 where student_id = $1 and effective_to is null`, [d.studentId, dayBefore(b.effectiveFrom)]);
          await tx.query(`update bed_assignments set effective_to = $2 where student_id = $1 and effective_to is null and effective_from <= $2`, [d.studentId, dayBefore(b.effectiveFrom)]);
          if (s.user_id) { await tx.query(`update users set status = 'disabled' where id = $1`, [s.user_id]); await tx.query('update sessions set revoked_at = now() where user_id = $1 and revoked_at is null', [s.user_id]); }
          out.graduated++;
        } else {
          if (!d.targetSectionId) throw new UnprocessableEntityException({ error: 'target_section_required', studentId: d.studentId });
          const { rows: [sec] } = await tx.query('select * from sections where id = $1 for update', [d.targetSectionId]);
          if (!sec || sec.campus_id !== s.campus_id || sec.academic_year_id !== b.toAcademicYearId) throw new UnprocessableEntityException({ error: 'invalid_target_section', studentId: d.studentId });
          const wantGrade = d.action === 'promote' ? null : cur.grade_level_id;
          if (wantGrade && sec.grade_level_id !== wantGrade) throw new UnprocessableEntityException({ error: 'retained_student_must_stay_in_same_grade', studentId: d.studentId });
          if (d.action === 'promote' && sec.grade_level_id === cur.grade_level_id) throw new UnprocessableEntityException({ error: 'promotion_requires_higher_grade', studentId: d.studentId });
          const used = (await tx.query('select count(*)::int n from enrollments where section_id = $1 and effective_to is null', [sec.id])).rows[0].n;
          if (used >= sec.capacity) throw new ConflictException({ error: 'section_full', sectionId: sec.id });
          await tx.query('insert into enrollments(tenant_id, student_id, section_id, academic_year_id, effective_from) values ($1,$2,$3,$4,$5)', [a.tenantId, d.studentId, sec.id, b.toAcademicYearId, b.effectiveFrom]);
          await tx.query(`insert into course_enrollments(tenant_id, course_id, student_id) select $1, c.id, $2 from courses c where c.section_id = $3 on conflict (course_id, student_id) do update set status = 'active'`, [a.tenantId, d.studentId, sec.id]);
          d.action === 'promote' ? out.promoted++ : out.retained++;
        }
        await notify(tx, a.tenantId, await guardianUserIds(tx, d.studentId), 'student.progression', 'Year-end result', `${s.first_name}: ${reason}.`);
        await audit(tx, a, a.tenantId, `student.${reason}`, 'student', d.studentId, s.campus_id, { to: d.targetSectionId });
      }
      return out;
    });
  }

  // ---------------- withdrawal / transfer-out workflow ----------------
  @Post('withdrawals')
  requestWithdrawal(@Auth() a: AuthContext, @Body() body: unknown) {
    const b = parse(wdS, body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [s] } = await tx.query('select * from students where id = $1', [b.studentId]);
      if (!s || !(can(a, 'student.write', s.campus_id) || (await isGuardianOf(tx, a.userId, s.id)))) throw new NotFoundException({ error: 'not_found' });
      if (s.status !== 'active') throw new ConflictException({ error: 'student_not_active' });
      const open = await tx.query(`select 1 from withdrawal_requests where student_id = $1 and status in ('requested','approved')`, [s.id]);
      if (open.rowCount) throw new ConflictException({ error: 'open_request_exists' });
      const r = (await tx.query('insert into withdrawal_requests(tenant_id, student_id, kind, reason, destination_school, effective_date, requested_by) values ($1,$2,$3,$4,$5,$6,$7) returning id, status', [a.tenantId, s.id, b.kind, b.reason, b.destinationSchool ?? null, b.effectiveDate, a.userId])).rows[0];
      await audit(tx, a, a.tenantId, 'withdrawal.request', 'student', s.id, s.campus_id, { kind: b.kind });
      return r;
    });
  }
  @Get('withdrawals')
  withdrawals(@Auth() a: AuthContext) {
    return this.db.withTenant(a.tenantId, async (tx) => (await tx.query(
      `select w.id, w.kind, w.reason, w.effective_date, w.status, w.destination_school, s.first_name, s.last_name, s.admission_no, s.id as student_id, s.campus_id from withdrawal_requests w join students s on s.id = w.student_id order by w.created_at desc limit 100`)).rows
      .filter((w) => can(a, 'students.withdraw_approve', w.campus_id) || can(a, 'student.write', w.campus_id)));
  }
  /** Shows what still blocks completion: fees due, library loans, hostel bed, transport. */
  @Get('withdrawals/:id/clearance')
  clearance(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const w = await this.wd(tx, a, id);
      return this.compute(tx, w.student_id);
    });
  }
  private async compute(tx: Tx, studentId: string) {
    const fees = Number((await tx.query(`select coalesce(sum(i.total_minor - coalesce((select sum(amount_minor) from invoice_adjustments where invoice_id = i.id),0) - coalesce((select sum(amount_minor) from payment_allocations where invoice_id = i.id),0)),0)::bigint n from invoices i where i.student_id = $1 and i.status <> 'void'`, [studentId])).rows[0].n);
    const loans = (await tx.query('select count(*)::int n from loans where student_id = $1 and returned_on is null', [studentId])).rows[0].n;
    const bed = (await tx.query('select count(*)::int n from bed_assignments where student_id = $1 and effective_to is null', [studentId])).rows[0].n;
    const onLeave = (await tx.query(`select count(*)::int n from leave_requests where student_id = $1 and status = 'out'`, [studentId])).rows[0].n;
    return { feesOutstandingMinor: fees, openLibraryLoans: loans, hostelBedAssigned: bed > 0, currentlyOffCampusOnLeave: onLeave > 0, blockers: [fees > 0 && 'outstanding_fees', loans > 0 && 'library_items_not_returned', onLeave > 0 && 'student_off_campus'].filter(Boolean) as string[] };
  }
  @Post('withdrawals/:id/decision')
  decideWithdrawal(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id); const { decision } = parse(z.object({ decision: z.enum(['approve', 'reject']) }), body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const w = await this.wd(tx, a, id);
      needs(a, 'students.withdraw_approve', w.campus_id);
      if (w.status !== 'requested') throw new ConflictException({ error: 'not_pending' });
      if (w.requested_by === a.userId) throw new UnprocessableEntityException({ error: 'cannot_approve_own_request' });
      await tx.query('update withdrawal_requests set status = $2, decided_by = $3, decided_at = now() where id = $1', [id, decision === 'approve' ? 'approved' : 'rejected', a.userId]);
      await audit(tx, a, a.tenantId, `withdrawal.${decision}`, 'student', w.student_id, w.campus_id);
      return { decision };
    });
  }
  /** Completes an approved withdrawal on/after the effective date: closes every operational assignment, preserves all history. */
  @Post('withdrawals/:id/complete')
  completeWithdrawal(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id); const { waiveOutstandingFees } = parse(z.object({ waiveOutstandingFees: z.boolean().default(false) }), body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const w = await this.wd(tx, a, id);
      needs(a, 'student.write', w.campus_id);
      if (w.status !== 'approved') throw new ConflictException({ error: 'not_approved', status: w.status });
      if (w.effective_date > new Date().toISOString().slice(0, 10)) throw new UnprocessableEntityException({ error: 'effective_date_not_reached' });
      const c = await this.compute(tx, w.student_id);
      const blockers = c.blockers.filter((x) => !(x === 'outstanding_fees' && waiveOutstandingFees));
      if (waiveOutstandingFees && c.feesOutstandingMinor > 0) {
        needs(a, 'finance.approve', w.campus_id);   // only a finance approver can write off dues
        const invs = (await tx.query(`select i.id, i.number, (i.total_minor - coalesce((select sum(amount_minor) from invoice_adjustments where invoice_id = i.id),0) - coalesce((select sum(amount_minor) from payment_allocations where invoice_id = i.id),0)) as due from invoices i where i.student_id = $1 and i.status <> 'void'`, [w.student_id])).rows.filter((r) => Number(r.due) > 0);
        for (const i of invs) {
          const adj = (await tx.query(`insert into invoice_adjustments(tenant_id, invoice_id, amount_minor, reason, approved_by, source) values ($1,$2,$3,$4,$5,'write_off') returning id`, [a.tenantId, i.id, i.due, `Written off on ${w.kind.replace('_', ' ')}`, a.userId])).rows[0];
          await postJournal(tx, a.tenantId, { memo: `Write-off ${i.number}`, source: 'adjustment', sourceRef: adj.id, postedBy: a.userId, lines: [{ account: '5900', debit: Number(i.due) }, { account: '1100', credit: Number(i.due) }] });
          await tx.query(`insert into ledger_entries(tenant_id, student_id, kind, ref_id, credit_minor, description) values ($1,$2,'credit_note',$3,$4,$5)`, [a.tenantId, w.student_id, i.id, i.due, `Write-off on ${i.number}: ${w.kind.replace('_', ' ')}`]);
        }
      }
      if (blockers.length) throw new ConflictException({ error: 'clearance_pending', blockers });
      const end = w.effective_date, before = dayBefore(end);
      await tx.query(`update enrollments set effective_to = case when effective_from <= $2 then $2 else effective_from end, end_reason = $3 where student_id = $1 and effective_to is null`, [w.student_id, before, w.kind]);
      await tx.query(`update residence_assignments set effective_to = case when effective_from <= $2 then $2 else effective_from end where student_id = $1 and effective_to is null`, [w.student_id, before]);
      await tx.query(`update bed_assignments set effective_to = case when effective_from <= $2 then $2 else effective_from end where student_id = $1 and effective_to is null`, [w.student_id, before]);
      await tx.query(`update student_transport set effective_to = case when effective_from <= $2 then $2 else effective_from end where student_id = $1 and effective_to is null`, [w.student_id, before]);
      await tx.query(`update course_enrollments set status = 'dropped' where student_id = $1`, [w.student_id]);
      await tx.query(`update activity_registrations set status = 'withdrawn' where student_id = $1 and status <> 'withdrawn'`, [w.student_id]);
      await tx.query('update students set status = $2 where id = $1', [w.student_id, w.kind === 'withdrawal' ? 'withdrawn' : 'transferred']);
      const su = (await tx.query('select user_id from students where id = $1', [w.student_id])).rows[0].user_id;
      if (su) { await tx.query(`update users set status = 'disabled' where id = $1`, [su]); await tx.query('update sessions set revoked_at = now() where user_id = $1 and revoked_at is null', [su]); }
      await tx.query(`update withdrawal_requests set status = 'completed', completed_at = now(), fees_waived_by = $2, clearance = $3 where id = $1`, [id, waiveOutstandingFees && c.feesOutstandingMinor > 0 ? a.userId : null, JSON.stringify(c)]);
      await notify(tx, a.tenantId, await guardianUserIds(tx, w.student_id), 'student.exit', 'Exit completed', `${w.first_name}'s ${w.kind.replace('_', ' ')} has been completed. A leaving certificate is available from the school office.`);
      await audit(tx, a, a.tenantId, 'withdrawal.complete', 'student', w.student_id, w.campus_id, { kind: w.kind, waived: waiveOutstandingFees });
      return { completed: true, status: w.kind === 'withdrawal' ? 'withdrawn' : 'transferred' };
    });
  }
  @Post('withdrawals/:id/cancel')
  cancelWithdrawal(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const w = await this.wd(tx, a, id);
      if (!['requested', 'approved'].includes(w.status)) throw new ConflictException({ error: 'cannot_cancel', status: w.status });
      if (w.requested_by !== a.userId) needs(a, 'student.write', w.campus_id);
      await tx.query(`update withdrawal_requests set status = 'cancelled' where id = $1`, [id]);
      return { cancelled: true };
    });
  }
  private async wd(tx: Tx, a: AuthContext, id: string) {
    const { rows: [w] } = await tx.query('select w.*, s.campus_id, s.first_name, s.last_name from withdrawal_requests w join students s on s.id = w.student_id where w.id = $1 for update of w', [id]);
    if (!w || !(can(a, 'student.write', w.campus_id) || can(a, 'students.withdraw_approve', w.campus_id) || w.requested_by === a.userId)) throw new NotFoundException({ error: 'not_found' });
    return w;
  }

  /** Printable leaving certificate (HTML; use the browser to print / save as PDF). Only after a completed exit. */
  @Get('students/:id/leaving-certificate')
  certificate(@Auth() a: AuthContext, @Param('id') id: string, @Res() res: any) {
    pid(id);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const s = await scopedStudent(tx, a, id, 'student.write');
      const { rows: [w] } = await tx.query(`select * from withdrawal_requests where student_id = $1 and status = 'completed' order by completed_at desc limit 1`, [id]);
      if (!w && s.status !== 'alumni') throw new ConflictException({ error: 'no_completed_exit' });
      const last = (await tx.query(`select g.name as grade, sec.name as section, ay.name as year from enrollments e join sections sec on sec.id = e.section_id join grade_levels g on g.id = sec.grade_level_id join academic_years ay on ay.id = e.academic_year_id where e.student_id = $1 order by e.effective_from desc limit 1`, [id])).rows[0];
      const tenant = (await tx.query('select name from tenants where id = $1', [a.tenantId]).catch(() => ({ rows: [{ name: '' }] }))).rows[0];
      const no = `LC-${s.admission_no}`;
      await audit(tx, a, a.tenantId, 'certificate.leaving', 'student', id, s.campus_id);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
      res.send(`<!doctype html><meta charset="utf-8"><title>Leaving certificate ${esc(no)}</title><style>body{font-family:Georgia,serif;max-width:700px;margin:3rem auto;padding:2rem;border:3px double #333}h1{text-align:center}td{padding:.4rem .8rem}</style>
<h1>${esc(tenant?.name ?? 'School')}</h1><h2 style="text-align:center">Leaving Certificate</h2><p style="text-align:center">No. ${esc(no)}</p>
<table><tr><td>Student</td><td><strong>${esc(s.first_name)} ${esc(s.last_name)}</strong></td></tr><tr><td>Admission no.</td><td>${esc(s.admission_no)}</td></tr><tr><td>Date of birth</td><td>${esc(s.date_of_birth)}</td></tr>
<tr><td>Last class attended</td><td>${esc(last?.grade)} ${esc(last?.section)} (${esc(last?.year)})</td></tr><tr><td>Reason</td><td>${esc(w ? w.kind.replace('_', ' ') : 'completed school (graduated)')}</td></tr>
<tr><td>Date of leaving</td><td>${esc(w?.effective_date ?? '')}</td></tr>${w?.destination_school ? `<tr><td>Transferred to</td><td>${esc(w.destination_school)}</td></tr>` : ''}</table>
<p>Fees and library dues are ${w?.fees_waived_by ? 'written off by approval' : 'cleared'}.</p><p style="margin-top:4rem">Principal ____________________</p>`);
    });
  }

  @Get('alumni')
  alumni(@Auth() a: AuthContext) {
    needs(a, 'student.read'); const scope = campusScope(a, 'student.read');
    return this.db.withTenant(a.tenantId, async (tx) => (await tx.query(
      `select s.id, s.admission_no, s.first_name, s.last_name, s.status, (select max(effective_to) from enrollments e where e.student_id = s.id) as left_on
       from students s where s.status in ('alumni','withdrawn','transferred') and ($1::uuid[] is null or s.campus_id = any($1)) order by left_on desc nulls last, s.admission_no`, [scope])).rows);
  }
}
