import bundled1v1Json from '../data/tdWeights.1v1.json';
import bundled1v1v1Json from '../data/tdWeights.1v1v1.json';
import bundled2v2Json from '../data/tdWeights.2v2.json';
import { chooseAIAction } from './ai';
import {
  createRandomFunnelModel,
  hydrateTDModel,
  validateTDModelBundle,
  type TDFunnelModel,
  type TDModelBundle,
  type TDVariantWeights,
} from './tdNetwork';
import { chooseTDActionWithModel, type TDPlannerOptions } from './tdPlanner';
import type { AIBackend, AIDecisionTrace, GameVariant, PlayerView, TurnAction } from './types';

const TD_WEIGHTS_STORAGE_KEY = 'innovation_4e_td_weights_v1';
const ALL_VARIANTS: readonly GameVariant[] = ['1v1', '1v1v1', '2v2'];

export type CanonicalAIBackend = 'heuristic' | 'td_easy' | 'td_medium' | 'td_hard' | 'td_full';

export interface AIDifficultyProfile {
  id: CanonicalAIBackend;
  label: string;
  shortLabel: string;
  isTD: boolean;
  canLookAhead: boolean;
  description: string;
  plannerOptions?: TDPlannerOptions;
}

export const AI_DIFFICULTY_PROFILES: ReadonlyArray<AIDifficultyProfile> = [
  {
    id: 'heuristic',
    label: 'Heuristic',
    shortLabel: 'Heuristic',
    isTD: false,
    canLookAhead: true,
    description:
      'Rule-based tactical evaluation without neural network weights. Between medium and hard TD AI in difficulty.',
  },
  {
    id: 'td_easy',
    label: 'Easy TD AI',
    shortLabel: 'Easy TD',
    isTD: true,
    canLookAhead: false,
    description:
      'Neural network AI with high softmax variance to allow more errors; cannot look ahead.',
    plannerOptions: {
      drawSamples: 1,
      dogmaSamples: 1,
      enableOpponentReply: false,
      enableLookahead: false,
      temperature: 1.65,
      epsilon: 0.08,
    },
  },
  {
    id: 'td_medium',
    label: 'Medium TD AI',
    shortLabel: 'Med TD',
    isTD: true,
    canLookAhead: false,
    description:
      'Neural network AI with moderate softmax variance to allow some errors; cannot look ahead.',
    plannerOptions: {
      drawSamples: 1,
      dogmaSamples: 1,
      enableOpponentReply: false,
      enableLookahead: false,
      temperature: 0.7,
      epsilon: 0,
    },
  },
  {
    id: 'td_hard',
    label: 'Hard TD AI',
    shortLabel: 'Hard TD',
    isTD: true,
    canLookAhead: true,
    description:
      'Neural network AI with mild softmax variance to allow occasional errors; can look ahead.',
    plannerOptions: {
      drawSamples: 6,
      dogmaSamples: 3,
      enableOpponentReply: true,
      enableLookahead: true,
      temperature: 0.22,
      epsilon: 0,
    },
  },
  {
    id: 'td_full',
    label: 'Full TD AI',
    shortLabel: 'Full TD',
    isTD: true,
    canLookAhead: true,
    description: 'Neural network AI with completely greedy selection; full lookahead.',
    plannerOptions: {
      drawSamples: 6,
      dogmaSamples: 3,
      enableOpponentReply: true,
      enableLookahead: true,
      temperature: 0,
      epsilon: 0,
    },
  },
];

const PROFILE_BY_ID = new Map<CanonicalAIBackend, AIDifficultyProfile>(
  AI_DIFFICULTY_PROFILES.map((p) => [p.id, p])
);

export function normalizeAIBackend(backend?: AIBackend): CanonicalAIBackend {
  if (backend === 'td') return 'td_full';
  if (
    backend === 'heuristic' ||
    backend === 'td_easy' ||
    backend === 'td_medium' ||
    backend === 'td_hard' ||
    backend === 'td_full'
  ) {
    return backend;
  }
  return 'heuristic';
}

export function getAIDifficultyProfile(backend?: AIBackend): AIDifficultyProfile {
  return PROFILE_BY_ID.get(normalizeAIBackend(backend))!;
}

export function isTDBackend(backend?: AIBackend): boolean {
  return getAIDifficultyProfile(backend).isTD;
}

export interface TDVariantMetadata {
  variant: GameVariant;
  source: 'custom' | 'bundled' | 'fallback';
  activation: string;
  layerSizes: [number, number, number, number];
  warmstartGames: number;
  trainedGames: number;
  trainedAt: string;
  benchmarkWinRate?: number;
}

const bundledCache = new Map<GameVariant, TDFunnelModel>();
const activeCache = new Map<GameVariant, TDFunnelModel>();
const sourceMap = new Map<GameVariant, 'custom' | 'bundled' | 'fallback'>();

function loadBundledMap(): Partial<Record<GameVariant, TDVariantWeights>> {
  const merged: Partial<Record<GameVariant, TDVariantWeights>> = {};
  for (const raw of [bundled1v1Json, bundled1v1v1Json, bundled2v2Json]) {
    const checked = validateTDModelBundle(raw);
    if (checked.valid && checked.bundle) {
      Object.assign(merged, checked.bundle.variants);
    }
  }
  return merged;
}

