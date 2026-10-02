/** Storage operations required by the scheduler; implementations validate durable reads. */
export interface ExperimentTable<K extends string, V> {
  /** @param key - record identity. @returns saved record, when present. */
  get(key: K): V | undefined
  /** @param key - record identity. @param value - complete replacement. @returns after durable publication. */
  put(key: K, value: V): Promise<void>
  /** @returns records in storage order. */
  entries(): Iterable<[K, V]>
}
