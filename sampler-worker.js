/**
 * Runs expression sampling off the main thread.
 *
 * Protocol (all messages are plain objects):
 *   main -> worker  { type: "sample", reqId, id, key, source, definitions, width, height, camera, step }
 *   main -> worker  { type: "warmup" }                  build the default engine ahead of time
 *   main -> worker  { type: "cancel", reqId }           stop a job whose result is no longer wanted
 *   worker -> main  { type: "sampled", reqId, result }  result is null when the job was cancelled
 *
 * Grid buffers are transferred, not copied, so large samples cost no extra memory traffic.
 */
import { createInlineSampler } from "./sampler.js";

const sampleInline = createInlineSampler();
/** Request ids the main thread has abandoned; checked between chunks of work. */
const cancelledRequests = new Set();

self.addEventListener("message", async (event) => {
  const message = event.data;
  if (message?.type === "cancel") {
    cancelledRequests.add(message.reqId);
    return;
  }
  if (message?.type === "warmup") {
    try { sampleInline.warmUp(); } catch { /* the first sample reports engine errors */ }
    return;
  }
  if (message?.type !== "sample") return;

  const { reqId } = message;
  let result;
  try {
    result = await sampleInline(message, () => cancelledRequests.has(reqId));
  } catch (error) {
    result = {
      type: "sampled", id: message.id, key: message.key,
      error: error instanceof Error ? error.message : String(error),
      components: [],
    };
  }
  cancelledRequests.delete(reqId);
  if (!result) {
    self.postMessage({ type: "sampled", reqId, result: null });
    return;
  }
  const transfer = [];
  for (const component of result.components || []) {
    if (component.values?.buffer) transfer.push(component.values.buffer);
  }
  self.postMessage({ type: "sampled", reqId, result }, transfer);
});
