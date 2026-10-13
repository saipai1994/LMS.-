import { Body, ConflictException, Controller, Get, NotFoundException, Param, Post, Query, UnprocessableEntityException } from '@nestjs/common';
import { z } from 'zod';
import { DbService, Tx } from '../db/db.service';
import { Auth, AuthContext, campusScope, can, needs, parse, pid, uuid } from '../common/http';
import { audit } from '../common/audit';

const profileS = z.object({ userId: uuid, campusId: uuid, employeeNo: z.string().min(2).max(30), designation: z.string().min(2).max(100), department: z.string().max(100).optional(), joinDate: z.string().date(), contractEnd: z.string().date().optional(), qualifications: z.string().max(500).optional() });
const docS = z.object({ kind: z.string().min(2).max(60), reference: z.string().max(100).optional(), expiresOn: z.string().date().optional() });
const leaveS = z.object({ kind: z.enum(['casual', 'sick', 'earned', 'unpaid']), fromDate: z.string().date(), toDate: z.string().date(), reason: z.string().max(300).optional() });
const attS = z.object({ date: z.string().date(), entries: z.array(z.object({ staffId: uuid, status: z.enum(['present', 'absent', 'late', 'on_leave']) })).min(1).max(500) });
const salaryS = z.object({ effectiveFrom: z.string().date(), basicMinor: z.number().int().positive(), allowances: z.array(z.object({ name: z.string().min(1).max(60), amountMinor: z.number().int().min(0) })).default([]), deductions: z.array(z.object({ name: z.string().min(1).max(60), amountMinor: z.number().int().min(0) })).default([]) });
const sum = (xs: { amountMinor: number }[]) => xs.reduce((t, x) => t + x.amountMinor, 0);

@Controller()
export class HrController {
  constructor(private db: DbService) {}

