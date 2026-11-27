import { TD_FEATURE_VERSION, TD_INPUT_SIZE } from './tdFeatures';
import type { GameVariant } from './types';

export type TDActivation = 'tanh' | 'leaky_relu';

export const TD_HIDDEN_1 = 192;
export const TD_HIDDEN_2 = 80;
export const TD_DEFAULT_BATCH_SIZE = 32;

export interface TDVariantWeights {
  variant: GameVariant;
  activation: TDActivation;
  layerSizes: [number, number, number, number];
  warmstartGames: number;
  trainedGames: number;
  trainedAt: string;
  benchmarkWinRate?: number;
  w1: number[];
  b1: number[];
  w2: number[];
  b2: number[];
  w3: number[];
  b3: number[];
}

export interface TDModelBundle {
  schemaVersion: 1;
  featureVersion: number;
  variants: Partial<Record<GameVariant, TDVariantWeights>>;
}

export interface TDFunnelModel {
  variant: GameVariant;
  activation: TDActivation;
  inputSize: number;
  hidden1Size: number;
  hidden2Size: number;
  outputSize: number;
  warmstartGames: number;
  trainedGames: number;
  trainedAt: string;
  benchmarkWinRate?: number;
  w1: Float32Array;
  b1: Float32Array;
  w2: Float32Array;
  b2: Float32Array;
  w3: Float32Array;
  b3: Float32Array;
}

export interface TDForwardWorkspace {
  nzIdx: Int16Array;
  nzVal: Float32Array;
  h1Pre: Float32Array;
  h1: Float32Array;
  h2Pre: Float32Array;
  h2: Float32Array;
  logits: Float32Array;
  probs: Float32Array;
}

export interface TDTrainWorkspace extends TDForwardWorkspace {
  dLogits: Float32Array;
  dH2: Float32Array;
  dH1: Float32Array;
  gw1: Float32Array;
  gb1: Float32Array;
  gw2: Float32Array;
  gb2: Float32Array;
  gw3: Float32Array;
  gb3: Float32Array;
  // Adam moments (offline trainer only)
  step: number;
  mw1: Float32Array;
  vw1: Float32Array;
  mb1: Float32Array;
  vb1: Float32Array;
  mw2: Float32Array;
  vw2: Float32Array;
  mb2: Float32Array;
  vb2: Float32Array;
  mw3: Float32Array;
  vw3: Float32Array;
  mb3: Float32Array;
  vb3: Float32Array;
}

export function getOutputSizeForVariant(variant: GameVariant): number {
  if (variant === '1v1v1') return 3;
  // Both 1v1 and 2v2 use 2-way softmax:
  // 1v1: [P(Self), P(Opp)]
  // 2v2: [P(Our Team), P(Opposing Team)]
  return 2;
}

export function createForwardWorkspace(outputSize = 3): TDForwardWorkspace {
  return {
    nzIdx: new Int16Array(TD_INPUT_SIZE),
    nzVal: new Float32Array(TD_INPUT_SIZE),
    h1Pre: new Float32Array(TD_HIDDEN_1),
    h1: new Float32Array(TD_HIDDEN_1),
    h2Pre: new Float32Array(TD_HIDDEN_2),
    h2: new Float32Array(TD_HIDDEN_2),
    logits: new Float32Array(outputSize),
    probs: new Float32Array(outputSize),
  };
}

export function createTrainWorkspace(model: TDFunnelModel): TDTrainWorkspace {
  return {
    ...createForwardWorkspace(model.outputSize),
    dLogits: new Float32Array(model.outputSize),
    dH2: new Float32Array(model.hidden2Size),
    dH1: new Float32Array(model.hidden1Size),
    gw1: new Float32Array(model.w1.length),
    gb1: new Float32Array(model.b1.length),
    gw2: new Float32Array(model.w2.length),
    gb2: new Float32Array(model.b2.length),
    gw3: new Float32Array(model.w3.length),
    gb3: new Float32Array(model.b3.length),
    step: 0,
    mw1: new Float32Array(model.w1.length),
    vw1: new Float32Array(model.w1.length),
    mb1: new Float32Array(model.b1.length),
    vb1: new Float32Array(model.b1.length),
    mw2: new Float32Array(model.w2.length),
    vw2: new Float32Array(model.w2.length),
    mb2: new Float32Array(model.b2.length),
    vb2: new Float32Array(model.b2.length),
    mw3: new Float32Array(model.w3.length),
    vw3: new Float32Array(model.w3.length),
    mb3: new Float32Array(model.b3.length),
    vb3: new Float32Array(model.b3.length),
  };
}

