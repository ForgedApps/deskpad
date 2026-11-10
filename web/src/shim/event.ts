// Stands in for `@tauri-apps/api/event`: there is no backend to send events,
// so listening is a no-op that satisfies the shared code.
export async function listen<T>(_event: string, _handler: (e: { payload: T }) => void): Promise<() => void> {
  return () => {};
}
