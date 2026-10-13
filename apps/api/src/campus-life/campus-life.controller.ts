import { Body, ConflictException, Controller, Get, NotFoundException, Param, Post, Query, UnprocessableEntityException } from '@nestjs/common';
import { z } from 'zod';
import { DbService, Tx } from '../db/db.service';
import { Auth, AuthContext, campusScope, can, needs, parse, pid, uuid } from '../common/http';
import { audit } from '../common/audit';
import { guardianUserIds, isGuardianOf, notify, scopedStudent, studentAccess } from '../sis/access';

const TAGS = ['peanut', 'dairy', 'gluten', 'egg', 'shellfish', 'soy', 'fish', 'meat', 'vegetarian', 'vegan', 'halal'] as const;
/** Which menu allergen/ingredient tags a dietary flag conflicts with. */
const CONFLICTS: Record<string, string[]> = { vegetarian: ['meat', 'fish'], vegan: ['meat', 'fish', 'dairy', 'egg'] };
const conflicts = (flag: string, menuTags: string[]) => menuTags.includes(flag) || (CONFLICTS[flag] ?? []).some((t) => menuTags.includes(t));
const meal = z.enum(['breakfast', 'lunch', 'dinner', 'snack']);

const menuS = z.object({ campusId: uuid, date: z.string().date(), meal, items: z.string().min(2).max(500), allergenTags: z.array(z.enum(TAGS)).default([]), nutritionNote: z.string().max(200).optional() });
const actS = z.object({ campusId: uuid, name: z.string().min(2).max(100), kind: z.enum(['sport', 'club', 'event', 'trip']), capacity: z.number().int().min(1).max(500), coachUserId: uuid.optional(), requiresConsent: z.boolean().default(true), startsOn: z.string().date().optional() });
const calS = z.object({ campusId: uuid.nullable().default(null), title: z.string().min(2).max(200), kind: z.enum(['holiday', 'vacation', 'exam', 'ptm', 'event', 'trip', 'deadline']), startsOn: z.string().date(), endsOn: z.string().date() });

@Controller()
export class CampusLifeController {
  constructor(private db: DbService) {}