function nextLcg(state: number): number {
  return (Math.imul(state, 1664525) + 1013904223) >>> 0;
}

export function createRandomFunnelModel(
  variant: GameVariant,
  activation: TDActivation = 'tanh',
  seed = 1337
): TDFunnelModel {
  const inputSize = TD_INPUT_SIZE;
  const hidden1Size = TD_HIDDEN_1;
  const hidden2Size = TD_HIDDEN_2;
  const outputSize = getOutputSizeForVariant(variant);

  let rng = seed >>> 0 || 1;
  const nextNormalApprox = (scale: number) => {
    let sum = 0;
    for (let i = 0; i < 4; i++) {
      rng = nextLcg(rng);
      sum += rng / 0xffffffff - 0.5;
    }
    return sum * 1.732 * scale;
  };

  const w1 = new Float32Array(inputSize * hidden1Size);
  const b1 = new Float32Array(hidden1Size);
  const w2 = new Float32Array(hidden1Size * hidden2Size);
  const b2 = new Float32Array(hidden2Size);
  const w3 = new Float32Array(hidden2Size * outputSize);
  const b3 = new Float32Array(outputSize);

  const s1 = Math.sqrt((activation === 'leaky_relu' ? 2 : 1) / inputSize);
  for (let i = 0; i < w1.length; i++) w1[i] = nextNormalApprox(s1);

  const s2 = Math.sqrt((activation === 'leaky_relu' ? 2 : 1) / hidden1Size);
  for (let i = 0; i < w2.length; i++) w2[i] = nextNormalApprox(s2);

  const s3 = Math.sqrt(1 / hidden2Size);
  for (let i = 0; i < w3.length; i++) w3[i] = nextNormalApprox(s3);

  return {
    variant,
    activation,
    inputSize,
    hidden1Size,
    hidden2Size,
    outputSize,
    warmstartGames: 0,
    trainedGames: 0,
    trainedAt: new Date().toISOString(),
    w1,
    b1,
    w2,
    b2,
    w3,
    b3,
  };
}

export function hydrateTDModel(weights: TDVariantWeights): TDFunnelModel {
  const [inputSize, hidden1Size, hidden2Size, outputSize] = weights.layerSizes;
  return {
    variant: weights.variant,
    activation: weights.activation,
    inputSize,
    hidden1Size,
    hidden2Size,
    outputSize,
    warmstartGames: weights.warmstartGames,
    trainedGames: weights.trainedGames,
    trainedAt: weights.trainedAt,
    benchmarkWinRate: weights.benchmarkWinRate,
    w1: Float32Array.from(weights.w1),
    b1: Float32Array.from(weights.b1),
    w2: Float32Array.from(weights.w2),
    b2: Float32Array.from(weights.b2),
    w3: Float32Array.from(weights.w3),
    b3: Float32Array.from(weights.b3),
  };
}

function findMagnitudeCutoff(arr: Float32Array, keepFraction: number): number {
  if (keepFraction >= 1) return 0;
  // Histogram over [0, 0.5] at 0.0005 resolution to find exact quantile in O(N)
  const bins = 1000;
  const maxVal = 0.5;
  const hist = new Int32Array(bins + 1);
  for (let i = 0; i < arr.length; i++) {
    const av = Math.abs(arr[i]);
    const b = av >= maxVal ? bins : Math.floor((av / maxVal) * bins);
    hist[b] += 1;
  }
  const targetKeep = Math.max(1, Math.floor(arr.length * keepFraction));
  let cum = 0;
  for (let b = bins; b >= 0; b--) {
    cum += hist[b];
    if (cum >= targetKeep) {
      return (b / bins) * maxVal;
    }
  }
  return 0;
}

