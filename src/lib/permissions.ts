import { ApiError } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import {
  isStaffRole,
  isXDepartmentRole,
  roleAtLeast,
  ROLE_RANK,
  STAFF_ROLES,
} from '@/lib/roles';
import type { DbUser, UserRole } from '@/lib/types';

/**
 * Role ladder
 * -----------
 * trader       — own accounts only
 * admin        — operations: KYC, payouts, freeze/breach, certificates
 * xdepartment  — everything admin can do, plus provisioning and overrides:
 *                gift accounts of any type/size, adjust balances, override
 *                rules and statuses, change roles, force payouts, delete,
 *                impersonate. Every action is audit-logged.
 *
 * The predicates live in lib/roles.ts and are re-exported here so the
 * existing `@/lib/permissions` imports across the routes keep working.
 */
export { ROLE_RANK, STAFF_ROLES, roleAtLeast };

/** admin or xdepartment. */
export function isAdmin(user: DbUser): boolean {
  return isStaffRole(user.role);
}

export function isXDepartment(user: DbUser): boolean {
  return isXDepartmentRole(user.role);
}

export function canSee(user: DbUser, ownerId: string): boolean {
  return user.id === ownerId || isAdmin(user);
}

/**
 * Build a 403 that says what the backend actually read, so a role
 * mismatch is self-diagnosing instead of an opaque "forbidden".
 * Safe to return: it is the caller's own role, which GET /api/me
 * already exposes to them.
 */
function forbidden(user: DbUser, message: string, required: string): ApiError {
  return new ApiError('FORBIDDEN', message, {
    user_id: user.id,
    email: user.email,
    role_in_database: user.role,
    required,
    hint: 'If role_in_database is not what you set, you are authenticated as a different user than the row you edited.',
  });
}

/** admin or xdepartment */
export async function requireStaff(req: Request): Promise<DbUser> {
  const user = await requireUser(req);

  if (!isAdmin(user)) {
    throw forbidden(user, 'Staff privileges required.', 'admin or xdepartment');
  }
  return user;
}

/** xdepartment only — the unrestricted tier. */
export async function requireXDepartment(req: Request): Promise<DbUser> {
  const user = await requireUser(req);

  if (!isXDepartment(user)) {
    throw forbidden(user, 'X-Department clearance required.', 'xdepartment');
  }
  return user;
}

/** Generic ladder guard, for any future tier. */
export async function requireRole(req: Request, minimum: UserRole): Promise<DbUser> {
  const user = await requireUser(req);

  if (!roleAtLeast(user.role, minimum)) {
    throw forbidden(user, `Role "${minimum}" or higher required.`, minimum);
  }
  return user;
}
