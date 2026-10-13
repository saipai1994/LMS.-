import { Body, Controller, Get, NotFoundException, Param, PayloadTooLargeException, Post, Res, UnprocessableEntityException } from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { DbService, Tx } from '../db/db.service';
import { Auth, AuthContext, can, parse, pid } from '../common/http';
import { audit } from '../common/audit';
import { isGuardianOf } from '../sis/access';

const ALLOWED = new Set(['application/pdf', 'image/png', 'image/jpeg', 'text/plain', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.presentationml.presentation']);
const MAX_BYTES = 5 * 1024 * 1024;
const uploadS = z.object({ name: z.string().min(1).max(200).regex(/^[^/\\\0]+$/), mime: z.string(), contentBase64: z.string().min(1) });

const dir = () => process.env.FILE_STORAGE_DIR ?? path.join(process.cwd(), 'data', 'files');

/** Local-disk storage adapter. Swap for an S3-compatible adapter in production (see docs/INTEGRATIONS.md). */
@Controller('files')
export class FilesController {
  constructor(private db: DbService) {}

  @Post()
  upload(@Auth() a: AuthContext, @Body() body: unknown) {
    const b = parse(uploadS, body);
    if (!ALLOWED.has(b.mime)) throw new UnprocessableEntityException({ error: 'mime_not_allowed', allowed: [...ALLOWED] });
    const buf = Buffer.from(b.contentBase64, 'base64');
    if (!buf.length) throw new UnprocessableEntityException({ error: 'empty_file' });
    if (buf.length > MAX_BYTES) throw new PayloadTooLargeException({ error: 'file_too_large', maxBytes: MAX_BYTES });
    if (b.mime === 'application/pdf' && buf.subarray(0, 4).toString() !== '%PDF') throw new UnprocessableEntityException({ error: 'content_does_not_match_type' });
    if (b.mime === 'image/png' && buf.subarray(1, 4).toString() !== 'PNG') throw new UnprocessableEntityException({ error: 'content_does_not_match_type' });
    return this.db.withTenant(a.tenantId, async (tx) => {
      const id = randomUUID();
      const key = path.join(a.tenantId, id);
      fs.mkdirSync(path.join(dir(), a.tenantId), { recursive: true });
      fs.writeFileSync(path.join(dir(), key), buf, { mode: 0o600 });
      await tx.query('insert into files(id, tenant_id, uploaded_by, name, mime, size_bytes, sha256, storage_key) values ($1,$2,$3,$4,$5,$6,$7,$8)',
        [id, a.tenantId, a.userId, b.name, b.mime, buf.length, createHash('sha256').update(buf).digest('hex'), key]);
      await audit(tx, a, a.tenantId, 'file.upload', 'file', id);
      return { id, name: b.name, sizeBytes: buf.length };
    });
  }

  @Get(':id')
  download(@Auth() a: AuthContext, @Param('id') id: string, @Res() res: any) {
    pid(id);
    return this.db.withTenant(a.tenantId, async (tx) => {
      const { rows: [f] } = await tx.query('select * from files where id = $1', [id]);
      if (!f || !(await this.canRead(tx, a, f))) throw new NotFoundException({ error: 'not_found' });
      await audit(tx, a, a.tenantId, 'file.download', 'file', id);
      res.setHeader('Content-Type', f.mime);
      res.setHeader('Content-Disposition', `attachment; filename="${f.name.replace(/"/g, '')}"`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.send(fs.readFileSync(path.join(dir(), f.storage_key)));
    });
  }

  private async canRead(tx: Tx, a: AuthContext, f: { id: string; uploaded_by: string }): Promise<boolean> {
    if (f.uploaded_by === a.userId) return true;
    const links = (await tx.query('select entity_type, entity_id from file_links where file_id = $1', [f.id])).rows;
    for (const l of links) {
      if (l.entity_type === 'lesson') {
        const { rows: [r] } = await tx.query(
          `select c.teacher_user_id, sec.campus_id, exists (select 1 from course_enrollments ce join students s on s.id = ce.student_id where ce.course_id = c.id and ce.status = 'active' and s.user_id = $2) as enrolled
           from lessons l join courses c on c.id = l.course_id join sections sec on sec.id = c.section_id where l.id = $1`, [l.entity_id, a.userId]);
        if (r && (r.teacher_user_id === a.userId || can(a, 'course.manage', r.campus_id) || r.enrolled)) return true;
      } else {
        const { rows: [r] } = await tx.query(
          `select c.teacher_user_id, sec.campus_id, sub.student_id, st.user_id from submissions sub join assignments asg on asg.id = sub.assignment_id join courses c on c.id = asg.course_id
           join sections sec on sec.id = c.section_id join students st on st.id = sub.student_id where sub.id = $1`, [l.entity_id]);
        if (r && (r.teacher_user_id === a.userId || can(a, 'course.manage', r.campus_id) || r.user_id === a.userId || (await isGuardianOf(tx, a.userId, r.student_id)))) return true;
      }
    }
    return false;
  }
}