function quantize4(arr: Float32Array, keepFraction = 1): number[] {
  const threshold = keepFraction < 1 ? findMagnitudeCutoff(arr, keepFraction) : 0;
  const out = new Array<number>(arr.length);
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (threshold > 0 && Math.abs(v) < threshold) {
      out[i] = 0;
      continue;
    }
    const r = Math.round(v * 10000) / 10000;
    out[i] = Object.is(r, -0) ? 0 : r;
  }
  return out;
}

export function serializeTDModel(model: TDFunnelModel): TDVariantWeights {
  return {
    variant: model.variant,
    activation: model.activation,
    layerSizes: [model.inputSize, model.hidden1Size, model.hidden2Size, model.outputSize],
    warmstartGames: model.warmstartGames,
    trainedGames: model.trainedGames,
    trainedAt: model.trainedAt,
    ...(model.benchmarkWinRate !== undefined ? { benchmarkWinRate: model.benchmarkWinRate } : {}),
    // Retain 100% of all weights at 4-decimal precision (no pruning)
    w1: quantize4(model.w1, 1.0),
    b1: quantize4(model.b1),
    w2: quantize4(model.w2, 1.0),
    b2: quantize4(model.b2),
    w3: quantize4(model.w3, 1.0),
    b3: quantize4(model.b3),
  };
}

export function forwardTDFunnel(
  model: TDFunnelModel,
  input: Float32Array,
  wsInput?: TDForwardWorkspace
): Float32Array {
  const ws = wsInput ?? createForwardWorkspace(model.outputSize);
  const { inputSize, hidden1Size, hidden2Size, outputSize, activation } = model;
  const { w1, b1, w2, b2, w3, b3 } = model;
  const isLeaky = activation === 'leaky_relu';

  // Gather non-zero input indices once so Layer 1 skips exact zeros (~3x faster)
  let nzCount = 0;
  for (let i = 0; i < inputSize; i++) {
    const v = input[i];
    if (v !== 0) {
      ws.nzIdx[nzCount] = i;
      ws.nzVal[nzCount] = v;
      nzCount += 1;
    }
  }

  // Layer 1: input -> hidden1 (192)
  for (let j = 0; j < hidden1Size; j++) {
    let sum = b1[j];
    const rowOff = j * inputSize;
    for (let k = 0; k < nzCount; k++) {
      sum += w1[rowOff + ws.nzIdx[k]] * ws.nzVal[k];
    }
    ws.h1Pre[j] = sum;
    ws.h1[j] = isLeaky ? (sum >= 0 ? sum : 0.01 * sum) : Math.tanh(sum);
  }

  // Layer 2: hidden1 -> hidden2 (64)
  for (let j = 0; j < hidden2Size; j++) {
    let sum = b2[j];
    const rowOff = j * hidden1Size;
    for (let i = 0; i < hidden1Size; i++) {
      sum += w2[rowOff + i] * ws.h1[i];
    }
    ws.h2Pre[j] = sum;
    ws.h2[j] = isLeaky ? (sum >= 0 ? sum : 0.01 * sum) : Math.tanh(sum);
  }

  // Output layer: hidden2 -> softmax logits
  let maxLogit = -Infinity;
  for (let k = 0; k < outputSize; k++) {
    let sum = b3[k];
    const rowOff = k * hidden2Size;
    for (let j = 0; j < hidden2Size; j++) {
      sum += w3[rowOff + j] * ws.h2[j];
    }
    ws.logits[k] = sum;
    if (sum > maxLogit) maxLogit = sum;
  }

  let expSum = 0;
  for (let k = 0; k < outputSize; k++) {
    const e = Math.exp(ws.logits[k] - maxLogit);
    ws.probs[k] = e;
    expSum += e;
  }
  const inv = expSum > 0 ? 1 / expSum : 1 / outputSize;
  for (let k = 0; k < outputSize; k++) {
    ws.probs[k] *= inv;
  }

  return ws.probs;
}

