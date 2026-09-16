// Minimal typed-by-convention event bus. Listener arrays are reused; emit()
// allocates nothing.
export class EventBus {
  constructor() {
    this.map = new Map();
  }
  on(name, fn) {
    let arr = this.map.get(name);
    if (!arr) {
      arr = [];
      this.map.set(name, arr);
    }
    arr.push(fn);
    return () => {
      const i = arr.indexOf(fn);
      if (i >= 0) arr.splice(i, 1);
    };
  }
  emit(name, a, b, c) {
    const arr = this.map.get(name);
    if (!arr) return;
    for (let i = 0; i < arr.length; i++) arr[i](a, b, c);
  }
}
