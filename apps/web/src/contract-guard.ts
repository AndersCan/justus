import { CoreError, type Either, type InvokeEnvelope } from "@ekrooh/bare/core";
import { checkPhotoChanged, checkPhotoResult, photoSpecs } from "@justus/core";

/** Validates a successful `justus.photos` invoke result against the shared
 * contract. A mismatch is logged with the offending field's path and turned
 * into a failure, so a machine shows its error state instead of rendering
 * garbage. Other plugins and failed invokes pass through untouched. */
export function guardResult<R>(
  envelope: Pick<InvokeEnvelope, "pluginId" | "event">,
  result: Either<CoreError, R>,
): Either<CoreError, R> {
  if (result[0] || envelope.pluginId !== photoSpecs.list.pluginId) return result;
  const message = checkPhotoResult(envelope.event, result[1]);
  if (!message) return result;
  console.error(message);
  return [new CoreError("CONTRACT_VIOLATION", message), null];
}

/** Validates a `photos.changed` push; logs and returns false on a mismatch. */
export function guardPush(args: unknown): boolean {
  const message = checkPhotoChanged(args);
  if (message) console.error(message);
  return message === null;
}