/**
 * Evaluates a feature vector and returns P(viewer or viewer's team wins) in [0, 1].
 */
export function evaluateTDWinProbability(
  model: TDFunnelModel,
  input: Float32Array,
  ws?: TDForwardWorkspace
): number {
  const probs = forwardTDFunnel(model, input, ws);
  return probs[0];
}

/**
 * Single backward gradient update toward a probability distribution `target` (length = outputSize)
 * under softmax cross-entropy loss with global gradient clipping and L2 regularization.
 */
export function updateTDFunnelTowardTarget(
  model: TDFunnelModel,
  input: Float32Array,
  target: Float32Array,
  learningRate: number,
  ws: TDTrainWorkspace,
  l2Decay = 1e-5,
  maxGradNorm = 3.0
): number {
  const probs = forwardTDFunnel(model, input, ws);
  const { inputSize, hidden1Size, hidden2Size, outputSize, activation } = model;
  const { w1, b1, w2, b2, w3, b3 } = model;
  const isLeaky = activation === 'leaky_relu';

  let loss = 0;
  for (let k = 0; k < outputSize; k++) {
    const pk = Math.max(1e-7, probs[k]);
    loss -= target[k] * Math.log(pk);
    // dL / d(logit_k) = probs[k] - target[k]
    ws.dLogits[k] = probs[k] - target[k];
  }

  // Output gradients & backprop to h2
  ws.dH2.fill(0);
  for (let k = 0; k < outputSize; k++) {
    const dl = ws.dLogits[k];
    ws.gb3[k] = dl;
    const rowOff = k * hidden2Size;
    for (let j = 0; j < hidden2Size; j++) {
      ws.gw3[rowOff + j] = dl * ws.h2[j];
      ws.dH2[j] += dl * w3[rowOff + j];
    }
  }

  // Layer 2 activation derivative & gradients & backprop to h1
  ws.dH1.fill(0);
  for (let j = 0; j < hidden2Size; j++) {
    const actGrad = isLeaky
      ? ws.h2Pre[j] >= 0
        ? 1
        : 0.01
      : 1 - ws.h2[j] * ws.h2[j];
    const dz2 = ws.dH2[j] * actGrad;
    ws.gb2[j] = dz2;
    const rowOff = j * hidden1Size;
    for (let i = 0; i < hidden1Size; i++) {
      ws.gw2[rowOff + i] = dz2 * ws.h1[i];
      ws.dH1[i] += dz2 * w2[rowOff + i];
    }
  }

  // Layer 1 activation derivative & sparse gradients (reuses nzIdx from forwardTDFunnel)
  let nzCount = 0;
  for (let i = 0; i < inputSize; i++) {
    if (input[i] !== 0) nzCount += 1;
  }
  ws.gw1.fill(0);
  for (let j = 0; j < hidden1Size; j++) {
    const actGrad = isLeaky
      ? ws.h1Pre[j] >= 0
        ? 1
        : 0.01
      : 1 - ws.h1[j] * ws.h1[j];
    const dz1 = ws.dH1[j] * actGrad;
    ws.gb1[j] = dz1;
    const rowOff = j * inputSize;
    for (let k = 0; k < nzCount; k++) {
      ws.gw1[rowOff + ws.nzIdx[k]] = dz1 * ws.nzVal[k];
    }
  }

  // Compute global L2 norm for stable clipping
  let sqNorm = 0;
  for (let i = 0; i < ws.gw1.length; i++) sqNorm += ws.gw1[i] * ws.gw1[i];
  for (let i = 0; i < ws.gb1.length; i++) sqNorm += ws.gb1[i] * ws.gb1[i];
  for (let i = 0; i < ws.gw2.length; i++) sqNorm += ws.gw2[i] * ws.gw2[i];
  for (let i = 0; i < ws.gb2.length; i++) sqNorm += ws.gb2[i] * ws.gb2[i];
  for (let i = 0; i < ws.gw3.length; i++) sqNorm += ws.gw3[i] * ws.gw3[i];
  for (let i = 0; i < ws.gb3.length; i++) sqNorm += ws.gb3[i] * ws.gb3[i];

  const norm = Math.sqrt(sqNorm);
  const clipScale = norm > maxGradNorm ? maxGradNorm / norm : 1;

  ws.step += 1;
  const beta1 = 0.9;
  const beta2 = 0.999;
  const eps = 1e-8;
  const bc1 = 1 - Math.pow(beta1, ws.step);
  const bc2 = 1 - Math.pow(beta2, ws.step);
  const adamScale = (learningRate * Math.sqrt(bc2)) / bc1;
  const weightKeep = 1 - learningRate * l2Decay;

  const applyAdam = (
    params: Float32Array,
    grads: Float32Array,
    m: Float32Array,
    v: Float32Array,
    decayWeights: boolean
  ) => {
    for (let i = 0; i < params.length; i++) {
      const g = grads[i] * clipScale;
      const mi = beta1 * m[i] + (1 - beta1) * g;
      const vi = beta2 * v[i] + (1 - beta2) * g * g;
      m[i] = mi;
      v[i] = vi;
      const base = decayWeights ? params[i] * weightKeep : params[i];
      params[i] = base - (adamScale * mi) / (Math.sqrt(vi) + eps);
    }
  };

  applyAdam(w1, ws.gw1, ws.mw1, ws.vw1, true);
  applyAdam(b1, ws.gb1, ws.mb1, ws.vb1, false);
  applyAdam(w2, ws.gw2, ws.mw2, ws.vw2, true);
  applyAdam(b2, ws.gb2, ws.mb2, ws.vb2, false);
  applyAdam(w3, ws.gw3, ws.mw3, ws.vw3, true);
  applyAdam(b3, ws.gb3, ws.mb3, ws.vb3, false);

  return loss;
}

