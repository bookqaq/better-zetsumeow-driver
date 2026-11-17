/** Tiny typed event emitter, dependency free and synchronous. */
export type Listener<T> = (payload: T) => void;

export class Emitter<E extends object> {
  private readonly listeners = new Map<keyof E, Set<Listener<never>>>();

  on<K extends keyof E>(event: K, listener: Listener<E[K]>): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as Listener<never>);
    return () => this.off(event, listener);
  }

  once<K extends keyof E>(event: K, listener: Listener<E[K]>): () => void {
    const dispose = this.on(event, (payload) => {
      dispose();
      listener(payload);
    });
    return dispose;
  }

  off<K extends keyof E>(event: K, listener: Listener<E[K]>): void {
    this.listeners.get(event)?.delete(listener as Listener<never>);
  }

  emit<K extends keyof E>(event: K, payload: E[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const listener of [...set]) {
      (listener as Listener<E[K]>)(payload);
    }
  }

  removeAllListeners(event?: keyof E): void {
    if (event === undefined) this.listeners.clear();
    else this.listeners.delete(event);
  }

  listenerCount(event: keyof E): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}
