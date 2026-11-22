/**
 * Joins the pages of `photos.list`. The worklet answers in pages so each fits
 * the 64 KB invoke header; the gallery wants one list.
 */
import type { CoreError, Either } from "@ekrooh/bare/core";
import type { ListResult, Photo } from "@justus/core";

/** Reads the page of photos that starts at `from`. */
export type ReadPage = (from: number) => Promise<Either<CoreError, ListResult>>;

function keyOf(photo: Photo): string {
  const folder = photo.folderId ?? "";
  return `${folder}/${photo.id}`;
}

/** Every page, in order. A photo that shifts onto the next page while they are read is kept once. */
export async function listAllPhotos(readPage: ReadPage): Promise<Either<CoreError, ListResult>> {
  const photos: Photo[] = [];
  const seen = new Set<string>();
  let from: number | undefined = 0;
  while (from !== undefined) {
    const [error, page] = await readPage(from);
    if (error) return [error, null];
    for (const photo of page.photos) {
      if (seen.has(keyOf(photo))) continue;
      seen.add(keyOf(photo));
      photos.push(photo);
    }
    from = page.next !== undefined && page.next > from ? page.next : undefined;
  }
  return [null, { photos }];
}
