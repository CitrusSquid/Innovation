import { ALL_COLORS } from './constants';
import { applyAction, createGame } from './engine';
import { computeScoreTotal } from './keywords';
import { projectPlayerView } from './playerView';
import { generateRandomSeed } from './rng';
import { getHighestTopCardAge } from './splay';
import { TD_INPUT_SIZE } from './tdFeatures';
import { createForwardWorkspace, type TDFunnelModel } from './tdNetwork';
import {
  chooseActionForBackend,
  normalizeAIBackend,
  type CanonicalAIBackend,
} from './tdWeights';
import type {
  AIBackend,
  CardColor,
  CardInstance,
  GameState,
  GameVariant,
  WinReason,
} from './types';

export type HandSortMode = 'newest' | 'sorted';

const COLOR_SORT_INDEX: Record<CardColor, number> = ALL_COLORS.reduce(
  (acc, color, idx) => {
    acc[color] = idx;
    return acc;
  },
  {} as Record<CardColor, number>
);

/**
 * Orders hand cards for display:
 * - `'newest'`: newest drawn/received cards first, oldest last
 * - `'sorted'`: highest age first, then color order, then alphabetical name
 */
export function sortHandCards(
  cards: ReadonlyArray<CardInstance>,
  mode: HandSortMode
): CardInstance[] {
  if (mode === 'newest') {
    return [...cards].reverse();
  }
  return [...cards].sort(
    (a, b) =>
      b.age - a.age ||
      COLOR_SORT_INDEX[a.color] - COLOR_SORT_INDEX[b.color] ||
      a.name.localeCompare(b.name)
  );
}

export interface BenchmarkPlayerSummary {
  id: string;
  name: string;
  teamId: string;
  aiBackend: CanonicalAIBackend;
  score: number;
  achievements: number;
  highestTopAge: number;
  isWinner: boolean;
}

export interface BenchmarkMatchResult {
  matchIndex: number;
  seed: number;
  variant: GameVariant;
  winnerPlayerIds: string[];
  winnerTeamId: string | null;
  reason: WinReason | 'turn_cap';
  summary: string;
  turns: number;
  players: BenchmarkPlayerSummary[];
  finalState?: GameState;
}

export interface RunBenchmarkMatchOptions {
  matchIndex: number;
  variant: GameVariant;
  playerNames: string[];
  playerAIBackends: AIBackend[];
  seed?: number;
  maxTurns?: number;
  modelOverride?: TDFunnelModel;
  modelOverridesBySeat?: Array<TDFunnelModel | undefined>;
  captureFinalState?: boolean;
}

function makeSeededRng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function formatVictoryReasonLabel(reason: WinReason | 'turn_cap'): string {
  switch (reason) {
    case 'achievements':
      return 'Achievements';
    case 'score_age12':
      return 'Score (Age 12+)';
    case 'card_effect':
      return 'Card Effect';
    case 'elimination':
      return 'Elimination';
    case 'turn_cap':
      return 'Turn Cap Draw';
  }
}

