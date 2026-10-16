/**
 * 按键串行队列：同一个 NPC 的落盘/摘要任务串行执行，
 * 不同 NPC 之间互不阻塞。
 */
export class KeyedQueue {
  constructor() {
    this.tails = new Map();
  }

  run(key, fn) {
    const prev = this.tails.get(key) || Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.then(
      () => {},
      () => {},
    );
    this.tails.set(key, tail);
    return next;
  }
}