  @Post('hr/staff')
  addStaff(@Auth() a: AuthContext, @Body() body: unknown) {
    const b = parse(profileS, body); needs(a, 'hr.manage', b.campusId);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const r = (await tx.query('insert into staff_profiles(tenant_id, user_id, campus_id, employee_no, designation, department, join_date, contract_end, qualifications) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id, employee_no', [a.tenantId, b.userId, b.campusId, b.employeeNo, b.designation, b.department ?? null, b.joinDate, b.contractEnd ?? null, b.qualifications ?? null])).rows[0];
      await audit(tx, a, a.tenantId, 'hr.staff_add', 'staff', r.id, b.campusId); return r;
    });
  }
  @Get('hr/staff')
  list(@Auth() a: AuthContext, @Query('status') status?: string) {
    needs(a, 'hr.read'); const scope = campusScope(a, 'hr.read');
    return this.db.withTenant(a.tenantId, async (tx) => (await tx.query(
      `select sp.id, sp.employee_no, sp.designation, sp.department, sp.join_date, sp.contract_end, sp.status, u.full_name, u.email from staff_profiles sp join users u on u.id = sp.user_id
       where ($1::uuid[] is null or sp.campus_id = any($1)) and ($2::text is null or sp.status = $2) order by u.full_name`, [scope, status ?? null])).rows);
  }
  @Post('hr/staff/:id/documents')
  addDoc(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id); const b = parse(docS, body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const sp = await this.staff(tx, a, id, 'hr.manage');
      return (await tx.query('insert into staff_documents(tenant_id, staff_id, kind, reference, expires_on) values ($1,$2,$3,$4,$5) returning id', [a.tenantId, sp.id, b.kind, b.reference ?? null, b.expiresOn ?? null])).rows[0];
    });
  }
  @Get('hr/document-alerts')
  docAlerts(@Auth() a: AuthContext) {
    needs(a, 'hr.read');
    return this.db.withTenant(a.tenantId, async (tx) => (await tx.query(
      `select u.full_name, d.kind, d.expires_on, (d.expires_on < current_date) as expired from staff_documents d join staff_profiles sp on sp.id = d.staff_id join users u on u.id = sp.user_id
       where d.expires_on is not null and d.expires_on <= current_date + 60 and sp.status = 'active' order by d.expires_on`)).rows);
  }

  @Post('hr/attendance')
  markAttendance(@Auth() a: AuthContext, @Body() body: unknown) {
    needs(a, 'hr.manage'); const b = parse(attS, body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      for (const e of b.entries) {
        const sp = await this.staff(tx, a, e.staffId, 'hr.manage');
        if (sp.status !== 'active') throw new UnprocessableEntityException({ error: 'staff_not_active', staffId: e.staffId });
        await tx.query('insert into staff_attendance(tenant_id, staff_id, att_date, status, marked_by) values ($1,$2,$3,$4,$5) on conflict (staff_id, att_date) do update set status = excluded.status, marked_by = excluded.marked_by', [a.tenantId, e.staffId, b.date, e.status, a.userId]);
      }
      return { saved: b.entries.length };
    });
  }

  /** Staff request their own leave; HR approves (never their own). */
  @Post('me/staff-leave')
  requestLeave(@Auth() a: AuthContext, @Body() body: unknown) {
    const b = parse(leaveS, body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const sp = (await tx.query(`select id from staff_profiles where user_id = $1 and status = 'active'`, [a.userId])).rows[0];
      if (!sp) throw new NotFoundException({ error: 'no_staff_profile' });
      const overlap = await tx.query(`select 1 from staff_leave_requests where staff_id = $1 and status in ('requested','approved') and daterange(from_date, to_date, '[]') && daterange($2::date, $3::date, '[]')`, [sp.id, b.fromDate, b.toDate]);
      if (overlap.rowCount) throw new ConflictException({ error: 'overlapping_leave' });
      return (await tx.query('insert into staff_leave_requests(tenant_id, staff_id, kind, from_date, to_date, reason) values ($1,$2,$3,$4,$5,$6) returning *', [a.tenantId, sp.id, b.kind, b.fromDate, b.toDate, b.reason ?? null])).rows[0];
    });
  }
  @Get('hr/leave')
  leaves(@Auth() a: AuthContext) {
    needs(a, 'hr.read');
    return this.db.withTenant(a.tenantId, async (tx) => (await tx.query(`select l.*, u.full_name from staff_leave_requests l join staff_profiles sp on sp.id = l.staff_id join users u on u.id = sp.user_id order by l.from_date desc limit 200`)).rows);
  }
  @Post('hr/leave/:id/decision')
  decideLeave(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id); const { decision } = parse(z.object({ decision: z.enum(['approve', 'reject']) }), body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [l] } = await tx.query('select l.*, sp.user_id, sp.campus_id from staff_leave_requests l join staff_profiles sp on sp.id = l.staff_id where l.id = $1 for update of l', [id]);
      if (!l || !can(a, 'hr.manage', l.campus_id)) throw new NotFoundException({ error: 'not_found' });
      if (l.status !== 'requested') throw new ConflictException({ error: 'already_decided' });
      if (l.user_id === a.userId) throw new UnprocessableEntityException({ error: 'cannot_decide_own_leave' });
      await tx.query('update staff_leave_requests set status = $2, decided_by = $3, decided_at = now() where id = $1', [id, decision === 'approve' ? 'approved' : 'rejected', a.userId]);
      await audit(tx, a, a.tenantId, `hr.leave_${decision}`, 'staff_leave', id, l.campus_id);
      return { decision };
    });
  }

  /** Offboarding: marks the employee exited, disables the account and revokes sessions (access revocation). */
  @Post('hr/staff/:id/exit')
  exit(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id); const { exitedOn } = parse(z.object({ exitedOn: z.string().date() }), body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const sp = await this.staff(tx, a, id, 'hr.manage');
      if (sp.status === 'exited') throw new ConflictException({ error: 'already_exited' });
      if (sp.user_id === a.userId) throw new UnprocessableEntityException({ error: 'cannot_exit_self' });
      await tx.query(`update staff_profiles set status = 'exited', exited_on = $2 where id = $1`, [id, exitedOn]);
      await tx.query(`update users set status = 'disabled' where id = $1`, [sp.user_id]);
      await tx.query('update sessions set revoked_at = now() where user_id = $1 and revoked_at is null', [sp.user_id]);
      await tx.query(`update courses set teacher_user_id = null where teacher_user_id = $1`, [sp.user_id]);
      await audit(tx, a, a.tenantId, 'hr.exit', 'staff', id, sp.campus_id, { exitedOn });
      return { exited: true, accessRevoked: true };
    });
  }

  // ---------------- payroll (separate permissions; payslips restricted) ----------------
  @Post('payroll/staff/:id/salary')
  setSalary(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id); const b = parse(salaryS, body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const sp = await this.staff(tx, a, id, 'payroll.manage');
      const r = (await tx.query('insert into salary_structures(tenant_id, staff_id, effective_from, basic_minor, allowances, deductions, created_by) values ($1,$2,$3,$4,$5,$6,$7) returning id', [a.tenantId, id, b.effectiveFrom, b.basicMinor, JSON.stringify(b.allowances), JSON.stringify(b.deductions), a.userId])).rows[0];
      await audit(tx, a, a.tenantId, 'payroll.salary_set', 'staff', id, sp.campus_id);
      return r;
    });
  }

  @Post('payroll/runs')
  createRun(@Auth() a: AuthContext, @Body() body: unknown) {
    needs(a, 'payroll.manage'); const { month } = parse(z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }), body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const dup = await tx.query('select id from payroll_runs where month = $1', [month]);
      if (dup.rowCount) throw new ConflictException({ error: 'run_exists', runId: dup.rows[0].id });
      const run = (await tx.query('insert into payroll_runs(tenant_id, month, created_by) values ($1,$2,$3) returning id, month, status', [a.tenantId, month, a.userId])).rows[0];
      const first = `${month}-01`;
      const staff = (await tx.query(
        `select sp.id, sp.campus_id, s.basic_minor, s.allowances, s.deductions,
           (select count(*)::int from staff_attendance sa where sa.staff_id = sp.id and sa.status = 'absent' and sa.att_date >= $1::date and sa.att_date < ($1::date + interval '1 month')) as absent_days,
           (select coalesce(sum(least(l.to_date, ($1::date + interval '1 month - 1 day')::date) - greatest(l.from_date, $1::date) + 1), 0)::int from staff_leave_requests l where l.staff_id = sp.id and l.status = 'approved' and l.kind = 'unpaid' and l.from_date <= ($1::date + interval '1 month - 1 day') and l.to_date >= $1::date) as unpaid_days
         from staff_profiles sp join lateral (select * from salary_structures x where x.staff_id = sp.id and x.effective_from <= ($1::date + interval '1 month - 1 day') order by x.effective_from desc limit 1) s on true
         where sp.status = 'active' and sp.join_date <= ($1::date + interval '1 month - 1 day') order by sp.employee_no`, [first])).rows;
      let total = 0;
      for (const s of staff) {
        if (!can(a, 'payroll.manage', s.campus_id)) continue;
        const allow = sum(s.allowances), ded = sum(s.deductions);
        const lossDays = s.absent_days + s.unpaid_days;
        const gross = Number(s.basic_minor) + allow;
        const absence = Math.round((gross / 30) * lossDays);
        const net = gross - ded - absence;
        await tx.query('insert into payslips(tenant_id, run_id, staff_id, basic_minor, allowances_minor, deductions_minor, absence_days, absence_deduction_minor, net_minor, detail) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
          [a.tenantId, run.id, s.id, s.basic_minor, allow, ded, lossDays, absence, net, JSON.stringify({ allowances: s.allowances, deductions: s.deductions, absentDays: s.absent_days, unpaidLeaveDays: s.unpaid_days })]);
        total += net;
      }
      await audit(tx, a, a.tenantId, 'payroll.run_create', 'payroll_run', run.id, null, { month, payslips: staff.length });
      return { ...run, payslips: staff.length, totalNetMinor: total };
    });
  }
  @Get('payroll/runs')
  runs(@Auth() a: AuthContext) {
    needs(a, 'payroll.manage');
    return this.db.withTenant(a.tenantId, async (tx) => (await tx.query(`select r.id, r.month, r.status, count(p.id)::int as payslips, coalesce(sum(p.net_minor),0)::bigint as total_net_minor from payroll_runs r left join payslips p on p.run_id = r.id group by r.id order by r.month desc`)).rows.map((r) => ({ ...r, total_net_minor: Number(r.total_net_minor) })));
  }
  @Post('payroll/runs/:id/decision')
  decideRun(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id); const { decision } = parse(z.object({ decision: z.enum(['approve', 'mark_paid']) }), body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [r] } = await tx.query('select * from payroll_runs where id = $1 for update', [id]);
      if (!r) throw new NotFoundException({ error: 'not_found' });
      needs(a, 'payroll.approve');
      if (decision === 'approve') {
        if (r.status !== 'draft') throw new ConflictException({ error: 'not_draft' });
        if (r.created_by === a.userId) throw new UnprocessableEntityException({ error: 'cannot_approve_own_run' });
        await tx.query(`update payroll_runs set status = 'approved', approved_by = $2, approved_at = now() where id = $1`, [id, a.userId]);
      } else {
        if (r.status !== 'approved') throw new ConflictException({ error: 'not_approved' });
        await tx.query(`update payroll_runs set status = 'paid', paid_at = now() where id = $1`, [id]);   // records payment only; no bank integration is configured
      }
      await audit(tx, a, a.tenantId, `payroll.${decision}`, 'payroll_run', id);
      return { status: decision === 'approve' ? 'approved' : 'paid' };
    });
  }
  @Get('payroll/runs/:id/payslips')
  runSlips(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id); needs(a, 'payroll.manage');
    return this.db.withTenant(a.tenantId, async (tx) => {
      const rows = (await tx.query(`select p.*, u.full_name, sp.employee_no from payslips p join staff_profiles sp on sp.id = p.staff_id join users u on u.id = sp.user_id where p.run_id = $1 order by sp.employee_no`, [id])).rows;
      await audit(tx, a, a.tenantId, 'payroll.payslips_read', 'payroll_run', id);
      return rows.map((p) => ({ ...p, basic_minor: Number(p.basic_minor), allowances_minor: Number(p.allowances_minor), deductions_minor: Number(p.deductions_minor), absence_deduction_minor: Number(p.absence_deduction_minor), net_minor: Number(p.net_minor) }));
    });
  }
  /** A staff member can read only their own payslips, and only once the run is approved. */
  @Get('me/payslips')
  mySlips(@Auth() a: AuthContext) {
    return this.db.withTenant(a.tenantId, async (tx) => (await tx.query(
      `select r.month, r.status, p.basic_minor, p.allowances_minor, p.deductions_minor, p.absence_deduction_minor, p.net_minor, p.detail from payslips p join payroll_runs r on r.id = p.run_id join staff_profiles sp on sp.id = p.staff_id
       where sp.user_id = $1 and r.status in ('approved','paid') order by r.month desc`, [a.userId])).rows.map((p) => ({ ...p, basic_minor: Number(p.basic_minor), allowances_minor: Number(p.allowances_minor), deductions_minor: Number(p.deductions_minor), absence_deduction_minor: Number(p.absence_deduction_minor), net_minor: Number(p.net_minor) })));
  }

  private async staff(tx: Tx, a: AuthContext, id: string, perm: 'hr.manage' | 'payroll.manage') {
    const { rows: [sp] } = await tx.query('select * from staff_profiles where id = $1', [id]);
    if (!sp || !can(a, perm, sp.campus_id)) throw new NotFoundException({ error: 'not_found' });
    return sp;
  }
}
