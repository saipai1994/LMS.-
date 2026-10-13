import { Body, ConflictException, Controller, Get, NotFoundException, Param, Post, Query, UnprocessableEntityException } from '@nestjs/common';
import { z } from 'zod';
import { DbService, Tx } from '../db/db.service';
import { Auth, AuthContext, can, needs, parse, pid, uuid } from '../common/http';
import { audit } from '../common/audit';
import { guardianUserIds, notify, studentAccess } from '../sis/access';

const bookS = z.object({ campusId: uuid, isbn: z.string().max(20).optional(), title: z.string().min(1).max(300), author: z.string().min(1).max(200), category: z.string().max(100).optional(), kind: z.enum(['physical', 'digital']).default('physical'), url: z.string().url().regex(/^https?:\/\//).optional(), barcodes: z.array(z.string().min(3).max(40)).max(50).default([]) });
const issueS = z.object({ barcode: z.string().min(3), studentId: uuid, days: z.number().int().min(1).max(60).default(14) });
const FINE_PER_DAY_MINOR = 200;   // ₹2/day; configurable per tenant is on the roadmap
const MAX_LOANS = 5;
const MAX_RENEWALS = 2;

@Controller('library')
export class LibraryController {
  constructor(private db: DbService) {}

  @Post('books')
  addBook(@Auth() a: AuthContext, @Body() body: unknown) {
    const b = parse(bookS, body); needs(a, 'library.manage', b.campusId);
    if (b.kind === 'physical' && !b.barcodes.length) throw new UnprocessableEntityException({ error: 'physical_books_need_barcodes' });
    if (b.kind === 'digital' && !b.url) throw new UnprocessableEntityException({ error: 'digital_resources_need_url' });
    return this.db.withTenant(a.tenantId, async (tx) => {
      const k = (await tx.query('insert into books(tenant_id, campus_id, isbn, title, author, category, kind, url) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id, title', [a.tenantId, b.campusId, b.isbn ?? null, b.title, b.author, b.category ?? null, b.kind, b.url ?? null])).rows[0];
      for (const bc of b.barcodes) await tx.query('insert into book_copies(tenant_id, book_id, barcode) values ($1,$2,$3)', [a.tenantId, k.id, bc]);
      return { ...k, copies: b.barcodes.length };
    });
  }

  /** Catalogue is visible to every signed-in member of the school. */
  @Get('books')
  search(@Auth() a: AuthContext, @Query('q') q?: string) {
    return this.db.withTenant(a.tenantId, async (tx) => (await tx.query(
      `select b.id, b.title, b.author, b.category, b.kind, b.url, b.isbn,
         count(c.id) filter (where c.status = 'available')::int as available, count(c.id)::int as copies
       from books b left join book_copies c on c.book_id = b.id
       where ($1::text is null or (b.title || ' ' || b.author || ' ' || coalesce(b.isbn, '')) ilike '%' || $1 || '%')
       group by b.id order by b.title limit 100`, [q ?? null])).rows);
  }

  @Post('issue')
  issue(@Auth() a: AuthContext, @Body() body: unknown) {
    const b = parse(issueS, body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [c] } = await tx.query('select c.*, bk.title, bk.campus_id from book_copies c join books bk on bk.id = c.book_id where c.barcode = $1 for update of c', [b.barcode]);
      if (!c || !can(a, 'library.manage', c.campus_id)) throw new NotFoundException({ error: 'not_found' });
      const { rows: [st] } = await tx.query('select id, first_name from students where id = $1', [b.studentId]);
      if (!st) throw new NotFoundException({ error: 'student_not_found' });
      if (c.status === 'held') {
        const res = await tx.query(`select 1 from reservations where held_copy_id = $1 and student_id = $2 and status = 'ready'`, [c.id, b.studentId]);
        if (!res.rowCount) throw new ConflictException({ error: 'copy_held_for_another_reader' });
      } else if (c.status !== 'available') throw new ConflictException({ error: 'copy_not_available', status: c.status });
      const open = (await tx.query('select count(*)::int n, count(*) filter (where due_on < current_date)::int overdue from loans where student_id = $1 and returned_on is null', [b.studentId])).rows[0];
      if (open.overdue > 0) throw new UnprocessableEntityException({ error: 'has_overdue_items' });
      if (open.n >= MAX_LOANS) throw new UnprocessableEntityException({ error: 'loan_limit_reached', limit: MAX_LOANS });
      const unpaid = (await tx.query('select coalesce(sum(fine_minor),0)::bigint n from loans where student_id = $1 and not fine_settled and fine_minor > 0', [b.studentId])).rows[0].n;
      if (Number(unpaid) > 0) throw new UnprocessableEntityException({ error: 'unpaid_fines', fineMinor: Number(unpaid) });
      const l = (await tx.query(`insert into loans(tenant_id, copy_id, student_id, due_on, issued_by) values ($1,$2,$3, current_date + $4::int, $5) returning id, due_on`, [a.tenantId, c.id, b.studentId, b.days, a.userId])).rows[0];
      await tx.query(`update book_copies set status = 'issued' where id = $1`, [c.id]);
      await tx.query(`update reservations set status = 'fulfilled' where held_copy_id = $1 and student_id = $2 and status = 'ready'`, [c.id, b.studentId]);
      await audit(tx, a, a.tenantId, 'library.issue', 'loan', l.id, c.campus_id);
      return { loanId: l.id, title: c.title, dueOn: l.due_on };
    });
  }

  @Post('return')
  return_(@Auth() a: AuthContext, @Body() body: unknown) {
    const { barcode, condition } = parse(z.object({ barcode: z.string().min(3), condition: z.enum(['ok', 'damaged', 'lost']).default('ok') }), body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [l] } = await tx.query(`select l.*, c.id as cid, c.book_id, bk.campus_id, bk.title from loans l join book_copies c on c.id = l.copy_id join books bk on bk.id = c.book_id where c.barcode = $1 and l.returned_on is null for update of l`, [barcode]);
      if (!l || !can(a, 'library.manage', l.campus_id)) throw new NotFoundException({ error: 'no_open_loan' });
      const lateDays = Math.max(0, Math.floor((Date.now() - Date.parse(`${l.due_on}T00:00:00Z`)) / 86_400_000));
      const fine = lateDays * FINE_PER_DAY_MINOR;
      await tx.query('update loans set returned_on = current_date, fine_minor = $2 where id = $1', [l.id, fine]);
      let copyStatus = condition === 'ok' ? 'available' : condition;
      let readyFor: string | null = null;
      if (copyStatus === 'available') {
        const { rows: [r] } = await tx.query(`select * from reservations where book_id = $1 and status = 'waiting' order by created_at limit 1 for update`, [l.book_id]);
        if (r) {
          await tx.query(`update reservations set status = 'ready', held_copy_id = $2 where id = $1`, [r.id, l.cid]);
          copyStatus = 'held'; readyFor = r.student_id;
          await notify(tx, a.tenantId, await guardianUserIds(tx, r.student_id), 'library.reservation_ready', 'Reserved book ready', `"${l.title}" is ready to collect from the library.`);
        }
      }
      await tx.query('update book_copies set status = $2 where id = $1', [l.cid, copyStatus]);
      if (fine > 0) await notify(tx, a.tenantId, await guardianUserIds(tx, l.student_id), 'library.fine', 'Library fine', `"${l.title}" was returned ${lateDays} day(s) late. Fine: ₹${fine / 100}.`);
      await audit(tx, a, a.tenantId, 'library.return', 'loan', l.id, l.campus_id, { lateDays, fineMinor: fine, condition });
      return { returned: true, lateDays, fineMinor: fine, heldForReservation: !!readyFor };
    });
  }

  @Post('loans/:id/renew')
  renew(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [l] } = await tx.query(`select l.*, c.book_id, bk.campus_id from loans l join book_copies c on c.id = l.copy_id join books bk on bk.id = c.book_id where l.id = $1 for update of l`, [id]);
      if (!l || !can(a, 'library.manage', l.campus_id)) throw new NotFoundException({ error: 'not_found' });
      if (l.returned_on) throw new ConflictException({ error: 'already_returned' });
      if (l.due_on < new Date().toISOString().slice(0, 10)) throw new UnprocessableEntityException({ error: 'overdue_cannot_renew' });
      if (l.renewals >= MAX_RENEWALS) throw new UnprocessableEntityException({ error: 'renewal_limit_reached' });
      if ((await tx.query(`select 1 from reservations where book_id = $1 and status = 'waiting'`, [l.book_id])).rowCount) throw new ConflictException({ error: 'reserved_by_another_reader' });
      const r = (await tx.query(`update loans set due_on = due_on + 14, renewals = renewals + 1 where id = $1 returning due_on, renewals`, [id])).rows[0];
      return r;
    });
  }

  @Post('reservations')
  reserve(@Auth() a: AuthContext, @Body() body: unknown) {
    const { bookId, studentId } = parse(z.object({ bookId: uuid, studentId: uuid }), body);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [s] } = await tx.query('select * from students where id = $1', [studentId]);
      const acc = s && await studentAccess(tx, a, s);
      if (!s || !acc || acc === 'teacher') throw new NotFoundException({ error: 'not_found' });
      if (acc === 'staff' && !can(a, 'library.manage', s.campus_id)) throw new NotFoundException({ error: 'not_found' });
      const avail = (await tx.query(`select count(*)::int n from book_copies where book_id = $1 and status = 'available'`, [bookId])).rows[0].n;
      if (avail > 0) throw new ConflictException({ error: 'copy_available_no_reservation_needed' });
      const total = (await tx.query('select count(*)::int n from book_copies where book_id = $1', [bookId])).rows[0].n;
      if (!total) throw new NotFoundException({ error: 'book_not_found' });
      const r = await tx.query(`insert into reservations(tenant_id, book_id, student_id) values ($1,$2,$3) on conflict do nothing returning id`, [a.tenantId, bookId, studentId]);
      if (!r.rowCount) throw new ConflictException({ error: 'already_reserved' });
      return { id: r.rows[0].id, position: (await tx.query(`select count(*)::int n from reservations where book_id = $1 and status = 'waiting'`, [bookId])).rows[0].n };
    });
  }

  @Get('overdue')
  overdue(@Auth() a: AuthContext) {
    needs(a, 'library.manage');
    return this.db.withTenant(a.tenantId, async (tx) => (await tx.query(
      `select l.id, l.due_on, current_date - l.due_on as days_overdue, (current_date - l.due_on) * ${FINE_PER_DAY_MINOR} as fine_so_far_minor, bk.title, s.first_name, s.last_name, s.admission_no
       from loans l join book_copies c on c.id = l.copy_id join books bk on bk.id = c.book_id join students s on s.id = l.student_id where l.returned_on is null and l.due_on < current_date order by l.due_on`)).rows);
  }

  @Post('loans/:id/settle-fine')
  settle(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [l] } = await tx.query(`select l.*, bk.campus_id from loans l join book_copies c on c.id = l.copy_id join books bk on bk.id = c.book_id where l.id = $1 for update of l`, [id]);
      if (!l || !can(a, 'library.manage', l.campus_id)) throw new NotFoundException({ error: 'not_found' });
      if (l.fine_minor <= 0 || l.fine_settled) throw new ConflictException({ error: 'no_fine_due' });
      await tx.query('update loans set fine_settled = true where id = $1', [id]);
      await audit(tx, a, a.tenantId, 'library.fine_settled', 'loan', id, l.campus_id, { fineMinor: Number(l.fine_minor) });
      return { settled: true };
    });
  }

  @Get('students/:id')
  studentLibrary(@Auth() a: AuthContext, @Param('id') id: string) {
    pid(id);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [s] } = await tx.query('select * from students where id = $1', [id]);
      if (!s || !(await studentAccess(tx, a, s))) throw new NotFoundException({ error: 'not_found' });
      return {
        loans: (await tx.query(`select l.id, bk.title, l.issued_on, l.due_on, l.returned_on, l.fine_minor, l.fine_settled, (l.returned_on is null and l.due_on < current_date) as overdue from loans l join book_copies c on c.id = l.copy_id join books bk on bk.id = c.book_id where l.student_id = $1 order by l.issued_on desc`, [id])).rows,
        reservations: (await tx.query(`select r.id, bk.title, r.status from reservations r join books bk on bk.id = r.book_id where r.student_id = $1 and r.status in ('waiting','ready')`, [id])).rows,
      };
    });
  }
}
void ({} as Tx);
