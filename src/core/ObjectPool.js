// Fixed-capacity object pool. acquire()/release() never allocate; the pool is
// filled once at construction.
export class ObjectPool {
  constructor(factory, capacity) {
    this.items = new Array(capacity);
    this.free = new Array(capacity);
    this.freeCount = capacity;
    for (let i = 0; i < capacity; i++) {
      this.items[i] = factory(i);
      this.free[i] = i;
    }
  }
  acquire() {
    if (this.freeCount === 0) return null;
    const idx = this.free[--this.freeCount];
    return this.items[idx];
  }
  release(item) {
    const idx = this.items.indexOf(item);
    if (idx >= 0) this.free[this.freeCount++] = idx;
  }
  get capacity() {
    return this.items.length;
  }
}
