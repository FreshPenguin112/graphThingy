import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createInlineSampler } from "../sampler.js";

const sample = createInlineSampler();
const camera = { xMin: -10, xMax: 10, yMin: -5, yMax: 5 };

async function sampleSource(source) {
  return sample({
    id: source,
    key: source,
    source,
    width: 200,
    height: 100,
    camera,
    step: 2,
  }, () => false);
}

const originalLog = console.log;
console.log = () => {};
try {
  const piecewisePoint = await sampleSource(String.raw`\left(0,\ \left\{False:1:0\right\}\right)`);
  assert.deepEqual(piecewisePoint.components[0].points, [{ x: 0, y: 0 }]);

  const latticeComprehension = await sample({
    id: "lattice-comprehension",
    key: "lattice-comprehension",
    source: String.raw`\left(x,\left\{x\in\mathbb{Z}\ \operatorname{and}\ b\left(x,i\right)\equiv1:-i\right\}\ \operatorname{for}\ i\ of\ \left[0..31\right]\right)`,
    definitions: [{ kind: "function", name: "b", args: ["x", "i"], rhs: "1" }],
    width: 800,
    height: 600,
    camera: { xMin: -10, xMax: 10, yMin: -5, yMax: 5 },
    step: 2,
  }, () => false);
  assert.equal(latticeComprehension.components[0].points.length, 126);
  assert.deepEqual(latticeComprehension.components[0].points[0], { x: -10, y: 0 });
  assert.deepEqual(latticeComprehension.components[0].points.at(-1), { x: 10, y: -5 });
  assert.equal(latticeComprehension.compilation.fallbackReason, "");

  const dependentFunction = await sample({
    id: "dependent-lattice-comprehension",
    key: "dependent-lattice-comprehension",
    source: String.raw`\left(x,\left\{x\in\mathbb{Z}\ \operatorname{and}\ b\left(x,i\right)\equiv1:-i\right\}\ \operatorname{for}\ i\ of\ \left[0..3\right]\right)`,
    definitions: [{ kind: "function", name: "b", args: ["x", "n"], rhs: "x+n" }],
    width: 800,
    height: 600,
    camera: { xMin: -4, xMax: 4, yMin: -5, yMax: 5 },
    step: 2,
  }, () => false);
  assert.deepEqual(dependentFunction.components[0].points, [
    { x: -2, y: -3 }, { x: -1, y: -2 }, { x: 0, y: -1 }, { x: 1, y: 0 },
  ]);

  assert.equal(typeof sample.batch, "function", "sampler should expose one shared-engine batch API");
  const batchResults = await sample.batch([
    {
      id: "batch-green", key: "batch-green",
      source: String.raw`\left(x,\left\{x\in\mathbb{Z}\ \operatorname{and}\ b\left(x,i\right)\equiv1:-i\right\}\ \operatorname{for}\ i\ of\ \left[0..3\right]\right)`,
      definitions: [{ kind: "function", name: "b", args: ["x", "n"], rhs: "1" }],
      width: 800, height: 600, camera: { xMin: -4, xMax: 4, yMin: -5, yMax: 5 }, step: 2,
    },
    {
      id: "batch-red", key: "batch-red",
      source: String.raw`\left(x,\left\{x\in\mathbb{Z}\ \operatorname{and}\ b\left(x,i\right)\equiv0:-i\right\}\ \operatorname{for}\ i\ of\ \left[0..3\right]\right)`,
      definitions: [{ kind: "function", name: "b", args: ["x", "n"], rhs: "1" }],
      width: 800, height: 600, camera: { xMin: -4, xMax: 4, yMin: -5, yMax: 5 }, step: 2,
    },
  ], () => false);
  assert.equal(batchResults.length, 2);
  assert.deepEqual(batchResults.map((result) => result.id), ["batch-green", "batch-red"]);
  assert.deepEqual(batchResults.map((result) => result.result.components[0].points.length), [36, 0]);

  const bitFunctionComprehension = await sample({
    id: "bit-function-comprehension",
    key: "bit-function-comprehension",
    source: String.raw`\left(x,\left\{x\in\mathbb{Z}\ \operatorname{and}\ b\left(x,i\right)\equiv1:-i\right\}\ \operatorname{for}\ i\ of\ \left[0..31\right]\right)`,
    definitions: [
      { kind: "function", name: "u", args: ["x"], rhs: String.raw`\operatorname{mod}\left(x,2^{32}\right)` },
      { kind: "function", name: "b", args: ["a", "n"], rhs: String.raw`\left\{\operatorname{mod}\left(\operatorname{floor}\left(\frac{u\left(\operatorname{floor}\left(a\right)\right)}{2^n}\right),2\right)\equiv1:1,0\right\}` },
    ],
    width: 800,
    height: 600,
    camera: { xMin: -6.929, xMax: 13.071, yMin: -8.053, yMax: 5.890 },
    step: 2,
  }, () => false);
  assert.equal(bitFunctionComprehension.components[0].points.length, 72);
  assert.equal(bitFunctionComprehension.compilation.fallbackReason, "");
  assert.equal(bitFunctionComprehension.compilation.symbolicEvaluationCount, 0);

  const invalidPoint = await sampleSource(String.raw`\left(0,\ \sqrt{-1}\right)`);
  assert.deepEqual(invalidPoint.components[0].points, []);

  const verticalLine = await sampleSource("x=1");
  assert.equal(verticalLine.components[0].axis, "x");
  assert.equal(verticalLine.components[0].constant, 1);

  const horizontalLine = await sampleSource("y=2");
  assert.equal(horizontalLine.components[0].axis, "y");
  assert.equal(horizontalLine.components[0].constant, 2);
} finally {
  console.log = originalLog;
}

const appSource = await readFile(new URL("../index.js", import.meta.url), "utf8");
const prepareGraphEvaluatorsAt = appSource.indexOf("function prepareGraphEvaluators()");
const pointFastPathAt = appSource.indexOf("if (item.pointExpression)", prepareGraphEvaluatorsAt);
const scalarCompileAt = appSource.indexOf("const lhsCompilation = compile(lhs);", prepareGraphEvaluatorsAt);
assert.ok(pointFastPathAt >= 0 && pointFastPathAt < scalarCompileAt,
  "coordinate-pair rows must bypass the generic scalar compiler");
assert.ok(appSource.includes("const MAX_SAMPLER_WORKERS = 1"),
  "all graph rows should use one sampler worker");
assert.match(appSource, /hasPendingPointExpressionSamples/,
  "point-expression layers should wait until peer point rows are ready");
assert.ok(appSource.includes('type: "sampleBatch"'),
  "all graph rows for one view should be sent in one worker message");

console.log("Graph point and line sampling checks passed.");
