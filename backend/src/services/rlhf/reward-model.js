'use strict';

/**
 * Linear Bradley-Terry reward model over prompt/response embeddings.
 *
 * φ(p, r) = concat(p ⊙ r, p − r)
 * s      = w · φ + b
 *
 * Pointwise (thumbs):  P(chosen) = σ(s)
 * Pairwise (DPO/RLHF): P(i ≻ j) = σ(s_i − s_j)
 *
 * This is the InstructGPT reward-model step without a GPU: a regularised
 * logistic ranker on the same embeddings the product already computes.
 * Gao et al. 2023 ("Scaling Laws for Reward Model Overoptimization") is
 * why we keep capacity tiny (linear) and L2-strong — a huge RM on a
 * small preference set overfits and the policy then hacks it.
 */

const { toFloat32, encodeF32, decodeF32 } = require('./vectors');

const DEFAULT_EPOCHS = 12;
const DEFAULT_LR = 0.05;
const DEFAULT_L2 = 1e-3;
const DEFAULT_MIN_PAIRS = 4;
const DEFAULT_MIN_POINTWISE = 8;

function sigmoid(x) {
  if (x >= 0) {
    const z = Math.exp(-Math.min(x, 60));
    return 1 / (1 + z);
  }
  const z = Math.exp(Math.max(x, -60));
  return z / (1 + z);
}

function features(promptEmb, responseEmb) {
  const p = toFloat32(promptEmb);
  const r = toFloat32(responseEmb);
  if (!p || !r) return null;
  const d = Math.min(p.length, r.length);
  if (d === 0) return null;
  const phi = new Float64Array(2 * d);
  for (let i = 0; i < d; i++) {
    phi[i] = p[i] * r[i];
    phi[d + i] = p[i] - r[i];
  }
  return phi;
}

