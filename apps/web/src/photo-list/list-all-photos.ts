/**
 * Joins the pages of `photos.list`. The worklet answers in pages so each fits
 * the 64 KB invoke header; the gallery wants one list.
 */
import { CoreError, type Either } from "@ekrooh/bare/core";
import type { ListOptions, ListResult, Photo } from "@justus/core";

/** Reads one page of photos. */
export type ReadPage = (position: ListOptions) => Promise<Either<CoreError, ListResult>>;

/** Every page of one list, in order. */
export async function listAllPhotos(readPage: ReadPage): Promise<Either<CoreError, ListResult>> {
  const photos: Photo[] = [];
  let position: ListOptions | undefined = {};
  while (position !== undefined) {
    const [error, page] = await readPage(position);
    if (error) return [error, null];
    photos.push(...page.photos);
    const from = position.from ?? 0;
    if (page.next !== undefined && page.next <= from) {
      return [new CoreError("INVALID_RESPONSE", "photos.list: next page does not move on"), null];
    }
    position = page.next === undefined ? undefined : { from: page.next, listId: page.listId };
  }
  return [null, { photos }];
}
