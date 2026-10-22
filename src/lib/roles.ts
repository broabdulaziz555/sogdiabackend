/**
 * Pure role logic. No imports from auth.ts or permissions.ts — both of
 * those import this, so keeping it dependency-free avoids a circular
 * import between the two auth modules.
 */
import type { UserRole } from '@/lib/types';

export const USER_ROLES: readonly UserRole[] = ['trader', 'admin', 'xdepartment'] as const;

export const ROLE_RANK: Record<UserRole, number> = {
  trader: 0,
  admin: 1,
  xdepartment: 2,
};

/** Roles allowed through the staff guards. */
export const STAFF_ROLES: readonly UserRole[] = ['admin', 'xdepartment'] as const;

const ROLE_LOOKUP = new Map<string, UserRole>(USER_ROLES.map((r) => [r, r]));

/**
 * Coerce whatever Postgres handed us into a known role, or null.
 *
 * A stored value with stray whitespace or odd casing ('xdepartment ',
 * 'XDepartment') used to fall through `ROLE_RANK[role]` as `undefined`
 * and compare false against every threshold — a staff user silently
 * demoted to no access. Normalising here means the rank table can never
 * be indexed with an unknown key.
 */
export function normalizeRole(value: unknown): UserRole | null {
  if (typeof value !== 'string') return null;
  return ROLE_LOOKUP.get(value.trim().toLowerCase()) ?? null;
}

export function rankOf(role: UserRole | null): number {
  return role === null ? -1 : ROLE_RANK[role];
}

/** admin or xdepartment. */
export function isStaffRole(role: UserRole | null): boolean {
  return role !== null && STAFF_ROLES.includes(role);
}

export function isXDepartmentRole(role: UserRole | null): boolean {
  return role === 'xdepartment';
}

/** Does `role` meet or exceed `required` on the ladder? */
export function roleAtLeast(role: UserRole | null, required: UserRole): boolean {
  return rankOf(role) >= ROLE_RANK[required];
}