/**
 * Mini-batch Adam update over `inputs[startIdx..endIdx)` and `targets[startIdx..endIdx)`
 * under mean softmax cross-entropy loss with global gradient clipping and L2 decay.
 */
export function updateTDFunnelMiniBatch(
  model: TDFunnelModel,
  inputs: ReadonlyArray<Float32Array>,
  targets: ReadonlyArray<Float32Array>,
  startIdx: number,
  endIdx: number,
  learningRate: number,
  ws: TDTrainWorkspace,
  l2Decay = 1e-5,
  maxGradNorm = 3.0
): number {
  const count = endIdx - startIdx;
  if (count <= 0) return 0;

  const { inputSize, hidden1Size, hidden2Size, outputSize, activation } = model;
  const { w1, b1, w2, b2, w3, b3 } = model;
  const isLeaky = activation === 'leaky_relu';

  ws.gw1.fill(0);
  ws.gb1.fill(0);
  ws.gw2.fill(0);
  ws.gb2.fill(0);
  ws.gw3.fill(0);
  ws.gb3.fill(0);

  let totalLoss = 0;

  for (let b = startIdx; b < endIdx; b++) {
    const input = inputs[b];
    const target = targets[b];

    // Forward pass (populates ws.nzIdx / ws.nzVal for non-zero inputs)
    let nzCount = 0;
    for (let i = 0; i < inputSize; i++) {
      const v = input[i];
      if (v !== 0) {
        ws.nzIdx[nzCount] = i;
        ws.nzVal[nzCount] = v;
        nzCount += 1;
      }
    }

    for (let j = 0; j < hidden1Size; j++) {
      let sum = b1[j];
      const rowOff = j * inputSize;
      for (let k = 0; k < nzCount; k++) {
        sum += w1[rowOff + ws.nzIdx[k]] * ws.nzVal[k];
      }
      ws.h1Pre[j] = sum;
      ws.h1[j] = isLeaky ? (sum >= 0 ? sum : 0.01 * sum) : Math.tanh(sum);
    }

    for (let j = 0; j < hidden2Size; j++) {
      let sum = b2[j];
      const rowOff = j * hidden1Size;
      for (let i = 0; i < hidden1Size; i++) {
        sum += w2[rowOff + i] * ws.h1[i];
      }
      ws.h2Pre[j] = sum;
      ws.h2[j] = isLeaky ? (sum >= 0 ? sum : 0.01 * sum) : Math.tanh(sum);
    }

    let maxLogit = -Infinity;
    for (let k = 0; k < outputSize; k++) {
      let sum = b3[k];
      const rowOff = k * hidden2Size;
      for (let j = 0; j < hidden2Size; j++) {
        sum += w3[rowOff + j] * ws.h2[j];
      }
      ws.logits[k] = sum;
      if (sum > maxLogit) maxLogit = sum;
    }

    let expSum = 0;
    for (let k = 0; k < outputSize; k++) {
      const e = Math.exp(ws.logits[k] - maxLogit);
      ws.probs[k] = e;
      expSum += e;
    }
    const inv = expSum > 0 ? 1 / expSum : 1 / outputSize;
    for (let k = 0; k < outputSize; k++) {
      ws.probs[k] *= inv;
      const pk = Math.max(1e-7, ws.probs[k]);
      totalLoss -= target[k] * Math.log(pk);
      ws.dLogits[k] = ws.probs[k] - target[k];
    }

    // Backprop & accumulate into gw*, gb*
    ws.dH2.fill(0);
    for (let k = 0; k < outputSize; k++) {
      const dl = ws.dLogits[k];
      ws.gb3[k] += dl;
      const rowOff = k * hidden2Size;
      for (let j = 0; j < hidden2Size; j++) {
        ws.gw3[rowOff + j] += dl * ws.h2[j];
        ws.dH2[j] += dl * w3[rowOff + j];
      }
    }

    ws.dH1.fill(0);
    for (let j = 0; j < hidden2Size; j++) {
      const actGrad = isLeaky
        ? ws.h2Pre[j] >= 0
          ? 1
          : 0.01
        : 1 - ws.h2[j] * ws.h2[j];
      const dz2 = ws.dH2[j] * actGrad;
      ws.gb2[j] += dz2;
      const rowOff = j * hidden1Size;
      for (let i = 0; i < hidden1Size; i++) {
        ws.gw2[rowOff + i] += dz2 * ws.h1[i];
        ws.dH1[i] += dz2 * w2[rowOff + i];
      }
    }

    for (let j = 0; j < hidden1Size; j++) {
      const actGrad = isLeaky
        ? ws.h1Pre[j] >= 0
          ? 1
          : 0.01
        : 1 - ws.h1[j] * ws.h1[j];
      const dz1 = ws.dH1[j] * actGrad;
      ws.gb1[j] += dz1;
      const rowOff = j * inputSize;
      for (let k = 0; k < nzCount; k++) {
        ws.gw1[rowOff + ws.nzIdx[k]] += dz1 * ws.nzVal[k];
      }
    }
  }

  // Average gradients across the mini-batch & compute global norm
  const invCount = 1 / count;
  let sqNorm = 0;
  const scaleAndSumSq = (g: Float32Array) => {
    for (let i = 0; i < g.length; i++) {
      const v = g[i] * invCount;
      g[i] = v;
      sqNorm += v * v;
    }
  };
  scaleAndSumSq(ws.gw1);
  scaleAndSumSq(ws.gb1);
  scaleAndSumSq(ws.gw2);
  scaleAndSumSq(ws.gb2);
  scaleAndSumSq(ws.gw3);
  scaleAndSumSq(ws.gb3);

  const norm = Math.sqrt(sqNorm);
  const clipScale = norm > maxGradNorm ? maxGradNorm / norm : 1;

  ws.step += 1;
  const beta1 = 0.9;
  const beta2 = 0.999;
  const eps = 1e-8;
  const bc1 = 1 - Math.pow(beta1, ws.step);
  const bc2 = 1 - Math.pow(beta2, ws.step);
  const adamScale = (learningRate * Math.sqrt(bc2)) / bc1;
  const weightKeep = 1 - learningRate * l2Decay;

  const applyAdam = (
    params: Float32Array,
    grads: Float32Array,
    m: Float32Array,
    v: Float32Array,
    decayWeights: boolean
  ) => {
    for (let i = 0; i < params.length; i++) {
      const g = grads[i] * clipScale;
      const mi = beta1 * m[i] + (1 - beta1) * g;
      const vi = beta2 * v[i] + (1 - beta2) * g * g;
      m[i] = mi;
      v[i] = vi;
      const base = decayWeights ? params[i] * weightKeep : params[i];
      params[i] = base - (adamScale * mi) / (Math.sqrt(vi) + eps);
    }
  };

  applyAdam(w1, ws.gw1, ws.mw1, ws.vw1, true);
  applyAdam(b1, ws.gb1, ws.mb1, ws.vb1, false);
  applyAdam(w2, ws.gw2, ws.mw2, ws.vw2, true);
  applyAdam(b2, ws.gb2, ws.mb2, ws.vb2, false);
  applyAdam(w3, ws.gw3, ws.mw3, ws.vw3, true);
  applyAdam(b3, ws.gb3, ws.mb3, ws.vb3, false);

  return totalLoss * invCount;
}

