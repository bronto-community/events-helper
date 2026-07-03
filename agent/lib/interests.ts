import type { SessionContext } from "eve/context";
import * as store from "./store.js";

// Two layers of interest, resolved into an "effective" set per user:
//  - GLOBAL: team-wide keywords/locations/notes, admin-managed, also used by the
//    scheduled digest (which runs as the app, with no user).
//  - PERSONAL: a per-user overlay that inherits global, ADDS personal interests,
//    and can EXCLUDE specific global items ("I don't care about Kubernetes").
//
// effective.keywords = (global.keywords ∪ personal.addKeywords) − personal.excludeKeywords
// (case-insensitive), same for locations; notes are concatenated.

export interface GlobalInterests {
  keywords: string[];
  locations: string[];
  notes: string;
}

export interface PersonalInterests {
  addKeywords: string[];
  addLocations: string[];
  excludeKeywords: string[];
  excludeLocations: string[];
  notes: string;
}

export interface EffectiveInterests {
  keywords: string[];
  locations: string[];
  notes: string;
}

const GLOBAL_KEY = "events-helper/interests/global.json";
const personalKey = (userId: string) => `events-helper/interests/user/${userId}.json`;

export const EMPTY_GLOBAL: GlobalInterests = { keywords: [], locations: [], notes: "" };
export const EMPTY_PERSONAL: PersonalInterests = {
  addKeywords: [],
  addLocations: [],
  excludeKeywords: [],
  excludeLocations: [],
  notes: "",
};

/** The verified caller identity for scoping personal data. Never trust model input for this. */
export function callerId(ctx: SessionContext): { id: string; isUser: boolean } {
  const current = ctx.session.auth.current;
  if (current?.principalType === "user" && current.principalId) {
    return { id: current.principalId, isUser: true };
  }
  // Non-user principals (the scheduled digest's app principal, local dev, etc.).
  return { id: current?.principalId ?? "anonymous", isUser: false };
}

function adminIds(): string[] {
  return (process.env.EVENTS_HELPER_ADMIN_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function adminListConfigured(): boolean {
  return adminIds().length > 0;
}

/** Admins may edit the global profile. Until an admin list is configured, this is open. */
export function isAdmin(id: string): boolean {
  const admins = adminIds();
  return admins.length === 0 || admins.includes(id);
}

export function getGlobal(): Promise<GlobalInterests> {
  return store.read<GlobalInterests>(GLOBAL_KEY, EMPTY_GLOBAL);
}

export function setGlobal(g: GlobalInterests): Promise<void> {
  return store.write(GLOBAL_KEY, g);
}

export function getPersonal(userId: string): Promise<PersonalInterests> {
  return store.read<PersonalInterests>(personalKey(userId), EMPTY_PERSONAL);
}

export function setPersonal(userId: string, p: PersonalInterests): Promise<void> {
  return store.write(personalKey(userId), p);
}

function dedupeCaseInsensitive(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    const k = v.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(v);
    }
  }
  return out;
}

export function resolveEffective(
  global: GlobalInterests,
  personal: PersonalInterests,
): EffectiveInterests {
  const excludeKw = new Set(personal.excludeKeywords.map((s) => s.toLowerCase()));
  const excludeLoc = new Set(personal.excludeLocations.map((s) => s.toLowerCase()));
  const keywords = dedupeCaseInsensitive([...global.keywords, ...personal.addKeywords]).filter(
    (k) => !excludeKw.has(k.toLowerCase()),
  );
  const locations = dedupeCaseInsensitive([...global.locations, ...personal.addLocations]).filter(
    (l) => !excludeLoc.has(l.toLowerCase()),
  );
  const notes = [global.notes, personal.notes].map((s) => s.trim()).filter(Boolean).join("\n");
  return { keywords, locations, notes };
}

export async function getEffective(userId: string): Promise<EffectiveInterests> {
  const [global, personal] = await Promise.all([getGlobal(), getPersonal(userId)]);
  return resolveEffective(global, personal);
}