export function extractVictoryCardName(
  reason: WinReason | 'turn_cap',
  summary?: string
): string | null {
  if (reason !== 'card_effect' || !summary) return null;
  const match = /\bwins via\s+([^(]+?)(?:\s*\(|!|$)/i.exec(summary);
  return match ? match[1].trim() : null;
}

export function formatVictoryDetailLabel(
  reason: WinReason | 'turn_cap',
  summary?: string
): string {
  const base = formatVictoryReasonLabel(reason);
  const card = extractVictoryCardName(reason, summary);
  return card ? `${base} (${card})` : base;
}

export function runHeadlessBenchmarkMatch(
  opts: RunBenchmarkMatchOptions
): BenchmarkMatchResult {
  const seatCount = opts.variant === '1v1' ? 2 : opts.variant === '1v1v1' ? 3 : 4;
  const seed = opts.seed !== undefined ? ((opts.seed >>> 0) || 1) : generateRandomSeed();
  const maxTurns = opts.maxTurns ?? 450;
  const normalizedBackends = opts.playerAIBackends
    .slice(0, seatCount)
    .map((b) => normalizeAIBackend(b));

  let state: GameState = createGame({
    variant: opts.variant,
    controlMode: 'vs_ai',
    playerNames: opts.playerNames.slice(0, seatCount),
    playerIsAI: Array.from({ length: seatCount }, () => true),
    playerAIBackends: normalizedBackends,
    seed,
    fastSimulation: true,
  });

  const featBuf = new Float32Array(TD_INPUT_SIZE);
  const ws = createForwardWorkspace(opts.variant === '1v1v1' ? 3 : 2);
  const rng = makeSeededRng(seed + 7919);

  let steps = 0;
  while (state.phase !== 'gameover' && state.turnNumber <= maxTurns && steps < 4000) {
    steps += 1;
    const actorId =
      state.pendingPrompts[0]?.playerId ?? state.players[state.currentPlayerIndex]?.id;
    const actorIdx = state.players.findIndex((p) => p.id === actorId);
    const actor = actorIdx >= 0 ? state.players[actorIdx] : undefined;
    if (!actor) break;
    const view = projectPlayerView(state, actor.id);
    const seatModel = opts.modelOverridesBySeat?.[actorIdx] ?? opts.modelOverride;
    const action = chooseActionForBackend(
      view,
      actor.aiBackend,
      undefined,
      { rng, featureBuf: featBuf, workspace: ws },
      seatModel
    );
    state = applyAction(state, action, { mutateInPlace: true });
  }

  const victory = state.victory;
  const winnerIds = victory ? victory.winnerPlayerIds : [];
  const winnerSet = new Set(winnerIds);

  const players: BenchmarkPlayerSummary[] = state.players.map((p, idx) => ({
    id: p.id,
    name: p.name,
    teamId: p.teamId,
    aiBackend: normalizedBackends[idx] ?? normalizeAIBackend(p.aiBackend),
    score: victory?.finalScores[p.id] ?? computeScoreTotal(p),
    achievements: victory?.finalAchievements[p.id] ?? p.achievements.length,
    highestTopAge: Math.max(
      state.highestAgeReachedByPlayer?.[p.id] ?? 1,
      getHighestTopCardAge(p.board)
    ),
    isWinner: winnerSet.has(p.id),
  }));

  let summary = victory?.summary;
  if (!summary) {
    if (winnerIds.length === 0) {
      summary = 'Draw (Turn limit reached)';
    } else if (opts.variant === '2v2' && victory?.winnerTeamId) {
      summary = `Team ${victory.winnerTeamId} Wins`;
    } else {
      const winnerNames = players.filter((p) => p.isWinner).map((p) => p.name);
      summary = `${winnerNames.join(' & ')} Wins`;
    }
  }

  return {
    matchIndex: opts.matchIndex,
    seed,
    variant: opts.variant,
    winnerPlayerIds: winnerIds,
    winnerTeamId: victory?.winnerTeamId ?? null,
    reason: victory?.reason ?? 'turn_cap',
    summary,
    turns: state.turnNumber,
    players,
    ...(opts.captureFinalState ? { finalState: state } : {}),
  };
}

export interface ArenaStats {
  winsBySeat: number[];
  teamAWins: number;
  teamBWins: number;
  draws: number;
  avgTurns: number;
  achWins: number;
  specialWins: number;
  scoreWins: number;
  eliminationWins: number;
}

export function computeArenaStats(
  results: ReadonlyArray<BenchmarkMatchResult>,
  seatCount: number,
  variant: GameVariant
): ArenaStats {
  const winsBySeat = Array.from({ length: seatCount }, () => 0);
  let teamAWins = 0;
  let teamBWins = 0;
  let draws = 0;
  let turnsSum = 0;
  let achWins = 0;
  let specialWins = 0;
  let scoreWins = 0;
  let eliminationWins = 0;

  for (const r of results) {
    turnsSum += r.turns;
    if (r.winnerPlayerIds.length === 0) {
      draws += 1;
      continue;
    }

    if (r.reason === 'achievements') achWins += 1;
    else if (r.reason === 'card_effect') specialWins += 1;
    else if (r.reason === 'score_age12') scoreWins += 1;
    else if (r.reason === 'elimination') eliminationWins += 1;

    if (variant === '2v2') {
      if (r.winnerTeamId === 'A') teamAWins += 1;
      else teamBWins += 1;
    }
    r.players.forEach((p, idx) => {
      if (p.isWinner && idx < winsBySeat.length) {
        winsBySeat[idx] += 1;
      }
    });
  }

  return {
    winsBySeat,
    teamAWins,
    teamBWins,
    draws,
    avgTurns: results.length > 0 ? turnsSum / results.length : 0,
    achWins,
    specialWins,
    scoreWins,
    eliminationWins,
  };
}

export interface FormatBenchmarkLogOptions {
  variant: GameVariant;
  statusLabel: string;
  seatLabels: string[];
  results: ReadonlyArray<BenchmarkMatchResult>;
  stats: ArenaStats;
}

export function formatBenchmarkLogText(opts: FormatBenchmarkLogOptions): string {
  const variantLabel = opts.variant === '1v1v1' ? '3p FFA' : opts.variant;
  const lines: string[] = [
    `AI Arena Log (${variantLabel})`,
    `Status: ${opts.statusLabel} | Avg Turns: ${opts.stats.avgTurns.toFixed(1)} | Draws: ${opts.stats.draws}`,
  ];

  if (opts.variant === '2v2') {
    lines.push(`Wins: Team A ${opts.stats.teamAWins}W | Team B ${opts.stats.teamBWins}W`);
  } else {
    const winParts = opts.seatLabels.map(
      (label, idx) => `${label}: ${opts.stats.winsBySeat[idx] ?? 0}W`
    );
    lines.push(`Wins: ${winParts.join(' | ')}`);
  }

  const methodParts = [
    `Ach wins: ${opts.stats.achWins}`,
    `Special wins: ${opts.stats.specialWins}`,
    `Score wins: ${opts.stats.scoreWins}`,
  ];
  if (opts.stats.eliminationWins > 0) {
    methodParts.push(`Elim wins: ${opts.stats.eliminationWins}`);
  }
  lines.push(`Victory Types: ${methodParts.join(' | ')}`);
  lines.push('');

  for (const res of opts.results) {
    const playerSummaries = res.players
      .map(
        (p) =>
          `${p.name} [${p.aiBackend}${p.isWinner ? ', WIN' : ''}]: ${p.achievements} Ach, ${p.score} Pts`
      )
      .join(' | ');
    lines.push(
      `#${res.matchIndex} | ${res.summary} | ${formatVictoryDetailLabel(res.reason, res.summary)} | ${res.turns}t | ${playerSummaries}`
    );
  }

  return lines.join('\n');
}