export function trainTDPairsMiniBatch(
  model: TDFunnelModel,
  inputs: ReadonlyArray<Float32Array>,
  targets: ReadonlyArray<Float32Array>,
  batchSize: number,
  learningRate: number,
  ws: TDTrainWorkspace,
  l2Decay = 1e-5,
  maxGradNorm = 3.0
): { lossSum: number; batchCount: number; sampleCount: number } {
  const n = Math.min(inputs.length, targets.length);
  const stepSize = Math.max(1, batchSize);
  let lossSum = 0;
  let batchCount = 0;
  for (let start = 0; start < n; start += stepSize) {
    const end = Math.min(n, start + stepSize);
    const avgBatchLoss = updateTDFunnelMiniBatch(
      model,
      inputs,
      targets,
      start,
      end,
      learningRate,
      ws,
      l2Decay,
      maxGradNorm
    );
    lossSum += avgBatchLoss * (end - start);
    batchCount += 1;
  }
  return { lossSum, batchCount, sampleCount: n };
}

/**
 * Computes backward TD(lambda) targets G_t^lambda along one trajectory using the current model.
 */
export function computeTDLambdaTargets(
  model: TDFunnelModel,
  trajectoryFeatures: ReadonlyArray<Float32Array>,
  terminalTarget: Float32Array,
  lambda: number,
  ws: TDForwardWorkspace
): Float32Array[] {
  const T = trajectoryFeatures.length;
  if (T === 0) return [];

  const outSize = model.outputSize;
  const values: Float32Array[] = new Array(T);
  for (let t = 0; t < T; t++) {
    const probs = forwardTDFunnel(model, trajectoryFeatures[t], ws);
    values[t] = Float32Array.from(probs);
  }

  const targets: Float32Array[] = new Array(T);
  let nextReturn = Float32Array.from(terminalTarget);
  targets[T - 1] = nextReturn;

  for (let t = T - 2; t >= 0; t--) {
    const g = new Float32Array(outSize);
    const vNext = values[t + 1];
    for (let k = 0; k < outSize; k++) {
      g[k] = (1 - lambda) * vNext[k] + lambda * nextReturn[k];
    }
    targets[t] = g;
    nextReturn = g;
  }

  return targets;
}

