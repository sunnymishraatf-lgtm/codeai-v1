// Simple semaphore with a bounded wait queue.
// Used to cap how many AI (Groq) requests run at the same time so a whole
// classroom hitting the API at once cannot exhaust the upstream provider.
// Extra requests wait up to `queueTimeoutMs`, then fail fast with a
// QUEUE_TIMEOUT error (the route turns that into a friendly HTTP 503)
// instead of hanging or crashing.

class QueueTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`Timed out after ${timeoutMs}ms waiting for a free AI slot.`);
    this.name = "QueueTimeoutError";
    this.code = "QUEUE_TIMEOUT";
    this.status = 503;
  }
}

class Semaphore {
  constructor(maxConcurrent, queueTimeoutMs) {
    this.max = Math.max(1, maxConcurrent);
    this.queueTimeoutMs = queueTimeoutMs;
    this.active = 0;
    this.waiters = [];
  }

  acquire() {
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve(() => this._release());
    }

    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const idx = this.waiters.indexOf(waiter);
        if (idx !== -1) this.waiters.splice(idx, 1);
        reject(new QueueTimeoutError(this.queueTimeoutMs));
      }, this.queueTimeoutMs);
      this.waiters.push(waiter);
    });
  }

  _release() {
    const next = this.waiters.shift();
    if (next) {
      clearTimeout(next.timer);
      // Hand the slot directly to the next waiter; `active` stays the same.
      next.resolve(() => this._release());
    } else {
      this.active = Math.max(0, this.active - 1);
    }
  }

  stats() {
    return {
      active: this.active,
      queued: this.waiters.length,
      max: this.max,
      queueTimeoutMs: this.queueTimeoutMs,
    };
  }
}

const aiSemaphore = new Semaphore(
  parseInt(process.env.MAX_CONCURRENT_AI || "10", 10),
  parseInt(process.env.QUEUE_TIMEOUT_MS || "30000", 10)
);

module.exports = { Semaphore, QueueTimeoutError, aiSemaphore };
