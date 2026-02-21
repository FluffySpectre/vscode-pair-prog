export class RemoteOpGuard {
  private readonly pending = new Set<string>();

  isActive(key: string): boolean {
    return this.pending.has(key);
  }

  async run<T>(key: string | string[], fn: () => PromiseLike<T>): Promise<T> {
    const keys = Array.isArray(key) ? key : [key];
    for (const k of keys) { this.pending.add(k); }
    try {
      return await fn();
    } finally {
      for (const k of keys) { this.pending.delete(k); }
    }
  }
}