/**
 * Computes backward TD(lambda) targets G_t^lambda along one player/team trajectory
 * and applies gradient steps toward those bootstrapped win-probability targets.
 */
export function updateEpisodeTrajectoryTDLambda(
  model: TDFunnelModel,
  trajectoryFeatures: ReadonlyArray<Float32Array>,
  terminalTarget: Float32Array,
  lambda: number,
  learningRate: number,
  ws: TDTrainWorkspace
): number {
  const T = trajectoryFeatures.length;
  if (T === 0) return 0;

  const targets = computeTDLambdaTargets(model, trajectoryFeatures, terminalTarget, lambda, ws);
  let totalLoss = 0;
  for (let t = 0; t < T; t++) {
    totalLoss += updateTDFunnelTowardTarget(
      model,
      trajectoryFeatures[t],
      targets[t],
      learningRate,
      ws
    );
  }
  return totalLoss / T;
}

export function validateTDVariantWeights(raw: unknown, expectedVariant?: GameVariant): string | null {
  if (!raw || typeof raw !== 'object') return 'Variant weights entry is not an object.';
  const w = raw as Partial<TDVariantWeights>;
  if (w.variant !== '1v1' && w.variant !== '1v1v1' && w.variant !== '2v2') {
    return 'Invalid variant identifier.';
  }
  if (expectedVariant && w.variant !== expectedVariant) {
    return `Variant key mismatch (${w.variant} vs ${expectedVariant}).`;
  }
  if (w.activation !== 'tanh' && w.activation !== 'leaky_relu') {
    return `Unsupported activation "${String(w.activation)}" for ${w.variant}.`;
  }
  if (!Array.isArray(w.layerSizes) || w.layerSizes.length !== 4) {
    return `Invalid layerSizes array for ${w.variant}.`;
  }
  const [inDim, h1, h2, outDim] = w.layerSizes;
  if (inDim !== TD_INPUT_SIZE) {
    return `Expected input size ${TD_INPUT_SIZE}, got ${inDim} for ${w.variant}.`;
  }
  const expectedOut = getOutputSizeForVariant(w.variant);
  if (outDim !== expectedOut) {
    return `Expected output size ${expectedOut} for ${w.variant}, got ${outDim}.`;
  }
  if (h1 <= 0 || h2 <= 0) {
    return `Invalid hidden layer dimensions for ${w.variant}.`;
  }

  const checks: Array<[string, unknown, number]> = [
    ['w1', w.w1, inDim * h1],
    ['b1', w.b1, h1],
    ['w2', w.w2, h1 * h2],
    ['b2', w.b2, h2],
    ['w3', w.w3, h2 * outDim],
    ['b3', w.b3, outDim],
  ];
  for (const [name, arr, expectedLen] of checks) {
    if (!Array.isArray(arr) || arr.length !== expectedLen) {
      return `Layer ${name} for ${w.variant} has invalid length.`;
    }
    for (let i = 0; i < arr.length; i++) {
      if (typeof arr[i] !== 'number' || !Number.isFinite(arr[i])) {
        return `Non-finite weight found in ${w.variant}.${name}[${i}].`;
      }
    }
  }
  return null;
}

