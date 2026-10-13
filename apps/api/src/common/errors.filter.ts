import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';

/** Consistent error envelope; maps database constraint failures to client errors. */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  private log = new Logger('Errors');
  catch(e: any, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();
    if (e instanceof HttpException) {
      const body = e.getResponse();
      return res.status(e.getStatus()).json(typeof body === 'string' ? { error: body } : body);
    }
    const map: Record<string, [number, string]> = {
      '23503': [400, 'invalid_reference'], '23505': [409, 'conflict'], '23P01': [409, 'overlapping_period'],
      '23514': [400, 'constraint_violation'], '22P02': [400, 'invalid_input'], '23502': [400, 'missing_value'],
    };
    const hit = e?.code && map[e.code];
    if (hit) return res.status(hit[0]).json({ error: hit[1], constraint: e.constraint });
    this.log.error(e?.stack ?? String(e));
    return res.status(500).json({ error: 'internal_error' });
  }
}
