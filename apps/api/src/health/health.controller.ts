import { Body, ConflictException, Controller, Get, NotFoundException, Param, Post, UnprocessableEntityException } from '@nestjs/common';
import { z } from 'zod';
import { DbService, Tx } from '../db/db.service';
import { Auth, AuthContext, campusScope, can, needs, parse, pid, uuid } from '../common/http';
import { audit } from '../common/audit';
import { guardianUserIds, isGuardianOf, notify, scopedStudent } from '../sis/access';

const visitS = z.object({ studentId: uuid, complaint: z.string().min(3).max(500), treatment: z.string().max(500).optional(), outcome: z.enum(['returned_to_class', 'rested', 'sent_home', 'referred', 'admitted']) });
const medS = z.object({ studentId: uuid, name: z.string().min(2).max(100), dose: z.string().min(1).max(100), schedule: z.string().min(2).max(200), startDate: z.string().date(), endDate: z.string().date().optional(), guardianConsent: z.boolean(), prescribedBy: z.string().max(100).optional() });
const refS = z.object({ studentId: uuid, reason: z.string().min(3).max(1000) });

@Controller()
export class HealthController {
  constructor(private db: DbService) {}

  @Post('health/visits')
  visit(@Auth() a: AuthContext, @Body() body: unknown) {
    const b = parse(visitS, body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const s = await scopedStudent(tx, a, b.studentId, 'medical.write');
      const v = (await tx.query('insert into clinic_visits(tenant_id, student_id, complaint, treatment, outcome, recorded_by) values ($1,$2,$3,$4,$5,$6) returning id, visited_at', [a.tenantId, s.id, b.complaint, b.treatment ?? null, b.outcome, a.userId])).rows[0];
      // guardians are told about every clinic visit that ends in more than a short rest
      if (['sent_home', 'referred', 'admitted'].includes(b.outcome))
        await notify(tx, a.tenantId, await guardianUserIds(tx, s.id), 'health.visit', 'Clinic visit', `${s.first_name} visited the school clinic (${b.outcome.replace('_', ' ')}). Please contact the school.`);
      await audit(tx, a, a.tenantId, 'health.visit', 'student', s.id, s.campus_id, { outcome: b.outcome });
      return v;
    });
  }
  /** Clinical history: nurse (medical.read) or the child's guardian (complaint/outcome only). */
  @Get('health/students/:id/visits')
  visits(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [s] } = await tx.query('select * from students where id = $1', [id]);
      const clinical = s && can(a, 'medical.read', s.campus_id);
      if (!s || !(clinical || (await isGuardianOf(tx, a.userId, id)))) throw new NotFoundException({ error: 'not_found' });
      if (clinical) await audit(tx, a, a.tenantId, 'medical.read', 'student', id, s.campus_id);
      return (await tx.query(`select id, visited_at, complaint, outcome${clinical ? ', treatment' : ''} from clinic_visits where student_id = $1 order by visited_at desc`, [id])).rows;
    });
  }

  @Post('health/medications')
  prescribe(@Auth() a: AuthContext, @Body() body: unknown) {
    const b = parse(medS, body);
    if (!b.guardianConsent) throw new UnprocessableEntityException({ error: 'guardian_consent_required' });
    return this.db.withTenant(a.tenantId, async (tx) => {
      const s = await scopedStudent(tx, a, b.studentId, 'medical.write');
      const m = (await tx.query('insert into medications(tenant_id, student_id, name, dose, schedule, start_date, end_date, guardian_consent, prescribed_by) values ($1,$2,$3,$4,$5,$6,$7,true,$8) returning id', [a.tenantId, s.id, b.name, b.dose, b.schedule, b.startDate, b.endDate ?? null, b.prescribedBy ?? null])).rows[0];
      await audit(tx, a, a.tenantId, 'health.medication_add', 'student', s.id, s.campus_id);
      return m;
    });
  }
  @Post('health/medications/:id/administer')
  administer(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id); const { note } = parse(z.object({ note: z.string().max(200).optional() }), body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [m] } = await tx.query('select m.*, s.campus_id from medications m join students s on s.id = m.student_id where m.id = $1', [id]);
      if (!m || !can(a, 'medical.write', m.campus_id)) throw new NotFoundException({ error: 'not_found' });
      const today = new Date().toISOString().slice(0, 10);
      if (m.start_date > today || (m.end_date && m.end_date < today)) throw new UnprocessableEntityException({ error: 'outside_prescribed_period' });
      const recent = await tx.query(`select 1 from medication_log where medication_id = $1 and given_at > now() - interval '1 minute'`, [id]);
      if (recent.rowCount) throw new ConflictException({ error: 'duplicate_administration' });
      await tx.query('insert into medication_log(tenant_id, medication_id, given_by, note) values ($1,$2,$3,$4)', [a.tenantId, id, a.userId, note ?? null]);
      await audit(tx, a, a.tenantId, 'health.medication_given', 'medication', id, m.campus_id);
      return { logged: true };
    });
  }
  @Get('health/medications/:id/log')
  medLog(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [m] } = await tx.query('select m.*, s.campus_id from medications m join students s on s.id = m.student_id where m.id = $1', [id]);
      if (!m || !can(a, 'medical.read', m.campus_id)) throw new NotFoundException({ error: 'not_found' });
      return (await tx.query('select l.given_at, u.full_name as given_by, l.note from medication_log l join users u on u.id = l.given_by where l.medication_id = $1 order by l.id', [id])).rows;
    });
  }

  @Post('health/medicine-stock')
  stock(@Auth() a: AuthContext, @Body() body: unknown) {
    const b = parse(z.object({ campusId: uuid, name: z.string().min(2).max(100), qty: z.number().int().min(0), expiresOn: z.string().date() }), body);
    needs(a, 'medical.write', b.campusId);
    return this.db.withTenant(a.tenantId, async (tx) => (await tx.query('insert into medicine_stock(tenant_id, campus_id, name, qty, expires_on) values ($1,$2,$3,$4,$5) returning id', [a.tenantId, b.campusId, b.name, b.qty, b.expiresOn])).rows[0]);
  }
  @Get('health/medicine-alerts')
  stockAlerts(@Auth() a: AuthContext) {
    needs(a, 'medical.read'); const scope = campusScope(a, 'medical.read');
    return this.db.withTenant(a.tenantId, async (tx) => (await tx.query(`select name, qty, expires_on, (expires_on < current_date) as expired from medicine_stock where expires_on <= current_date + 60 and ($1::uuid[] is null or campus_id = any($1)) order by expires_on`, [scope])).rows);
  }

  // Counselling: confidential; separate permission; staff who merely refer cannot read notes.
  @Post('counselling/referrals')
  refer(@Auth() a: AuthContext, @Body() body: unknown) {
    const b = parse(refS, body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [s] } = await tx.query('select * from students where id = $1', [b.studentId]);
      if (!s || !(can(a, 'student.read', s.campus_id) || can(a, 'incident.report', s.campus_id) || can(a, 'counselling.manage', s.campus_id))) throw new NotFoundException({ error: 'not_found' });
      const r = (await tx.query('insert into counselling_referrals(tenant_id, student_id, referred_by, reason) values ($1,$2,$3,$4) returning id, status', [a.tenantId, s.id, a.userId, b.reason])).rows[0];
      await audit(tx, a, a.tenantId, 'counselling.refer', 'student', s.id, s.campus_id);
      return r;
    });
  }
  @Get('counselling/referrals')
  referrals(@Auth() a: AuthContext) {
    needs(a, 'counselling.manage');
    return this.db.withTenant(a.tenantId, async (tx) => {
      const rows = (await tx.query(`select r.id, r.reason, r.status, r.created_at, r.confidential_notes, s.first_name, s.last_name, s.admission_no from counselling_referrals r join students s on s.id = r.student_id order by r.created_at desc`)).rows;
      await audit(tx, a, a.tenantId, 'counselling.read', 'counselling_referrals', undefined);
      return rows;
    });
  }
  @Post('counselling/referrals/:id/update')
  updateReferral(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id); needs(a, 'counselling.manage');
    const b = parse(z.object({ status: z.enum(['open', 'scheduled', 'closed']), notes: z.string().max(4000).optional() }), body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const r = await tx.query('update counselling_referrals set status = $2, confidential_notes = coalesce($3, confidential_notes) where id = $1 returning id', [id, b.status, b.notes ?? null]);
      if (!r.rowCount) throw new NotFoundException({ error: 'not_found' });
      await audit(tx, a, a.tenantId, 'counselling.update', 'counselling_referral', id);
      return { updated: true };
    });
  }
}
void ({} as Tx);
