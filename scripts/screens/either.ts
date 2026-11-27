/** An expected failure or a success, as a value: branch on `ok`, then read `error` or `value`. */
export type Either<Failure, Success> = { ok: false; error: Failure } | { ok: true; value: Success };

export function left<Failure>(error: Failure): Either<Failure, never> {
  return { ok: false, error };
}

export function right<Success>(value: Success): Either<never, Success> {
  return { ok: true, value };
}

/** Settles a promise into an Either: a rejection becomes a `left` holding its reason. */
export function wrap<Success>(promise: Promise<Success>): Promise<Either<unknown, Success>> {
  return promise.then(
    (value) => right(value),
    (reason: unknown) => left(reason),
  );
}
