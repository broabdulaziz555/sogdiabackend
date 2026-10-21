import { ApiError } from '@/lib/http';
import { requireUser } from '@/lib/auth';
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
 */
export const ROLE_RANK: Record<UserRole, number> = {
  trader: 0,
  admin: 1,
  xdepartment: 2,
};

export function isAdmin(user: DbUser): boolean {
  return ROLE_RANK[user.role] >= ROLE_RANK.admin;
}

export function isXDepartment(user: DbUser): boolean {
  return user.role === 'xdepartment';
}

export function canSee(user: DbUser, ownerId: string): boolean {
  return user.id === ownerId || isAdmin(user);
}

/** admin or xdepartment */
export async function requireStaff(req: Request): Promise<DbUser> {
  const user = await requireUser(req);
  if (!isAdmin(user)) {
    throw new ApiError('FORBIDDEN', 'Staff privileges required.');
  }
  return user;
}

/** xdepartment only — the unrestricted tier. */
export async function requireXDepartment(req: Request): Promise<DbUser> {
  const user = await requireUser(req);
  if (!isXDepartment(user)) {
    throw new ApiError('FORBIDDEN', 'X-Department clearance required.');
  }
  return user;
}
