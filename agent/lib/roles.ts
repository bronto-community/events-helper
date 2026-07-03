import type { SessionContext } from "eve/context";

// Authorization roles, derived from env-configured id lists. Identity always
// comes from verified session auth, never from model input.
//
//   EVENTS_HELPER_ADMIN_IDS        comma-separated principal ids allowed to edit
//                                  global settings (e.g. the global interest profile)
//   EVENTS_HELPER_SUPER_ADMIN_IDS  comma-separated principal ids for operator(s);
//                                  a superset of admin, with extra privileges
//
// Bootstrap rule: while NEITHER list is configured, everyone is treated as an
// admin so a fresh install is usable. Once either list is set, access is enforced.

function idList(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function adminIds(): string[] {
  return idList("EVENTS_HELPER_ADMIN_IDS");
}

export function superAdminIds(): string[] {
  return idList("EVENTS_HELPER_SUPER_ADMIN_IDS");
}

/** True once any admin/super-admin id is configured (i.e. access is being enforced). */
export function rolesConfigured(): boolean {
  return adminIds().length > 0 || superAdminIds().length > 0;
}

export function isSuperAdmin(id: string): boolean {
  return superAdminIds().includes(id);
}

/** Admins (and super admins) may edit global settings. Open until roles are configured. */
export function isAdmin(id: string): boolean {
  if (!rolesConfigured()) return true;
  return adminIds().includes(id) || superAdminIds().includes(id);
}

export type Role = "super-admin" | "admin" | "user";

export function roleOf(id: string): Role {
  if (isSuperAdmin(id)) return "super-admin";
  if (isAdmin(id)) return "admin";
  return "user";
}

/** The verified caller identity for scoping data and checking roles. */
export function callerId(ctx: SessionContext): { id: string; isUser: boolean } {
  const current = ctx.session.auth.current;
  if (current?.principalType === "user" && current.principalId) {
    return { id: current.principalId, isUser: true };
  }
  // Non-user principals (the scheduled digest's app principal, local dev, etc.).
  return { id: current?.principalId ?? "anonymous", isUser: false };
}
