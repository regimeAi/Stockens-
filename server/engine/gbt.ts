// Small gradient-boosted regression trees (squared loss), written from scratch so it
// runs anywhere with no GPU or native deps. Attributions use the Saabas path method:
// each split's change in node value is credited to the feature that split.

interface Node {
  feature?: number;
  threshold?: number;
  left?: Node;
  right?: Node;
  value: number;
}

export interface GbtOptions {
  trees: number;
  depth: number;
  learningRate: number;
  minLeaf: number;
  subsample: number;
  maxFeatures?: number; // anti-overfitting guardrail
}

const DEFAULTS: GbtOptions = { trees: 60, depth: 3, learningRate: 0.08, minLeaf: 20, subsample: 0.8 };

export class GradientBoostedTrees {
  private trees: Node[] = [];
  private base = 0;
  opts: GbtOptions;
  constructor(opts: Partial<GbtOptions> = {}) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  fit(X: number[][], y: number[], seed = 7): this {
    let s = seed;
    const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    this.base = y.reduce((a, b) => a + b, 0) / Math.max(1, y.length);
    const pred = y.map(() => this.base);
    this.trees = [];
    for (let t = 0; t < this.opts.trees; t++) {
      const idx = X.map((_, i) => i).filter(() => rand() < this.opts.subsample);
      const resid = idx.map((i) => y[i] - pred[i]);
      const tree = this.build(idx.map((i) => X[i]), resid, 0, rand);
      this.trees.push(tree);
      for (let i = 0; i < X.length; i++) pred[i] += this.opts.learningRate * this.leaf(tree, X[i]);
    }
    return this;
  }

  private build(X: number[][], r: number[], depth: number, rand: () => number): Node {
    const value = r.reduce((a, b) => a + b, 0) / Math.max(1, r.length);
    if (depth >= this.opts.depth || r.length < this.opts.minLeaf * 2) return { value };
    const nf = X[0]?.length ?? 0;
    const feats = Array.from({ length: nf }, (_, i) => i).filter(() => !this.opts.maxFeatures || rand() < this.opts.maxFeatures / nf);
    let best = { gain: 0, f: -1, thr: 0 };
    const total = r.reduce((a, b) => a + b, 0);
    for (const f of feats) {
      const order = X.map((x, i) => [x[f], r[i]] as [number, number]).sort((a, b) => a[0] - b[0]);
      let ls = 0;
      // Try ~16 quantile thresholds per feature (fast and less prone to overfit).
      const step = Math.max(1, Math.floor(order.length / 16));
      let li = 0;
      for (let k = this.opts.minLeaf; k <= order.length - this.opts.minLeaf; k += step) {
        while (li < k) ls += order[li++][1];
        const rs = total - ls;
        const gain = (ls * ls) / k + (rs * rs) / (order.length - k) - (total * total) / order.length;
        if (gain > best.gain && order[k - 1][0] !== order[k]?.[0]) best = { gain, f, thr: (order[k - 1][0] + order[k][0]) / 2 };
      }
    }
    if (best.f < 0) return { value };
    const L: number[] = [];
    const R: number[] = [];
    X.forEach((x, i) => (x[best.f] <= best.thr ? L : R).push(i));
    return {
      value,
      feature: best.f,
      threshold: best.thr,
      left: this.build(L.map((i) => X[i]), L.map((i) => r[i]), depth + 1, rand),
      right: this.build(R.map((i) => X[i]), R.map((i) => r[i]), depth + 1, rand),
    };
  }

  private leaf(n: Node, x: number[]): number {
    while (n.feature !== undefined) n = x[n.feature] <= n.threshold! ? n.left! : n.right!;
    return n.value;
  }

  predict(x: number[]): number {
    return this.trees.reduce((p, t) => p + this.opts.learningRate * this.leaf(t, x), this.base);
  }

  // Per-feature contributions; sum(contribs) + base === predict(x).
  explain(x: number[]): { base: number; contribs: number[] } {
    const contribs = new Array(x.length).fill(0);
    for (const t of this.trees) {
      let n = t;
      while (n.feature !== undefined) {
        const next = x[n.feature] <= n.threshold! ? n.left! : n.right!;
        contribs[n.feature] += this.opts.learningRate * (next.value - n.value);
        n = next;
      }
    }
    const base = this.base + this.trees.reduce((p, t) => p + this.opts.learningRate * t.value, 0);
    return { base, contribs };
  }

  get size() {
    return this.trees.length;
  }
}
