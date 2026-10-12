# Adaptive LaTeX Plotter

A Vite-based LaTeX equation plotter using MathLive for editable math and the Cortex-JS Compute Engine for parsing, symbolic definitions, numerical evaluation, and compiling expressions.

## Run locally

Requires a current Node.js release supported by Vite.

```sh
npm install
npm run dev
```

Open `http://localhost:8080`. For a production build, run `npm run build`; Vite writes the site to `dist/`.

## Definition behavior

Each row can be a graph, a variable definition, or a function definition. The plotter rebuilds definitions before compiling graphs and assigns dependencies first, so definitions may appear in any row order.

```latex
y=g(x)
f(x)=x^2+a
g(t)=f(t)+b
b=3
a=2
```

A bare function call such as `f(x)` or `f(5)` gets an expression/value preview and is not automatically graphed. To draw a function, enter `y=f(x)`. Ordinary expressions such as `x^2` and built-in calls such as `\sin(x)` are still plotted as `y=x^2` and `y=\sin(x)`.

## JSDoc types

`index.js` is JavaScript, not TypeScript. Its JSDoc imports the actual package types so IDEs can provide Compute Engine autocomplete and type information:

```js
/** @typedef {import('@cortex-js/compute-engine').ComputeEngine} ComputeEngineInstance */
/** @typedef {import('@cortex-js/compute-engine').Expression} BoxedExpression */
/** @type {ComputeEngineInstance} */
let ce = new ComputeEngine();
```

`jsconfig.json` is included for editor language services. The Compute Engine dependency is pinned to `0.149.0`, the latest published version listed by npm during preparation; package availability can change over time.
