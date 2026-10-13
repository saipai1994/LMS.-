import { Body, ConflictException, Controller, Get, NotFoundException, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { DbService } from '../db/db.service';
import { Auth, AuthContext, campusScope, can, needs, parse, pid, uuid } from '../common/http';
import { audit } from '../common/audit';

const visitorS = z.object({ campusId: uuid, kind: z.enum(['visitor', 'contractor', 'vendor', 'guardian']).default('visitor'), fullName: z.string().min(2).max(100), phone: z.string().max(30).optional(), purpose: z.string().min(3).max(200), host: z.string().min(2).max(100), idType: z.string().min(2).max(40), idLast4: z.string().regex(/^[A-Za-z0-9]{4}$/), badgeNo: z.string().min(1).max(20) });
const drillS = z.object({ campusId: uuid, kind: z.enum(['fire', 'evacuation', 'lockdown', 'earthquake']) });

@Controller('security')
export class SecurityController {
  constructor(private db: DbService) {}

  @Post('visitors')
  checkIn(@Auth() a: AuthContext, @Body() body: unknown) {
    const b = parse(visitorS, body); needs(a, 'security.manage', b.campusId);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const onSite = await tx.query('select 1 from visitors where campus_id = $1 and badge_no = $2 and checked_out_at is null', [b.campusId, b.badgeNo]);
      if (onSite.rowCount) throw new ConflictException({ error: 'badge_in_use' });
      const v = (await tx.query('insert into visitors(tenant_id, campus_id, kind, full_name, phone, purpose, host, id_type, id_last4, badge_no, checked_in_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id, badge_no, checked_in_at', [a.tenantId, b.campusId, b.kind, b.fullName, b.phone ?? null, b.purpose, b.host, b.idType, b.idLast4, b.badgeNo, a.userId])).rows[0];
      await audit(tx, a, a.tenantId, 'security.visitor_in', 'visitor', v.id, b.campusId);
      return v;
    });
  }
  @Post('visitors/:id/checkout')
  checkOut(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [v] } = await tx.query('select * from visitors where id = $1 for update', [id]);
      if (!v || !can(a, 'security.manage', v.campus_id)) throw new NotFoundException({ error: 'not_found' });
      if (v.checked_out_at) throw new ConflictException({ error: 'already_checked_out' });
      await tx.query('update visitors set checked_out_at = now() where id = $1', [id]);
      await audit(tx, a, a.tenantId, 'security.visitor_out', 'visitor', id, v.campus_id);
      return { checkedOut: true };
    });
  }
  @Get('visitors/on-site')
  onSite(@Auth() a: AuthContext) {
    needs(a, 'security.manage'); const scope = campusScope(a, 'security.manage');
    return this.db.withTenant(a.tenantId, async (tx) => (await tx.query(`select id, kind, full_name, purpose, host, badge_no, checked_in_at from visitors where checked_out_at is null and ($1::uuid[] is null or campus_id = any($1)) order by checked_in_at`, [scope])).rows);
  }
  @Get('movements')
  movements(@Auth() a: AuthContext) {
    needs(a, 'security.manage');
    return this.db.withTenant(a.tenantId, async (tx) => (await tx.query(`select g.at, g.direction, s.first_name, s.last_name, s.admission_no from gate_movements g join students s on s.id = g.student_id order by g.id desc limit 100`)).rows);
  }

  /** Who must be accounted for in an evacuation: boarders not on leave, day scholars not yet collected, and visitors on site. */
  @Get('evacuation-roster')
  roster(@Auth() a: AuthContext) {
    needs(a, 'security.manage'); const scope = campusScope(a, 'security.manage');
    return this.db.withTenant(a.tenantId, async (tx) => {
      const students = (await tx.query(
        `select s.id, s.admission_no, s.first_name, s.last_name, ra.residence_type from students s
         join residence_assignments ra on ra.student_id = s.id and ra.effective_to is null
         where s.status = 'active' and ($1::uuid[] is null or s.campus_id = any($1))
           and ((ra.residence_type = 'boarder' and not exists (select 1 from leave_requests l where l.student_id = s.id and l.status = 'out'))
             or (ra.residence_type = 'day_scholar' and not exists (select 1 from pickup_events pe where pe.student_id = s.id and pe.event_date = current_date)))
         order by s.last_name, s.first_name`, [scope])).rows;
      const visitors = (await tx.query(`select id, full_name, kind, host, badge_no from visitors where checked_out_at is null and ($1::uuid[] is null or campus_id = any($1))`, [scope])).rows;
      return { students, visitors, expectedHeadcount: students.length + visitors.length };
    });
  }
  @Post('drills')
  startDrill(@Auth() a: AuthContext, @Body() body: unknown) {
    const b = parse(drillS, body); needs(a, 'security.manage', b.campusId);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const open = await tx.query('select id from drills where campus_id = $1 and completed_at is null', [b.campusId]);
      if (open.rowCount) throw new ConflictException({ error: 'drill_in_progress', drillId: open.rows[0].id });
      const expected = (await tx.query(`select count(*)::int n from students s join residence_assignments ra on ra.student_id = s.id and ra.effective_to is null where s.campus_id = $1 and s.status = 'active'`, [b.campusId])).rows[0].n;
      const d = (await tx.query('insert into drills(tenant_id, campus_id, kind, headcount_expected, started_by) values ($1,$2,$3,$4,$5) returning id, kind, headcount_expected', [a.tenantId, b.campusId, b.kind, expected, a.userId])).rows[0];
      await audit(tx, a, a.tenantId, 'security.drill_start', 'drill', d.id, b.campusId);
      return d;
    });
  }
  @Post('drills/:id/complete')
  endDrill(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id); const b = parse(z.object({ assembled: z.number().int().min(0), notes: z.string().max(500).optional() }), body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [d] } = await tx.query('select * from drills where id = $1 for update', [id]);
      if (!d || !can(a, 'security.manage', d.campus_id)) throw new NotFoundException({ error: 'not_found' });
      if (d.completed_at) throw new ConflictException({ error: 'already_completed' });
      await tx.query('update drills set completed_at = now(), headcount_assembled = $2, notes = $3 where id = $1', [id, b.assembled, b.notes ?? null]);
      await audit(tx, a, a.tenantId, 'security.drill_complete', 'drill', id, d.campus_id, { expected: d.headcount_expected, assembled: b.assembled });
      return { allAccountedFor: b.assembled >= d.headcount_expected, missing: Math.max(0, d.headcount_expected - b.assembled) };
    });
  }
}
