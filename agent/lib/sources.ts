import * as store from "./store.js";
import type { Source } from "./types.js";

const CUSTOM_SOURCES_KEY = "events-helper/sources.json";

/** Built-in feeds from developers.events. Always available; not stored. */
export const SEED_SOURCES: Source[] = [
  {
    id: "developers-events-cfps",
    name: "developers.events — All CfPs",
    url: "https://developers.events/all-cfps.json",
    kind: "cfps",
  },
  {
    id: "developers-events-events",
    name: "developers.events — All Events",
    url: "https://developers.events/all-events.json",
    kind: "events",
  },
];

/** Custom sources the user (or the agent, during a hunt) has added. */
export async function getCustomSources(): Promise<Source[]> {
  return store.read<Source[]>(CUSTOM_SOURCES_KEY, []);
}

/** Seed + custom sources, optionally narrowed to one kind. */
export async function getAllSources(kind?: Source["kind"]): Promise<Source[]> {
  const custom = await getCustomSources();
  const all = [...SEED_SOURCES, ...custom];
  return kind ? all.filter((s) => s.kind === kind) : all;
}

/** Add a custom source. Rejects duplicate ids/urls. Returns the updated custom list. */
export async function addSource(source: Source): Promise<Source[]> {
  const custom = await getCustomSources();
  const clash = [...SEED_SOURCES, ...custom].find(
    (s) => s.id === source.id || s.url === source.url,
  );
  if (clash) {
    throw new Error(
      `A source with id "${clash.id}" or url "${clash.url}" already exists.`,
    );
  }
  const next = [...custom, source];
  await store.write(CUSTOM_SOURCES_KEY, next);
  return next;
}

/** Remove a custom source by id. Seed sources cannot be removed. Returns the updated custom list. */
export async function removeSource(id: string): Promise<Source[]> {
  if (SEED_SOURCES.some((s) => s.id === id)) {
    throw new Error(`"${id}" is a built-in source and cannot be removed.`);
  }
  const custom = await getCustomSources();
  const next = custom.filter((s) => s.id !== id);
  await store.write(CUSTOM_SOURCES_KEY, next);
  return next;
}
