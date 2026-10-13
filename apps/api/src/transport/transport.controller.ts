import { Body, ConflictException, Controller, Get, NotFoundException, Param, Post, Query, UnprocessableEntityException } from '@nestjs/common';
import { z } from 'zod';
import { DbService, Tx } from '../db/db.service';
import { Auth, AuthContext, campusScope, can, needs, parse, pid, uuid } from '../common/http';
import { audit } from '../common/audit';
import { guardianUserIds, notify, scopedStudent, studentAccess } from '../sis/access';

const vehicleS = z.object({ campusId: uuid, regNo: z.string().min(3).max(20), capacity: z.number().int().min(1).max(80), insuranceExpiry: z.string().date().optional(), permitExpiry: z.string().date().optional(), fitnessExpiry: z.string().date().optional() });
const driverS = z.object({ campusId: uuid, fullName: z.string().min(2).max(100), phone: z.string().max(30).optional(), licenceNo: z.string().min(4).max(30), licenceExpiry: z.string().date(), userId: uuid.optional() });
const routeS = z.object({
  campusId: uuid, name: z.string().min(2).max(100), vehicleId: uuid.optional(), driverId: uuid.optional(), attendantName: z.string().max(100).optional(),
  stops: z.array(z.object({ name: z.string().min(2).max(100), pickupTime: z.string().regex(/^\d{2}:\d{2}$/).optional(), dropTime: z.string().regex(/^\d{2}:\d{2}$/).optional() })).min(1).max(40),
});
const assignS = z.object({ studentId: uuid, routeId: uuid, stopId: uuid, effectiveFrom: z.string().date() });
const tripS = z.object({ routeId: uuid, date: z.string().date(), shift: z.enum(['am', 'pm']) });
const eventS = z.object({ studentId: uuid, event: z.enum(['boarded', 'dropped']) });
const maintS = z.object({ kind: z.enum(['service', 'repair', 'inspection', 'fuel']), doneOn: z.string().date(), costMinor: z.number().int().min(0).default(0), notes: z.string().max(500).optional(), nextDue: z.string().date().optional() });
const dayBefore = (d: string) => new Date(Date.parse(d) - 86_400_000).toISOString().slice(0, 10);

/** Replaceable GPS provider boundary. Only the DEMO provider exists; no real tracking is configured. */
export interface GpsProvider { name: string; simulated: boolean; position(stops: { name: string }[], now: Date): { lat: number; lng: number; nearestStop: string } }
export const demoGps: GpsProvider = {
  name: 'demo', simulated: true,
  position: (stops, now) => {
    const i = Math.floor((now.getMinutes() / 60) * stops.length) % stops.length;
    return { lat: 12.9 + i * 0.01, lng: 77.5 + i * 0.012, nearestStop: stops[i].name };
  },
};

@Controller('transport')
export class TransportController {
  constructor(private db: DbService) {}

