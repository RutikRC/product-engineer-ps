/**
 * Time abstraction.
 *
 * The scheduler and store use clock.now() whenever they need "now", and
 * clock.sleep() whenever they would otherwise block. Production uses
 * realClock; tests use fakeClock, which lets us advance simulated time
 * deterministically and run every scenario without any real delay.
 */

export const realClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * Manually advanced clock for deterministic tests.
 * - now()     returns simulated time (fixed starting point).
 * - advance() moves simulated time forward; events whose next_attempt_at
 *   falls into the past become due.
 * - sleep() is a no-op that still advances simulated time, so any code
 *   path that awaits a delay never actually waits.
 */
export function fakeClock(initialMs = 1_700_000_000_000) {
  let current = initialMs;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
    sleep: async (ms) => {
      current += ms;
    },
  };
}