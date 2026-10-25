import {
  buildHelpCatalog,
  type CommandCategory,
  type CommandInfo,
  type HelpLeaf,
} from '../../../shared/help/catalog.js';
import type { Command } from '../../../shared/types/index.js';

/**
 * The help catalog of one loaded command set, with what searching it needs.
 *
 * Building the catalog serializes every command (`toJSON()` validates the
 * whole builder), which used to happen once per suggestion on every
 * autocomplete keystroke. The catalog does not depend on who is asking, so
 * it is built once per command collection: the loader replaces
 * `client.commands` wholesale, so a reload is a new key and the old entry is
 * collected with it. Visibility is still decided per request.
 */

export interface IndexedEntry {
  entry: CommandInfo;
  category: CommandCategory;
  /** Normalized entry path, e.g. `voice autojoin`. */
  path: string;
  /** Normalized words of the entry path and of every leaf path below it. */
  words: string[];
  /** Normalized runnable paths below the entry. */
  leafPaths: string[];
  /**
   * What the entry itself says it does, in both languages: its description
   * and its subcommands', outside any parenthetical note, and the keywords
   * its command declared for it.
   */
  texts: string[];
  /** The top-level command's description and the category name. */
  contextTexts: string[];
  /** Parenthetical notes of all those descriptions, e.g. `（最大5分）`. */
  asides: string[];
}

export interface HelpIndex {
  categories: CommandCategory[];
  /** Every entry in catalog order. */
  entries: IndexedEntry[];
  byName: Map<string, IndexedEntry>;
  /** Runnable path -> the entry listing it and the leaf itself. */
  byLeaf: Map<string, { indexed: IndexedEntry; leaf: HelpLeaf }>;
}

