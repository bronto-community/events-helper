import type { Cfp, EventItem } from "./types.js";

// Stable identity for a CfP / event, shared by every subsystem that has to
// remember "did we already see this?" — the scan snapshot, the per-user alert
// ledger, and the spam rules. It lives in its own leaf module so those can all
// import the same scheme without cycles (feeds → spam → ids, alerts → ids).

export const cfpId = (c: Cfp): string => c.cfpUrl || `${c.event}|${c.deadline ?? ""}`;

export const eventId = (e: EventItem): string => e.url || `${e.name}|${e.dates[0] ?? ""}`;
