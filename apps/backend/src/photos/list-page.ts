/**
 * The pages of a `photos.list` answer. The answer travels in an invoke header,
 * which `@ekrooh/bare` caps at 64 KB, so a phone with many photos answers in
 * pages the web joins back together. Later pages come from the list page one
 * was cut from, so a photo deleted in between can't shift another out of sight.
 */
import { CoreError, type Either, MAX_HEADER_BYTES } from "@ekrooh/bare/core";
import type { ListArgs, ListOptions, ListResult, Photo } from "@justus/core";

/** Bytes of photo JSON in one page: room under the header cap for the envelope around it. */
export const LIST_PAGE_BYTES = MAX_HEADER_BYTES - 16_000;

/** A later page asked for a list that is no longer kept: the web reads the list again from the start. */
export const LIST_GONE = "That photo list is gone; read it again from the start";

/** Lists kept for their later pages; an older one is dropped when a newer read starts. */
const SAVED_LISTS = 4;

/** Where a page starts, and how many bytes of photo JSON it may carry. */
export interface ListPageOptions {
  from: number;
  budget?: number;
}

function startOf(from: number): number {
  return Number.isSafeInteger(from) && from > 0 ? from : 0;
}

/** The photos from `from` that fit the budget, at least one, and where the next page starts. */
export function listPage(photos: readonly Photo[], options: ListPageOptions): ListResult {
  const budget = options.budget ?? LIST_PAGE_BYTES;
  const start = startOf(options.from);
  const page: Photo[] = [];
  let used = 0;
  for (const photo of photos.slice(start)) {
    const bytes = Buffer.byteLength(JSON.stringify(photo)) + 1;
    if (page.length > 0 && used + bytes > budget) break;
    page.push(photo);
    used += bytes;
  }
  const result: ListResult = { photos: page };
  const next = start + page.length;
  if (next < photos.length) result.next = next;
  return result;
}

/** Saved lists that later pages are read from. */
export function createListPages() {
  const saved = new Map<string, readonly Photo[]>();
  let made = 0;

  function withList(listId: string, page: ListResult): ListResult {
    if (page.next === undefined) {
      saved.delete(listId);
      return page;
    }
    return { ...page, listId };
  }

  return {
    /** Page one of a list just read; the list is kept when more pages follow. */
    first(photos: readonly Photo[]): ListResult {
      made += 1;
      const listId = String(made);
      saved.set(listId, [...photos]);
      const oldest = saved.keys().next().value;
      if (saved.size > SAVED_LISTS && oldest !== undefined) saved.delete(oldest);
      return withList(listId, listPage(photos, { from: 0 }));
    },
    /** A later page of a saved list, or undefined when that list is no longer kept. */
    later(options: ListOptions): ListResult | undefined {
      const listId = options.listId ?? "";
      const photos = saved.get(listId);
      if (photos === undefined) return undefined;
      return withList(listId, listPage(photos, { from: options.from ?? 0 }));
    },
  };
}

export type ListPages = ReturnType<typeof createListPages>;

/** How `photos.list` reads the phone's photos and keeps lists for their later pages. */
export interface AnswerListOptions {
  pages: ListPages;
  read: (all: boolean) => Promise<readonly Photo[]>;
}

/** The `photos.list` answer: page one of a fresh read, or a later page of a saved list. */
export async function answerList(
  args: ListArgs | undefined,
  options: AnswerListOptions,
): Promise<Either<CoreError, ListResult>> {
  if (args?.from) {
    const page = options.pages.later(args);
    if (page === undefined) return [new CoreError("PLUGIN_ERROR", LIST_GONE), null];
    return [null, page];
  }
  const photos = await options.read(args?.all === true);
  return [null, options.pages.first(photos)];
}
