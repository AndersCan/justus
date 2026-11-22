/**
 * One page of a `photos.list` answer. The answer travels in an invoke header,
 * which `@ekrooh/bare` caps at 64 KB, so a phone with many photos answers in
 * pages the web joins back together.
 */
import type { ListResult, Photo } from "@justus/core";

/** Bytes of photo JSON in one page: room under the 64 KB header for the envelope around it. */
export const LIST_PAGE_BYTES = 48_000;

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
