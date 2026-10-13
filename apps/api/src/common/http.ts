import { BadRequestException, createParamDecorator, ExecutionContext, ForbiddenException, SetMetadata } from '@nestjs/common';
import { z, ZodTypeAny } from 'zod';
import type { Permission } from './permissions';

export interface Grant { permission: string; campusId: string | null }
export interface AuthContext {
  tenantId: string; userId: string; email: string; grants: Grant[];
  mfaEnabled: boolean; privileged: boolean; ip?: string;
}

export const IS_PUBLIC = 'isPublic';
export const ALLOW_NO_MFA = 'allowNoMfa';
export const Public = () => SetMetadata(IS_PUBLIC, true);
export const AllowWithoutMfa = () => SetMetadata(ALLOW_NO_MFA, true);
export const Auth = createParamDecorator((_d, ctx: ExecutionContext): AuthContext => ctx.switchToHttp().getRequest().auth);

export function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw new BadRequestException({ error: 'validation_failed', issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
  }
  return r.data;
}
export const uuid = z.string().uuid();

/** True if the actor holds `permission` for this campus (or tenant-wide). */
export function can(auth: AuthContext, permission: Permission, campusId?: string | null): boolean {
  return auth.grants.some((g) => g.permission === permission && (g.campusId === null || campusId === undefined || g.campusId === campusId));
}
export function needs(auth: AuthContext, permission: Permission, campusId?: string | null): void {
  if (!can(auth, permission, campusId)) throw new ForbiddenException({ error: 'forbidden', required: permission });
}
/** Campuses where the actor holds the permission; null = all campuses. */
export function campusScope(auth: AuthContext, permission: Permission): string[] | null {
  const gs = auth.grants.filter((g) => g.permission === permission);
  if (gs.some((g) => g.campusId === null)) return null;
  return gs.map((g) => g.campusId as string);
}
/** Validates a path identifier; malformed ids are a 400, never a 500. */
export const pid = (v: string): string => parse(uuid, v);
