export class TTLCache<K, V> {
	private readonly store = new Map<K, { value: V; expiresAt: number }>();

	constructor(private readonly ttl: number) {}

	get(key: K): V | null {
		const entry = this.store.get(key);
		if (!entry) return null;
		if (entry.expiresAt < Date.now()) {
			this.store.delete(key);
			return null;
		}
		return entry.value;
	}

	set(key: K, value: V): void {
		this.store.set(key, { value, expiresAt: Date.now() + this.ttl });
	}

	delete(key: K): void {
		this.store.delete(key);
	}

	has(key: K): boolean {
		return this.get(key) !== null;
	}

	clear(): void {
		this.store.clear();
	}
}
