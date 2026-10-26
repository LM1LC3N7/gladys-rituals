// -----------------------------------------------------------------------------
// A virtual clock (from gladys-testkit): nothing fires by itself; every read
// of `now()` (wall, epoch ms) or `monotonic()` moves the time on by 1 µs, so a
// decision reading the clock twice sees it move, as on a real clock.
// `advance(ms)` fires every timer due on the way, in order, without awaiting
// the promise a callback returns (as Node does), with turns of the event loop
// between two. `wall` shifts the wall clock alone (a clock set back/forward).
// -----------------------------------------------------------------------------

export async function settle(rounds = 5) {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

export function testClock({ start = Date.UTC(2026, 9, 26, 10), step = 0.001 } = {}) {
  let t = 0;
  let seq = 0;
  const pending = new Map();
  const read = () => (t += step);
  const add = (fn, ms, args) => {
    const id = { id: (seq += 1), unref() {}, ref() {} };
    pending.set(id, { fn, args, at: t + Math.max(0, Number(ms) || 0), seq });
    return id;
  };
  const clock = {
    wall: 0,
    now: () => start + read() + clock.wall,
    monotonic: () => read(),
    get elapsed() {
      return t;
    },
    get pending() {
      return pending.size;
    },
    timers: {
      setTimeout: (fn, ms, ...args) => add(fn, ms, args),
      clearTimeout: (id) => pending.delete(id),
    },
    async advance(ms) {
      const target = t + ms;
      for (let guard = 0; guard < 100_000; guard += 1) {
        let next;
        for (const [id, timer] of pending) {
          if (
            timer.at <= target &&
            (!next || timer.at < next[1].at || (timer.at === next[1].at && timer.seq < next[1].seq))
          ) {
            next = [id, timer];
          }
        }
        if (!next) break;
        const [id, timer] = next;
        t = Math.max(t, timer.at);
        pending.delete(id);
        timer.fn(...timer.args);
        await settle(3);
      }
      t = Math.max(t, target);
      await settle(3);
    },
  };
  return clock;
}
