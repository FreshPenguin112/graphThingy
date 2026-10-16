/**
 * Runs expression sampling off the main thread.
 *
 * Protocol (all messages are plain objects):
 *   main -> worker  { type: "sampleBatch", reqId, jobs: [...] }
 *   main -> worker  { type: "warmup" }                       build the default engine ahead of time
 *   main -> worker  { type: "cancel", reqId }                stop a batch whose result is no longer wanted
 *   worker -> main  { type: "sampledBatch", reqId, results } one result per job, or null if cancelled
 *
 * Grid buffers are transferred, not copied, so large samples cost no extra memory traffic.
 */
import { createInlineSampler } from "./sampler.js";

const sampleInline = createInlineSampler();
/** Request ids the main thread has abandoned; checked between chunks of work. */
const cancelledRequests = new Set();
let workerQueue = Promise.resolve();

async function sampleBatch(message) {
  const { reqId } = message;
  try {
    const results = await sampleInline.batch(message.jobs || [], () => cancelledRequests.has(reqId));
    const transfer = [];
    for (const item of results || []) {
      for (const component of item.result?.components || []) {
        if (component.values?.buffer) transfer.push(component.values.buffer);
      }
    }
    self.postMessage({ type: "sampledBatch", reqId, results }, transfer);
  } catch (error) {
    self.postMessage({
      type: "sampledBatch", reqId,
      results: (message.jobs || []).map((job) => ({
        id: job.id,
        key: job.key,
        result: {
          type: "sampled", id: job.id, key: job.key,
          error: error instanceof Error ? error.message : String(error),
          components: [],
        },
      })),
    });
  } finally {
    cancelledRequests.delete(reqId);
  }
}

self.addEventListener("message", (event) => {
  const message = event.data;
  if (message?.type === "cancel") {
    cancelledRequests.add(message.reqId);
    return;
  }
  if (message?.type === "warmup") {
    try { sampleInline.warmUp(); } catch { /* the first sample reports engine errors */ }
    return;
  }
  if (message?.type === "sampleBatch") {
    workerQueue = workerQueue.then(() => sampleBatch(message));
    return;
  }
});