function loadCustomStorageBundle(): TDModelBundle | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    const raw = window.localStorage.getItem(TD_WEIGHTS_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const checked = validateTDModelBundle(parsed);
    if (checked.valid && checked.bundle) {
      return checked.bundle;
    }
    return null;
  } catch {
    return null;
  }
}

function saveCustomStorageBundle(bundle: TDModelBundle | null): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    if (!bundle || Object.keys(bundle.variants).length === 0) {
      window.localStorage.removeItem(TD_WEIGHTS_STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(TD_WEIGHTS_STORAGE_KEY, JSON.stringify(bundle));
  } catch {
    // Ignore storage quota errors cleanly
  }
}

export function refreshTDWeightRegistry(): void {
  bundledCache.clear();
  activeCache.clear();
  sourceMap.clear();

  const bundledVariants = loadBundledMap();
  const customBundle = loadCustomStorageBundle();

  for (const variant of ALL_VARIANTS) {
    const bw = bundledVariants[variant];
    if (bw) {
      bundledCache.set(variant, hydrateTDModel(bw));
    }

    const cw = customBundle?.variants[variant];
    if (cw) {
      activeCache.set(variant, hydrateTDModel(cw));
      sourceMap.set(variant, 'custom');
    } else if (bw) {
      activeCache.set(variant, bundledCache.get(variant)!);
      sourceMap.set(variant, 'bundled');
    } else {
      const seed = variant === '1v1' ? 101 : variant === '1v1v1' ? 202 : 303;
      activeCache.set(variant, createRandomFunnelModel(variant, 'tanh', seed));
      sourceMap.set(variant, 'fallback');
    }
  }
}

export function hasTrainedTDWeights(variant: GameVariant): boolean {
  if (activeCache.size === 0) {
    refreshTDWeightRegistry();
  }
  const source = sourceMap.get(variant) ?? 'fallback';
  return source !== 'fallback';
}

export function getActiveTDModel(variant: GameVariant): TDFunnelModel {
  if (activeCache.size === 0) {
    refreshTDWeightRegistry();
  }
  return activeCache.get(variant)!;
}

export function getTDWeightMetadata(): TDVariantMetadata[] {
  if (activeCache.size === 0) {
    refreshTDWeightRegistry();
  }
  return ALL_VARIANTS.map((variant) => {
    const m = activeCache.get(variant)!;
    return {
      variant,
      source: sourceMap.get(variant) ?? 'fallback',
      activation: m.activation,
      layerSizes: [m.inputSize, m.hidden1Size, m.hidden2Size, m.outputSize],
      warmstartGames: m.warmstartGames,
      trainedGames: m.trainedGames,
      trainedAt: m.trainedAt,
      benchmarkWinRate: m.benchmarkWinRate,
    };
  });
}

export function importTDWeightBundleJson(jsonText: string): {
  ok: boolean;
  error?: string;
  updatedVariants?: GameVariant[];
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { ok: false, error: 'File is not valid JSON.' };
  }

  const checked = validateTDModelBundle(parsed);
  if (!checked.valid || !checked.bundle) {
    return { ok: false, error: checked.error ?? 'Invalid TD weights bundle.' };
  }

  const existing = loadCustomStorageBundle();
  const merged: TDModelBundle = {
    schemaVersion: 1,
    featureVersion: checked.bundle.featureVersion,
    variants: {
      ...(existing?.variants ?? {}),
      ...checked.bundle.variants,
    },
  };

  saveCustomStorageBundle(merged);
  refreshTDWeightRegistry();

  return {
    ok: true,
    updatedVariants: Object.keys(checked.bundle.variants) as GameVariant[],
  };
}

export function resetTDWeights(variant?: GameVariant): void {
  if (!variant) {
    saveCustomStorageBundle(null);
    refreshTDWeightRegistry();
    return;
  }

  const existing = loadCustomStorageBundle();
  if (existing && existing.variants[variant]) {
    delete existing.variants[variant];
    saveCustomStorageBundle(existing);
  }
  refreshTDWeightRegistry();
}

export function chooseTDAIAction(
  view: PlayerView,
  traceOut?: AIDecisionTrace,
  plannerOptions?: TDPlannerOptions
): TurnAction {
  const model = getActiveTDModel(view.variant);
  if (!model) {
    return chooseAIAction(view, traceOut);
  }
  return chooseTDActionWithModel(view, model, traceOut, plannerOptions);
}

export function chooseActionForBackend(
  view: PlayerView,
  backend?: AIBackend,
  traceOut?: AIDecisionTrace,
  extraOptions?: Pick<TDPlannerOptions, 'rng' | 'featureBuf' | 'workspace'>,
  overrideModel?: TDFunnelModel
): TurnAction {
  const profile = getAIDifficultyProfile(backend);
  if (!profile.isTD) {
    return chooseAIAction(view, traceOut);
  }
  const model = overrideModel ?? getActiveTDModel(view.variant);
  if (!model) {
    return chooseAIAction(view, traceOut);
  }
  return chooseTDActionWithModel(view, model, traceOut, {
    ...profile.plannerOptions,
    ...extraOptions,
  });
}