  @Post('vehicles')
  addVehicle(@Auth() a: AuthContext, @Body() body: unknown) {
    const b = parse(vehicleS, body); needs(a, 'transport.manage', b.campusId);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const r = (await tx.query('insert into vehicles(tenant_id, campus_id, reg_no, capacity, insurance_expiry, permit_expiry, fitness_expiry) values ($1,$2,$3,$4,$5,$6,$7) returning *', [a.tenantId, b.campusId, b.regNo, b.capacity, b.insuranceExpiry ?? null, b.permitExpiry ?? null, b.fitnessExpiry ?? null])).rows[0];
      await audit(tx, a, a.tenantId, 'transport.vehicle_add', 'vehicle', r.id, b.campusId); return r;
    });
  }
  @Post('drivers')
  addDriver(@Auth() a: AuthContext, @Body() body: unknown) {
    const b = parse(driverS, body); needs(a, 'transport.manage', b.campusId);
    return this.db.withTenant(a.tenantId, async (tx) => (await tx.query('insert into drivers(tenant_id, campus_id, full_name, phone, licence_no, licence_expiry, user_id) values ($1,$2,$3,$4,$5,$6,$7) returning id, full_name, licence_expiry', [a.tenantId, b.campusId, b.fullName, b.phone ?? null, b.licenceNo, b.licenceExpiry, b.userId ?? null])).rows[0]);
  }
  @Post('vehicles/:id/maintenance')
  maintenance(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id); const b = parse(maintS, body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [v] } = await tx.query('select * from vehicles where id = $1', [id]);
      if (!v || !can(a, 'transport.manage', v.campus_id)) throw new NotFoundException({ error: 'not_found' });
      return (await tx.query('insert into vehicle_maintenance(tenant_id, vehicle_id, kind, done_on, cost_minor, notes, next_due, recorded_by) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id', [a.tenantId, id, b.kind, b.doneOn, b.costMinor, b.notes ?? null, b.nextDue ?? null, a.userId])).rows[0];
    });
  }

  @Post('routes')
  addRoute(@Auth() a: AuthContext, @Body() body: unknown) {
    const b = parse(routeS, body); needs(a, 'transport.manage', b.campusId);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const r = (await tx.query('insert into transport_routes(tenant_id, campus_id, name, vehicle_id, driver_id, attendant_name) values ($1,$2,$3,$4,$5,$6) returning id, name', [a.tenantId, b.campusId, b.name, b.vehicleId ?? null, b.driverId ?? null, b.attendantName ?? null])).rows[0];
      let seq = 1;
      for (const s of b.stops) await tx.query('insert into route_stops(tenant_id, route_id, seq, name, pickup_time, drop_time) values ($1,$2,$3,$4,$5,$6)', [a.tenantId, r.id, seq++, s.name, s.pickupTime ?? null, s.dropTime ?? null]);
      await audit(tx, a, a.tenantId, 'transport.route_add', 'route', r.id, b.campusId);
      return { ...r, stops: b.stops.length };
    });
  }

  @Get('routes')
  routes(@Auth() a: AuthContext) {
    needs(a, 'transport.read');
    const scope = campusScope(a, 'transport.read');
    return this.db.withTenant(a.tenantId, async (tx) => (await tx.query(
      `select r.id, r.name, r.attendant_name, v.reg_no, v.capacity, d.full_name as driver,
         (select count(*) from student_transport st where st.route_id = r.id and st.effective_to is null)::int as riders,
         (select json_agg(json_build_object('id', s.id, 'seq', s.seq, 'name', s.name, 'pickup', s.pickup_time, 'drop', s.drop_time) order by s.seq) from route_stops s where s.route_id = r.id) as stops
       from transport_routes r left join vehicles v on v.id = r.vehicle_id left join drivers d on d.id = r.driver_id
       where ($1::uuid[] is null or r.campus_id = any($1)) order by r.name`, [scope])).rows
      .map((r) => ({ ...r, utilizationPercent: r.capacity ? Math.round((r.riders / r.capacity) * 100) : null })));
  }

  @Post('assignments')
  assign(@Auth() a: AuthContext, @Body() body: unknown) {
    const b = parse(assignS, body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const s = await scopedStudent(tx, a, b.studentId, 'transport.manage');
      const { rows: [route] } = await tx.query('select r.*, v.capacity from transport_routes r left join vehicles v on v.id = r.vehicle_id where r.id = $1 for update of r', [b.routeId]);
      if (!route || route.campus_id !== s.campus_id) throw new UnprocessableEntityException({ error: 'route_not_on_student_campus' });
      const stop = await tx.query('select 1 from route_stops where id = $1 and route_id = $2', [b.stopId, b.routeId]);
      if (!stop.rowCount) throw new UnprocessableEntityException({ error: 'stop_not_on_route' });
      if (!route.capacity) throw new UnprocessableEntityException({ error: 'route_has_no_vehicle' });
      const riders = (await tx.query('select count(*)::int n from student_transport where route_id = $1 and effective_to is null and student_id <> $2', [b.routeId, s.id])).rows[0].n;
      if (riders >= route.capacity) throw new ConflictException({ error: 'vehicle_full', capacity: route.capacity });
      const { rows: [cur] } = await tx.query('select * from student_transport where student_id = $1 and effective_to is null for update', [s.id]);
      if (cur) {
        if (cur.route_id === b.routeId && cur.stop_id === b.stopId) throw new ConflictException({ error: 'no_change' });
        if (b.effectiveFrom <= cur.effective_from) throw new UnprocessableEntityException({ error: 'effective_date_before_current' });
        await tx.query('update student_transport set effective_to = $2 where id = $1', [cur.id, dayBefore(b.effectiveFrom)]);
      }
      const r = (await tx.query('insert into student_transport(tenant_id, student_id, route_id, stop_id, effective_from) values ($1,$2,$3,$4,$5) returning id', [a.tenantId, s.id, b.routeId, b.stopId, b.effectiveFrom])).rows[0];
      await audit(tx, a, a.tenantId, cur ? 'transport.route_change' : 'transport.assign', 'student', s.id, s.campus_id, { routeId: b.routeId });
      return r;
    });
  }

  @Get('students/:id')
  studentTransport(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [s] } = await tx.query('select * from students where id = $1', [id]);
      if (!s || !(await studentAccess(tx, a, s))) throw new NotFoundException({ error: 'not_found' });
      const { rows: [t] } = await tx.query(
        `select r.id as route_id, r.name as route, st.name as stop, st.pickup_time, st.drop_time, v.reg_no, d.full_name as driver, d.phone as driver_phone, r.attendant_name
         from student_transport x join transport_routes r on r.id = x.route_id join route_stops st on st.id = x.stop_id left join vehicles v on v.id = r.vehicle_id left join drivers d on d.id = r.driver_id
         where x.student_id = $1 and x.effective_to is null`, [id]);
      const today = t ? (await tx.query(`select tr.shift, tr.status, (select json_agg(te.event) from trip_events te where te.trip_id = tr.id and te.student_id = $1) as events from trips tr where tr.route_id = $2 and tr.trip_date = current_date order by tr.shift`, [id, t.route_id])).rows : [];
      return { assignment: t ?? null, today };
    });
  }

  // ---- trips: manifest, boarding / drop-off confirmation ----
  @Post('trips')
  startTrip(@Auth() a: AuthContext, @Body() body: unknown) {
    const b = parse(tripS, body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [r] } = await tx.query('select * from transport_routes where id = $1', [b.routeId]);
      if (!r || !can(a, 'transport.operate', r.campus_id)) throw new NotFoundException({ error: 'not_found' });
      const dup = await tx.query('select id from trips where route_id = $1 and trip_date = $2 and shift = $3', [b.routeId, b.date, b.shift]);
      if (dup.rowCount) throw new ConflictException({ error: 'trip_exists', tripId: dup.rows[0].id });
      const t = (await tx.query('insert into trips(tenant_id, route_id, trip_date, shift, started_by) values ($1,$2,$3,$4,$5) returning id, status', [a.tenantId, b.routeId, b.date, b.shift, a.userId])).rows[0];
      await audit(tx, a, a.tenantId, 'transport.trip_start', 'trip', t.id, r.campus_id);
      return t;
    });
  }

  @Get('trips/:id')
  manifest(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const trip = await this.trip(tx, a, id, 'transport.read');
      const riders = (await tx.query(
        `select s.id as student_id, s.admission_no, s.first_name, s.last_name, st.name as stop,
           bool_or(te.event = 'boarded') as boarded, bool_or(te.event = 'dropped') as dropped
         from student_transport x join students s on s.id = x.student_id join route_stops st on st.id = x.stop_id
         left join trip_events te on te.trip_id = $2 and te.student_id = s.id
         where x.route_id = $1 and x.effective_from <= $3 and (x.effective_to is null or x.effective_to >= $3) group by s.id, st.name, st.seq order by st.seq, s.last_name`, [trip.route_id, id, trip.trip_date])).rows;
      return { trip: { id: trip.id, status: trip.status, shift: trip.shift, date: trip.trip_date }, riders };
    });
  }

  @Post('trips/:id/events')
  record(@Auth() a: AuthContext, @Param('id') id: string, @Body() body: unknown) {
    pid(id); const b = parse(eventS, body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const trip = await this.trip(tx, a, id, 'transport.operate');
      if (trip.status !== 'in_progress') throw new ConflictException({ error: 'trip_completed' });
      const onRoute = await tx.query('select 1 from student_transport where student_id = $1 and route_id = $2 and effective_from <= $3 and (effective_to is null or effective_to >= $3)', [b.studentId, trip.route_id, trip.trip_date]);
      if (!onRoute.rowCount) throw new UnprocessableEntityException({ error: 'student_not_assigned_to_route' });
      if (b.event === 'dropped') {
        const boarded = await tx.query(`select 1 from trip_events where trip_id = $1 and student_id = $2 and event = 'boarded'`, [id, b.studentId]);
        if (!boarded.rowCount) throw new UnprocessableEntityException({ error: 'not_boarded' });
      }
      const ins = await tx.query('insert into trip_events(tenant_id, trip_id, student_id, event, recorded_by) values ($1,$2,$3,$4,$5) on conflict do nothing returning id', [a.tenantId, id, b.studentId, b.event, a.userId]);
      if (!ins.rowCount) throw new ConflictException({ error: 'already_recorded' });
      const { rows: [s] } = await tx.query('select first_name from students where id = $1', [b.studentId]);
      await notify(tx, a.tenantId, await guardianUserIds(tx, b.studentId), `transport.${b.event}`, b.event === 'boarded' ? 'Boarded the bus' : 'Dropped off', `${s.first_name} ${b.event === 'boarded' ? 'boarded' : 'was dropped off from'} the ${trip.shift === 'am' ? 'morning' : 'afternoon'} bus.`);
      return { recorded: b.event };
    });
  }

  @Post('trips/:id/complete')
  complete(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const trip = await this.trip(tx, a, id, 'transport.operate');
      if (trip.status !== 'in_progress') throw new ConflictException({ error: 'trip_completed' });
      const unaccounted = (await tx.query(`select s.id as student_id, s.first_name, s.last_name from trip_events te join students s on s.id = te.student_id where te.trip_id = $1 and te.event = 'boarded' and not exists (select 1 from trip_events d where d.trip_id = $1 and d.student_id = te.student_id and d.event = 'dropped')`, [id])).rows;
      // A trip with students still aboard cannot be closed silently on an afternoon run.
      if (trip.shift === 'pm' && unaccounted.length) throw new ConflictException({ error: 'students_not_dropped', students: unaccounted });
      await tx.query(`update trips set status = 'completed', completed_at = now() where id = $1`, [id]);
      await audit(tx, a, a.tenantId, 'transport.trip_complete', 'trip', id);
      return { status: 'completed', stillAboard: unaccounted };
    });
  }

  /** Simulated position — DEMO provider only; clearly labelled. */
  @Get('trips/:id/location')
  location(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const trip = await this.trip(tx, a, id, 'transport.read');
      const stops = (await tx.query('select name from route_stops where route_id = $1 order by seq', [trip.route_id])).rows;
      return { ...demoGps.position(stops, new Date()), provider: demoGps.name, simulated: true, notice: 'DEMO / SIMULATED location — no GPS device is connected' };
    });
  }

  /** Documents expiring soon (or expired): vehicles and driver licences. */
  @Get('alerts')
  alerts(@Auth() a: AuthContext, @Query('days') days = '30') {
    needs(a, 'transport.read');
    const d = Math.min(Math.max(parseInt(days) || 30, 1), 365);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const rows = (await tx.query(
        `select 'vehicle' as kind, reg_no as subject, doc, expires_on, (expires_on < current_date) as expired from (
           select reg_no, 'insurance' as doc, insurance_expiry as expires_on from vehicles union all
           select reg_no, 'permit', permit_expiry from vehicles union all select reg_no, 'fitness', fitness_expiry from vehicles) v
         where expires_on is not null and expires_on <= current_date + $1::int
         union all select 'driver', full_name, 'licence', licence_expiry, (licence_expiry < current_date) from drivers where licence_expiry <= current_date + $1::int
         order by expires_on`, [d])).rows;
      return rows;
    });
  }

  private async trip(tx: Tx, a: AuthContext, id: string, perm: 'transport.read' | 'transport.operate') {
    const { rows: [t] } = await tx.query('select t.*, r.campus_id from trips t join transport_routes r on r.id = t.route_id where t.id = $1', [id]);
    if (!t || !can(a, perm, t.campus_id)) throw new NotFoundException({ error: 'not_found' });
    return t;
  }
}