/** Fold width and case so `ＲＥＣ`, `Rec` and `rec` match alike. */
export function normalizeQuery(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/^\/+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Longest query search reads. Paths are under 40 characters and Discord
 * caps descriptions at 100, so nothing longer can match; the `command`
 * option is capped at the same length, and this bounds the work for any
 * caller that is not.
 */
export const MAX_QUERY_LENGTH = 100;

/** A typed query, normalized and cut to what search reads. */
export function toSearchQuery(raw: string): string {
  return normalizeQuery(raw.slice(0, MAX_QUERY_LENGTH * 2)).slice(
    0,
    MAX_QUERY_LENGTH
  );
}

/** Text inside half- or full-width parentheses. */
const ASIDE = /[(（]([^()（）]*)[)）]/g;

/**
 * Split a description into what it says and its parenthetical notes:
 * `VC入退室の通知設定（録音ではありません）` is about notifications, and the
 * word 録音 in the note must not make it the answer to "録音".
 */
function splitAsides(text: string): { main: string; asides: string[] } {
  const asides = [...text.matchAll(ASIDE)].map((match) => match[1]);
  return { main: text.replace(ASIDE, ' '), asides };
}

function indexEntry(
  entry: CommandInfo,
  category: CommandCategory
): IndexedEntry {
  const leaves = entry.leaves ?? [];
  const leafPaths = leaves.map((leaf) => normalizeQuery(leaf.path));
  const path = normalizeQuery(entry.name);
  const words = [
    ...new Set([path, ...leafPaths].flatMap((text) => text.split(' '))),
  ];

  const own = [entry.description, ...leaves.map((leaf) => leaf.description)]
    .flatMap((text) => [text.ja, text.en])
    .map(splitAsides);
  const parent = entry.commandDescription
    ? [entry.commandDescription.ja, entry.commandDescription.en].map(
        splitAsides
      )
    : [];
  const keywords = (entry.keywords ?? []).flatMap((word) => [word.ja, word.en]);

  const texts = [...own.map((text) => text.main), ...keywords].map(
    normalizeQuery
  );
  const contextTexts = [
    ...parent.map((text) => text.main),
    category.name.ja,
    category.name.en,
  ].map(normalizeQuery);
  const asides = [...own, ...parent]
    .flatMap((text) => text.asides)
    .map(normalizeQuery);

  return {
    entry,
    category,
    path,
    words,
    leafPaths,
    texts,
    contextTexts,
    asides,
  };
}

function buildIndex(commands: Iterable<Command>): HelpIndex {
  const categories = buildHelpCatalog(commands);
  const entries = categories.flatMap((category) =>
    category.commands.map((entry) => indexEntry(entry, category))
  );
  const byName = new Map(
    entries.map((indexed) => [indexed.entry.name, indexed])
  );
  const byLeaf = new Map<string, { indexed: IndexedEntry; leaf: HelpLeaf }>();
  for (const indexed of entries) {
    for (const leaf of indexed.entry.leaves ?? []) {
      if (!byLeaf.has(leaf.path)) byLeaf.set(leaf.path, { indexed, leaf });
    }
  }

  return { categories, entries, byName, byLeaf };
}

const indexes = new WeakMap<object, HelpIndex>();

/** The index of a loaded command collection, built on first use. */
export function getHelpIndex(
  commands: { values(): Iterable<Command> } & object
): HelpIndex {
  let index = indexes.get(commands);
  if (!index) {
    index = buildIndex(commands.values());
    indexes.set(commands, index);
  }
  return index;
}

/** Score bands, best first; 0 means no match. */
export const MATCH_SCORE = {
  exact: 100,
  pathPrefix: 80,
  wordPrefix: 60,
  pathContains: 40,
  text: 20,
  context: 10,
  aside: 5,
} as const;

/**
 * How well an entry matches a normalized query:
 * - the entry path itself, or the start of it (`voice re`), ranks first,
 *   so typing a path behaves as it always did;
 * - then a word of it or of a subcommand below it (`record`, `exclude`);
 * - then the path containing the text anywhere (`autojoin ex`);
 * - then what the entry says it does, in either language (`投票`), or a
 *   keyword its command declared;
 * - then what its top-level command or category says (`ルーレット` in
 *   `/community`'s description);
 * - last, a parenthetical note (`（録音ではありません）`).
 * An empty query matches everything equally.
 */
export function scoreEntry(indexed: IndexedEntry, query: string): number {
  if (query === '') return 1;
  if (indexed.path === query || indexed.leafPaths.includes(query)) {
    return MATCH_SCORE.exact;
  }
  if (indexed.path.startsWith(query)) return MATCH_SCORE.pathPrefix;
  if (indexed.words.some((word) => word.startsWith(query))) {
    return MATCH_SCORE.wordPrefix;
  }
  if (
    indexed.path.includes(query) ||
    indexed.leafPaths.some((leaf) => leaf.includes(query))
  ) {
    return MATCH_SCORE.pathContains;
  }
  if (indexed.texts.some((text) => text.includes(query))) {
    return MATCH_SCORE.text;
  }
  if (indexed.contextTexts.some((text) => text.includes(query))) {
    return MATCH_SCORE.context;
  }
  if (indexed.asides.some((text) => text.includes(query))) {
    return MATCH_SCORE.aside;
  }
  return 0;
}

export interface RankedEntry {
  indexed: IndexedEntry;
  score: number;
}

/**
 * Visible entries matching `rawQuery` (read up to MAX_QUERY_LENGTH), best
 * first; equal scores keep catalog order. Visibility is checked per call,
 * never cached with the index.
 */
export function searchEntries(
  index: HelpIndex,
  rawQuery: string,
  isVisible: (entry: CommandInfo) => boolean
): RankedEntry[] {
  const query = toSearchQuery(rawQuery);
  const ranked: RankedEntry[] = [];

  for (const indexed of index.entries) {
    const score = scoreEntry(indexed, query);
    if (score > 0 && isVisible(indexed.entry)) {
      ranked.push({ indexed, score });
    }
  }

  // Array.prototype.sort is stable, so ties stay in catalog order.
  return ranked.sort((a, b) => b.score - a.score);
}

/**
 * Edit distance counting a swap of two neighbouring letters as one edit
 * (optimal string alignment), for "did you mean" on a typo: `fnu` is one
 * edit from `fun`, not two.
 */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const rows: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) =>
      i === 0 ? j : j === 0 ? i : 0
    )
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      rows[i][j] = Math.min(
        rows[i - 1][j] + 1,
        rows[i][j - 1] + 1,
        rows[i - 1][j - 1] + cost
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1);
      }
    }
  }
  return rows[a.length][b.length];
}

/** Typos further than this from every name are not guessed at. */
const MAX_SUGGESTION_DISTANCE = 2;
/** Shorter queries are within two edits of too many words to mean much. */
const MIN_SUGGESTION_QUERY = 3;

/**
 * The visible entry whose path, or a word of it, is closest to a query that
 * matched nothing (`recrod` -> `voice record`), or null.
 *
 * This runs on every miss, which the cooldown does not count, so it only
 * measures names whose length is already within reach: the length
 * difference alone is that many edits. A long junk query measures nothing.
 */
export function closestEntry(
  index: HelpIndex,
  rawQuery: string,
  isVisible: (entry: CommandInfo) => boolean
): IndexedEntry | null {
  const query = toSearchQuery(rawQuery);
  if (query.length < MIN_SUGGESTION_QUERY) return null;

  let best: IndexedEntry | null = null;
  let bestDistance = MAX_SUGGESTION_DISTANCE + 1;

  for (const indexed of index.entries) {
    if (!isVisible(indexed.entry)) continue;
    for (const candidate of [
      indexed.path,
      ...indexed.leafPaths,
      ...indexed.words,
    ]) {
      if (Math.abs(query.length - candidate.length) >= bestDistance) continue;
      const distance = editDistance(query, candidate);
      if (distance < bestDistance) {
        best = indexed;
        bestDistance = distance;
      }
    }
  }

  return best;
}