function dot(weights, phi) {
  const n = Math.min(weights.length, phi.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += weights[i] * phi[i];
  return s;
}

function score(model, promptEmb, responseEmb) {
  if (!model || !model.weights) return 0;
  const phi = features(promptEmb, responseEmb);
  if (!phi) return 0;
  return dot(model.weights, phi) + (model.bias || 0);
}

function serialize(model) {
  const dim = model.dim | 0;
  const weights = model.weights;
  const buf = Buffer.allocUnsafe(4 + 4 + 8 + weights.length * 8);
  buf.writeUInt32LE(dim, 0);
  buf.writeUInt32LE(weights.length, 4);
  buf.writeDoubleLE(Number(model.bias) || 0, 8);
  for (let i = 0; i < weights.length; i++) buf.writeDoubleLE(weights[i], 16 + i * 8);
  return buf;
}

function deserialize(buf) {
  if (!buf) return null;
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (bytes.length < 16) return null;
  const dim = bytes.readUInt32LE(0);
  const n = bytes.readUInt32LE(4);
  const bias = bytes.readDoubleLE(8);
  if (bytes.length < 16 + n * 8) return null;
  const weights = new Float64Array(n);
  for (let i = 0; i < n; i++) weights[i] = bytes.readDoubleLE(16 + i * 8);
  return { dim, weights, bias };
}

function shuffleInPlace(arr, rng) {
  const rand = typeof rng === 'function' ? rng : Math.random;
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

function aucBinary(scored) {
  // scored: [{ y: 0|1, s: number }]
  const pos = scored.filter((x) => x.y === 1);
  const neg = scored.filter((x) => x.y === 0);
  if (pos.length === 0 || neg.length === 0) return null;
  let wins = 0;
  let ties = 0;
  for (const p of pos) {
    for (const n of neg) {
      if (p.s > n.s) wins += 1;
      else if (p.s === n.s) ties += 1;
    }
  }
  return (wins + 0.5 * ties) / (pos.length * neg.length);
}

/**
 * Train a linear RM.
 *
 * @param {object} args
 * @param {Array<{ promptEmb, responseEmb, y: 0|1 }>} [args.pointwise]
 * @param {Array<{ chosenEmb, rejectedEmb, promptEmb }>} [args.pairs]
 *   Each pair supplies promptEmb + chosen/rejected response embeddings.
 * @param {object} [args.opts]
 */
function train({ pointwise = [], pairs = [], opts = {} } = {}) {
  const epochs = opts.epochs ?? DEFAULT_EPOCHS;
  const lr0 = opts.lr ?? DEFAULT_LR;
  const l2 = opts.l2 ?? DEFAULT_L2;
  const rng = opts.rng;

  const pw = pointwise
    .map((e) => {
      const phi = features(e.promptEmb, e.responseEmb);
      if (!phi) return null;
      return { phi, y: e.y ? 1 : 0 };
    })
    .filter(Boolean);
  const pr = pairs
    .map((e) => {
      const phiC = features(e.promptEmb, e.chosenEmb);
      const phiR = features(e.promptEmb, e.rejectedEmb);
      if (!phiC || !phiR) return null;
      return { phiC, phiR };
    })
    .filter(Boolean);

  if (pw.length < (opts.minPointwise ?? DEFAULT_MIN_POINTWISE)
    && pr.length < (opts.minPairs ?? DEFAULT_MIN_PAIRS)) {
    return {
      ok: false,
      reason: 'insufficient_data',
      nPointwise: pw.length,
      nPairs: pr.length,
    };
  }

  const dim = (pw[0]?.phi.length || pr[0]?.phiC.length || 0) / 2;
  if (!Number.isFinite(dim) || dim <= 0) {
    return { ok: false, reason: 'bad_dim' };
  }
  const nW = dim * 2;
  const weights = new Float64Array(nW);
  let bias = 0;

  const steps = Math.max(1, epochs);
  for (let epoch = 0; epoch < steps; epoch++) {
    const lr = lr0 / (1 + 0.15 * epoch);
    shuffleInPlace(pw, rng);
    shuffleInPlace(pr, rng);

    for (const ex of pw) {
      const s = dot(weights, ex.phi) + bias;
      const p = sigmoid(s);
      const err = p - ex.y; // dL/ds
      for (let i = 0; i < nW; i++) {
        weights[i] -= lr * (err * ex.phi[i] + l2 * weights[i]);
      }
      bias -= lr * err;
    }

    for (const ex of pr) {
      // Δ = s_c − s_r ; L = −log σ(Δ); dL/dΔ = σ(Δ) − 1
      let delta = 0;
      for (let i = 0; i < nW; i++) delta += weights[i] * (ex.phiC[i] - ex.phiR[i]);
      const p = sigmoid(delta);
      const err = p - 1;
      for (let i = 0; i < nW; i++) {
        const g = err * (ex.phiC[i] - ex.phiR[i]) + l2 * weights[i];
        weights[i] -= lr * g;
      }
    }
  }

  const scored = pw.map((ex) => ({
    y: ex.y,
    s: dot(weights, ex.phi) + bias,
  }));
  let logloss = 0;
  if (scored.length > 0) {
    for (const ex of scored) {
      const p = Math.min(1 - 1e-7, Math.max(1e-7, sigmoid(ex.s)));
      logloss += ex.y ? -Math.log(p) : -Math.log(1 - p);
    }
    logloss /= scored.length;
  }

  let pairAcc = null;
  if (pr.length > 0) {
    let correct = 0;
    for (const ex of pr) {
      let delta = 0;
      for (let i = 0; i < nW; i++) delta += weights[i] * (ex.phiC[i] - ex.phiR[i]);
      if (delta > 0) correct += 1;
    }
    pairAcc = correct / pr.length;
  }

  return {
    ok: true,
    model: {
      dim,
      weights,
      bias,
    },
    metrics: {
      nPointwise: pw.length,
      nPairs: pr.length,
      auc: aucBinary(scored),
      logloss: scored.length ? logloss : null,
      pairAcc,
    },
  };
}

module.exports = {
  features,
  score,
  train,
  sigmoid,
  serialize,
  deserialize,
  encodeF32,
  decodeF32,
  DEFAULT_EPOCHS,
  DEFAULT_LR,
  DEFAULT_L2,
  DEFAULT_MIN_PAIRS,
  DEFAULT_MIN_POINTWISE,
};