  // ---------------- meals ----------------
  @Post('meals/menus')
  menu(@Auth() a: AuthContext, @Body() body: unknown) {
    const b = parse(menuS, body); needs(a, 'meals.manage', b.campusId);
    return this.db.withTenant(a.tenantId, async (tx) => (await tx.query(
      `insert into menus(tenant_id, campus_id, menu_date, meal, items, allergen_tags, nutrition_note) values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (campus_id, menu_date, meal) do update set items = excluded.items, allergen_tags = excluded.allergen_tags, nutrition_note = excluded.nutrition_note returning id`,
      [a.tenantId, b.campusId, b.date, b.meal, b.items, b.allergenTags, b.nutritionNote ?? null])).rows[0]);
  }
  @Get('meals/menus')
  menus(@Auth() a: AuthContext, @Query('from') from?: string, @Query('to') to?: string) {
    const f = from ? parse(z.string().date(), from) : new Date().toISOString().slice(0, 10);
    const t = to ? parse(z.string().date(), to) : new Date(Date.now() + 6 * 86400000).toISOString().slice(0, 10);
    return this.db.withTenant(a.tenantId, async (tx) => (await tx.query('select menu_date, meal, items, allergen_tags, nutrition_note from menus where menu_date between $1 and $2 order by menu_date, meal', [f, t])).rows);
  }
  @Post('students/:id/dietary-flags')
  flags(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id); const { tags } = parse(z.object({ tags: z.array(z.enum(TAGS)).min(1).max(10) }), body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [s] } = await tx.query('select * from students where id = $1', [id]);
      if (!s || !((await isGuardianOf(tx, a.userId, id)) || can(a, 'medical.write', s.campus_id) || can(a, 'student.write', s.campus_id))) throw new NotFoundException({ error: 'not_found' });
      for (const t of tags) await tx.query('insert into dietary_flags(tenant_id, student_id, tag, added_by) values ($1,$2,$3,$4) on conflict do nothing', [a.tenantId, id, t, a.userId]);
      await audit(tx, a, a.tenantId, 'meals.dietary_flags', 'student', id, s.campus_id, { tags });
      return { tags };
    });
  }
  /** Residents expected at a meal (boarders not on leave) vs served; flags dietary conflicts with the menu. */
  @Get('meals/headcount')
  headcount(@Auth() a: AuthContext, @Query('date') date: string, @Query('meal') m: string) {
    needs(a, 'meals.read'); const d = parse(z.string().date(), date), ml = parse(meal, m); const scope = campusScope(a, 'meals.read');
    return this.db.withTenant(a.tenantId, async (tx) => {
      const menu = (await tx.query(`select m.* from menus m where m.menu_date = $1 and m.meal = $2 and ($3::uuid[] is null or m.campus_id = any($3)) limit 1`, [d, ml, scope])).rows[0];
      const expected = (await tx.query(
        `select s.id, s.first_name, s.last_name, s.admission_no, coalesce((select array_agg(tag) from dietary_flags f where f.student_id = s.id), '{}') as flags,
           exists (select 1 from meal_attendance ma where ma.student_id = s.id and ma.meal_date = $1 and ma.meal = $2) as served
         from students s join residence_assignments ra on ra.student_id = s.id and ra.effective_to is null and ra.residence_type = 'boarder'
         where s.status = 'active' and not exists (select 1 from leave_requests l where l.student_id = s.id and l.status = 'out' and l.gate_out_at::date <= $1) and ($3::uuid[] is null or s.campus_id = any($3))
         order by s.last_name`, [d, ml, scope])).rows;
      const menuTags: string[] = menu?.allergen_tags ?? [];
      const alerts = expected.filter((s) => (s.flags as string[]).some((f) => conflicts(f, menuTags))).map((s) => ({ studentId: s.id, name: `${s.first_name} ${s.last_name}`, admissionNo: s.admission_no, conflicts: (s.flags as string[]).filter((f) => conflicts(f, menuTags)) }));
      return { menu: menu ? { items: menu.items, allergenTags: menuTags } : null, expected: expected.length, served: expected.filter((s) => s.served).length, allergenAlerts: alerts };
    });
  }
  @Post('meals/attendance')
  served(@Auth() a: AuthContext, @Body() body: unknown) {
    const b = parse(z.object({ date: z.string().date(), meal, studentIds: z.array(uuid).min(1).max(500) }), body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const flagged: string[] = [];
      const menus = (await tx.query('select campus_id, allergen_tags from menus where menu_date = $1 and meal = $2', [b.date, b.meal])).rows;
      for (const sid of b.studentIds) {
        const s = await scopedStudent(tx, a, sid, 'meals.manage');
        const fl = (await tx.query('select tag from dietary_flags where student_id = $1', [sid])).rows.map((r) => r.tag as string);
        const mt: string[] = menus.find((m) => m.campus_id === s.campus_id)?.allergen_tags ?? [];
        if (fl.some((f) => conflicts(f, mt))) flagged.push(sid);
        await tx.query('insert into meal_attendance(tenant_id, student_id, meal_date, meal, recorded_by) values ($1,$2,$3,$4,$5) on conflict do nothing', [a.tenantId, sid, b.date, b.meal, a.userId]);
      }
      return { recorded: b.studentIds.length, dietaryConflictsServed: flagged };
    });
  }

  // ---------------- activities ----------------
  @Post('activities')
  addActivity(@Auth() a: AuthContext, @Body() body: unknown) {
    const b = parse(actS, body); needs(a, 'activities.manage', b.campusId);
    return this.db.withTenant(a.tenantId, async (tx) => (await tx.query('insert into activities(tenant_id, campus_id, name, kind, capacity, coach_user_id, requires_consent, starts_on) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id, name', [a.tenantId, b.campusId, b.name, b.kind, b.capacity, b.coachUserId ?? a.userId, b.requiresConsent, b.startsOn ?? null])).rows[0]);
  }
  @Get('activities')
  activities(@Auth() a: AuthContext) {
    return this.db.withTenant(a.tenantId, async (tx) => (await tx.query(
      `select ac.id, ac.name, ac.kind, ac.capacity, ac.requires_consent, ac.starts_on, u.full_name as coach,
         (select count(*) from activity_registrations r where r.activity_id = ac.id and r.status = 'registered')::int as registered,
         (select count(*) from activity_registrations r where r.activity_id = ac.id and r.status = 'waitlisted')::int as waitlisted
       from activities ac left join users u on u.id = ac.coach_user_id order by ac.name`)).rows);
  }
  /** Guardians register (their action is the consent); staff may register only with consent confirmed. */
  @Post('activities/:id/register')
  register(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id); const b = parse(z.object({ studentId: uuid, consentConfirmed: z.boolean().default(false) }), body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [ac] } = await tx.query('select * from activities where id = $1 for update', [id]);
      const { rows: [s] } = await tx.query('select * from students where id = $1', [b.studentId]);
      if (!ac || !s) throw new NotFoundException({ error: 'not_found' });
      const guardian = await isGuardianOf(tx, a.userId, s.id);
      if (!guardian && !can(a, 'activities.manage', ac.campus_id)) throw new NotFoundException({ error: 'not_found' });
      if (ac.requires_consent && !guardian && !b.consentConfirmed) throw new UnprocessableEntityException({ error: 'guardian_consent_required' });
      const taken = (await tx.query(`select count(*)::int n from activity_registrations where activity_id = $1 and status = 'registered'`, [id])).rows[0].n;
      const status = taken >= ac.capacity ? 'waitlisted' : 'registered';
      const r = await tx.query(`insert into activity_registrations(tenant_id, activity_id, student_id, status, consent_by, consent_at) values ($1,$2,$3,$4,$5, now()) on conflict do nothing returning id`, [a.tenantId, id, s.id, status, a.userId]);
      if (!r.rowCount) throw new ConflictException({ error: 'already_registered' });
      await audit(tx, a, a.tenantId, 'activities.register', 'activity', id, ac.campus_id, { studentId: s.id, status, guardianConsent: guardian });
      return { status };
    });
  }
  @Post('activities/:id/withdraw')
  withdraw(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id); const { studentId } = parse(z.object({ studentId: uuid }), body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [ac] } = await tx.query('select * from activities where id = $1 for update', [id]);
      if (!ac || !((await isGuardianOf(tx, a.userId, studentId)) || can(a, 'activities.manage', ac.campus_id))) throw new NotFoundException({ error: 'not_found' });
      const r = await tx.query(`update activity_registrations set status = 'withdrawn' where activity_id = $1 and student_id = $2 and status <> 'withdrawn' returning status`, [id, studentId]);
      if (!r.rowCount) throw new NotFoundException({ error: 'not_registered' });
      const { rows: [next] } = await tx.query(`select r.id, r.student_id, s.first_name from activity_registrations r join students s on s.id = r.student_id where r.activity_id = $1 and r.status = 'waitlisted' order by r.created_at limit 1`, [id]);
      let promoted: string | null = null;
      const registeredNow = (await tx.query(`select count(*)::int n from activity_registrations where activity_id = $1 and status = 'registered'`, [id])).rows[0].n;
      if (next && registeredNow < ac.capacity) {
        await tx.query(`update activity_registrations set status = 'registered' where id = $1`, [next.id]); promoted = next.student_id;
        await notify(tx, a.tenantId, await guardianUserIds(tx, next.student_id), 'activities.promoted', 'Place confirmed', `${next.first_name} now has a place in ${ac.name}.`);
      }
      return { withdrawn: true, promotedFromWaitlist: promoted };
    });
  }
  @Post('activities/:id/attendance')
  attendance(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id); const b = parse(z.object({ date: z.string().date(), entries: z.array(z.object({ studentId: uuid, present: z.boolean() })).min(1).max(500) }), body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [ac] } = await tx.query('select * from activities where id = $1', [id]);
      if (!ac || !(ac.coach_user_id === a.userId || can(a, 'activities.manage', ac.campus_id) && can(a, 'attendance.manage', ac.campus_id))) throw new NotFoundException({ error: 'not_found' });
      for (const e of b.entries) {
        const reg = await tx.query(`select 1 from activity_registrations where activity_id = $1 and student_id = $2 and status = 'registered'`, [id, e.studentId]);
        if (!reg.rowCount) throw new UnprocessableEntityException({ error: 'not_registered', studentId: e.studentId });
        await tx.query('insert into activity_attendance(tenant_id, activity_id, student_id, session_date, present) values ($1,$2,$3,$4,$5) on conflict (activity_id, student_id, session_date) do update set present = excluded.present', [a.tenantId, id, e.studentId, b.date, e.present]);
      }
      return { saved: b.entries.length };
    });
  }
  @Post('awards')
  award(@Auth() a: AuthContext, @Body() body: unknown) {
    const b = parse(z.object({ studentId: uuid, activityId: uuid.optional(), title: z.string().min(3).max(200), awardedOn: z.string().date() }), body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const s = await scopedStudent(tx, a, b.studentId, 'activities.manage');
      const r = (await tx.query('insert into awards(tenant_id, student_id, activity_id, title, awarded_on, awarded_by) values ($1,$2,$3,$4,$5,$6) returning id', [a.tenantId, s.id, b.activityId ?? null, b.title, b.awardedOn, a.userId])).rows[0];
      await notify(tx, a.tenantId, await guardianUserIds(tx, s.id), 'activities.award', 'Award', `${s.first_name} received: ${b.title}.`);
      return r;
    });
  }
  @Get('students/:id/activities')
  studentActivities(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [s] } = await tx.query('select * from students where id = $1', [id]);
      if (!s || !(await studentAccess(tx, a, s))) throw new NotFoundException({ error: 'not_found' });
      return {
        registrations: (await tx.query(`select ac.name, ac.kind, r.status from activity_registrations r join activities ac on ac.id = r.activity_id where r.student_id = $1 and r.status <> 'withdrawn'`, [id])).rows,
        awards: (await tx.query('select title, awarded_on from awards where student_id = $1 order by awarded_on desc', [id])).rows,
        attendance: (await tx.query(`select ac.name, count(*) filter (where present)::int as attended, count(*)::int as sessions from activity_attendance x join activities ac on ac.id = x.activity_id where x.student_id = $1 group by ac.name`, [id])).rows,
      };
    });
  }

  // ---------------- calendar & parent-teacher meetings ----------------
  @Post('calendar')
  addEvent(@Auth() a: AuthContext, @Body() body: unknown) {
    const b = parse(calS, body); needs(a, 'academic.manage', b.campusId);
    return this.db.withTenant(a.tenantId, async (tx) => (await tx.query('insert into calendar_events(tenant_id, campus_id, title, kind, starts_on, ends_on, created_by) values ($1,$2,$3,$4,$5,$6,$7) returning id', [a.tenantId, b.campusId, b.title, b.kind, b.startsOn, b.endsOn, a.userId])).rows[0]);
  }
  @Get('calendar')
  calendar(@Auth() a: AuthContext, @Query('from') from?: string, @Query('to') to?: string) {
    const f = from ? parse(z.string().date(), from) : '1900-01-01', t = to ? parse(z.string().date(), to) : '2999-12-31';
    return this.db.withTenant(a.tenantId, async (tx) => (await tx.query('select id, title, kind, starts_on, ends_on from calendar_events where ends_on >= $1 and starts_on <= $2 order by starts_on', [f, t])).rows);
  }
  @Post('ptm/slots')
  addSlot(@Auth() a: AuthContext, @Body() body: unknown) {
    const b = parse(z.object({ startsAt: z.string().datetime(), minutes: z.number().int().min(5).max(60).default(15) }), body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      if (!(await tx.query(`select 1 from courses where teacher_user_id = $1`, [a.userId])).rowCount) throw new NotFoundException({ error: 'not_a_teacher' });
      const end = new Date(Date.parse(b.startsAt) + b.minutes * 60000).toISOString();
      return (await tx.query('insert into ptm_slots(tenant_id, teacher_user_id, starts_at, ends_at) values ($1,$2,$3,$4) returning id, starts_at, ends_at', [a.tenantId, a.userId, b.startsAt, end])).rows[0];
    });
  }
  @Get('ptm/slots')
  slots(@Auth() a: AuthContext, @Query('teacherId') teacherId?: string) {
    return this.db.withTenant(a.tenantId, async (tx) => (await tx.query(
      `select p.id, p.starts_at, p.ends_at, u.full_name as teacher, p.teacher_user_id, (p.booked_student_id is not null) as booked, (p.booked_by = $1) as mine
       from ptm_slots p join users u on u.id = p.teacher_user_id where p.starts_at > now() and ($2::uuid is null or p.teacher_user_id = $2) and (p.booked_student_id is null or p.booked_by = $1 or p.teacher_user_id = $1)
       order by p.starts_at`, [a.userId, teacherId ? parse(uuid, teacherId) : null])).rows);
  }
  @Post('ptm/slots/:id/book')
  book(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id); const { studentId } = parse(z.object({ studentId: uuid }), body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      if (!(await isGuardianOf(tx, a.userId, studentId))) throw new NotFoundException({ error: 'not_found' });
      const { rows: [p] } = await tx.query('select * from ptm_slots where id = $1 for update', [id]);
      if (!p) throw new NotFoundException({ error: 'not_found' });
      const teaches = await tx.query(`select 1 from course_enrollments ce join courses c on c.id = ce.course_id where ce.student_id = $1 and c.teacher_user_id = $2 and ce.status = 'active'`, [studentId, p.teacher_user_id]);
      if (!teaches.rowCount) throw new UnprocessableEntityException({ error: 'teacher_does_not_teach_child' });
      if (p.booked_student_id) throw new ConflictException({ error: 'slot_taken' });
      await tx.query('update ptm_slots set booked_student_id = $2, booked_by = $3 where id = $1', [id, studentId, a.userId]);
      await notify(tx, a.tenantId, [p.teacher_user_id], 'ptm.booked', 'Meeting booked', `A parent booked a meeting at ${new Date(p.starts_at).toISOString()}.`);
      return { booked: true };
    });
  }
  @Post('ptm/slots/:id/cancel')
  cancel(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const r = await tx.query('update ptm_slots set booked_student_id = null, booked_by = null where id = $1 and booked_by = $2 returning id', [id, a.userId]);
      if (!r.rowCount) throw new NotFoundException({ error: 'not_found' });
      return { cancelled: true };
    });
  }
}
void ({} as Tx);
