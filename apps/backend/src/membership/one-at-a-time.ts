/** Runs work for one key at a time, in the order it was asked for. Work for
 * other keys runs alongside. A run that fails does not stop the next one. */
export function oneAtATime(): <T>(key: string, run: () => Promise<T>) => Promise<T> {
  const running = new Map<string, Promise<void>>();
  return (key, run) => {
    const before = running.get(key) ?? Promise.resolve();
    const result = before.then(run);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    running.set(key, settled);
    void settled.then(() => {
      if (running.get(key) === settled) running.delete(key);
    });
    return result;
  };
}
