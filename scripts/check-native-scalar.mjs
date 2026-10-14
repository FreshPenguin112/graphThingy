// Differential check: the native JavaScript translation (native-scalar.js) must agree with
// Compute Engine's compiled function at random points. Run with: npm run check:native
import { ComputeEngine, compile } from "@cortex-js/compute-engine";
import { compileNativeScalar } from "../native-scalar.js";

const EXPRESSIONS = [
  String.raw`\left(x^{2}+y^{2}-1\right)^{3}-x^{2}y^{3}`,
  String.raw`\sin\left(x\right)\cdot\cos\left(y\right)-0.2`,
  String.raw`x^{2}+y^{2}-25`,
  String.raw`\frac{1}{x}-2`,
  String.raw`\sqrt{x}-y`,
  String.raw`\sqrt{x^{2}+y^{2}}-3`,
  String.raw`e^{x}-y`,
  String.raw`\ln\left(x\right)-y`,
  String.raw`\left|x\right|+\left|y\right|-2`,
  String.raw`\pi x-y`,
  String.raw`\min\left(x,y\right)-1`,
  String.raw`\max\left(x,y\right)-\lfloor x\rfloor`,
  String.raw`\frac{x}{y}-x^{-1}`,
  String.raw`\tan\left(x\right)-y`,
  String.raw`2^{x}-y`,
  String.raw`x^{1.5}-y`,
  String.raw`-x-y+3`,
];
const SAMPLES = 4000;
const TOLERANCE = 1e-9;

const ce = new ComputeEngine();
ce.declare("x", "number");
ce.declare("y", "number");

let failures = 0;
for (const latex of EXPRESSIONS) {
  const json = ce.parse(latex).json;
  const native = compileNativeScalar(json);
  if (!native) {
    console.error(`not translated: ${latex}`);
    failures++;
    continue;
  }
  const engine = compile(ce.box(json));
  if (!engine.success) {
    console.error(`engine could not compile: ${latex}`);
    failures++;
    continue;
  }
  let compared = 0, worst = 0;
  for (let i = 0; i < SAMPLES; i++) {
    const x = (Math.random() - 0.5) * 24;
    const y = (Math.random() - 0.5) * 12;
    const expected = engine.run({ x, y });
    // Only finite engine results are comparable; the sampler re-evaluates the rest.
    if (typeof expected !== "number" || !Number.isFinite(expected)) continue;
    const actual = native(x, y);
    if (!Number.isFinite(actual)) {
      console.error(`native gave a non-finite value where the engine gave ${expected}: ${latex} at x=${x}, y=${y}`);
      failures++;
      break;
    }
    const error = Math.abs(actual - expected) / Math.max(1, Math.abs(expected));
    worst = Math.max(worst, error);
    compared++;
    if (error > TOLERANCE) {
      console.error(`mismatch for ${latex} at x=${x}, y=${y}: engine ${expected}, native ${actual}`);
      failures++;
      break;
    }
  }
  console.log(`${latex.padEnd(44)} ${String(compared).padStart(5)} points, worst relative error ${worst.toExponential(1)}`);
}

if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log("native scalar translation agrees with Compute Engine");