export function validateTDModelBundle(raw: unknown): {
  valid: boolean;
  error?: string;
  bundle?: TDModelBundle;
} {
  if (!raw || typeof raw !== 'object') {
    return { valid: false, error: 'Uploaded file is not a valid JSON object.' };
  }
  const obj = raw as Partial<TDModelBundle>;
  if (obj.schemaVersion !== 1) {
    return { valid: false, error: `Unsupported TD bundle schemaVersion (${String(obj.schemaVersion)}).` };
  }
  if (obj.featureVersion !== TD_FEATURE_VERSION) {
    return {
      valid: false,
      error: `Feature version mismatch (expected ${TD_FEATURE_VERSION}, got ${String(obj.featureVersion)}).`,
    };
  }
  if (!obj.variants || typeof obj.variants !== 'object') {
    return { valid: false, error: 'Bundle is missing a "variants" dictionary.' };
  }
  const loadedVariants: Partial<Record<GameVariant, TDVariantWeights>> = {};
  const keys = Object.keys(obj.variants) as GameVariant[];
  if (keys.length === 0) {
    return { valid: false, error: 'Bundle contains zero variant weight sets.' };
  }
  for (const key of keys) {
    if (key !== '1v1' && key !== '1v1v1' && key !== '2v2') {
      return { valid: false, error: `Unknown variant key "${String(key)}".` };
    }
    const err = validateTDVariantWeights(obj.variants[key], key);
    if (err) return { valid: false, error: err };
    loadedVariants[key] = obj.variants[key];
  }
  return {
    valid: true,
    bundle: {
      schemaVersion: 1,
      featureVersion: TD_FEATURE_VERSION,
      variants: loadedVariants,
    },
  };
}
