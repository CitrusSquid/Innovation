import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Check, Copy, HelpCircle, Play, Save, Square } from 'lucide-react';
import { ALL_AGES, ALL_COLORS, SPECIAL_ACHIEVEMENTS } from '../engine/constants';
import { computeScoreTotal } from '../engine/keywords';
import { generateRandomSeed } from '../engine/rng';
import { getVisibleIconCounts } from '../engine/splay';
import {
  computeArenaStats,
  formatBenchmarkLogText,
  formatVictoryDetailLabel,
  runHeadlessBenchmarkMatch,
  type BenchmarkMatchResult,
} from '../engine/tdBenchmark';
import {
  AI_DIFFICULTY_PROFILES,
  getAIDifficultyProfile,
  hasTrainedTDWeights,
  type CanonicalAIBackend,
} from '../engine/tdWeights';
import type { CardInstance, ColorStack, GameVariant } from '../engine/types';
import { downloadTextFile } from '../utils/offlineExport';
import { ColorStackView } from './CardView';
import { COLOR_THEMES, ColorShapeMark } from './IconGlyph';
import { CardInspectorModal } from './Modals';

interface BenchmarkModalProps {
  open: boolean;
  weightsVersion: number;
  onClose: () => void;
}

const MATCH_COUNTS = [1, 5, 10, 20, 50] as const;
const DEFAULT_BENCH_NAMES = ['AI Alpha', 'AI Beta', 'AI Gamma', 'AI Delta'] as const;

export const BenchmarkModal: React.FC<BenchmarkModalProps> = ({
  open,
  weightsVersion,
  onClose,
}) => {
  const [variant, setVariant] = useState<GameVariant>('1v1');
  const [matchCount, setMatchCount] = useState<number>(10);
  const [showDifficultyHelp, setShowDifficultyHelp] = useState(false);
  const [seatNames, setSeatNames] = useState<[string, string, string, string]>([
    'AI Alpha',
    'AI Beta',
    'AI Gamma',
    'AI Delta',
  ]);
  const [seatBackends, setSeatBackends] = useState<
    [CanonicalAIBackend, CanonicalAIBackend, CanonicalAIBackend, CanonicalAIBackend]
  >(['td_hard', 'td_hard', 'td_hard', 'td_hard']);

  const [isRunning, setIsRunning] = useState(false);
  const [showResultsScreen, setShowResultsScreen] = useState(false);
  const [wasCancelled, setWasCancelled] = useState(false);
  const [results, setResults] = useState<BenchmarkMatchResult[]>([]);
  const [runningTargetCount, setRunningTargetCount] = useState(10);
  const [copiedLog, setCopiedLog] = useState(false);
  const [logNotice, setLogNotice] = useState<string | null>(null);
  const [inspectedMatch, setInspectedMatch] = useState<BenchmarkMatchResult | null>(null);
  const [inspectedStack, setInspectedStack] = useState<ColorStack | null>(null);
  const [inspectedCard, setInspectedCard] = useState<CardInstance | null>(null);

  const cancelledRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const noticeTimerRef = useRef<number | null>(null);

  const tdWeightsAvailable = useMemo(
    () => hasTrainedTDWeights(variant),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [variant, weightsVersion, open]
  );

  useEffect(() => {
    if (!open) {
      cancelledRef.current = true;
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setIsRunning(false);
      setCopiedLog(false);
      setLogNotice(null);
      setInspectedMatch(null);
      setInspectedStack(null);
      setInspectedCard(null);
    }
  }, [open]);

  useEffect(() => {
    return () => {
      cancelledRef.current = true;
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
      if (noticeTimerRef.current !== null) {
        window.clearTimeout(noticeTimerRef.current);
      }
    };
  }, []);

  const activeSeatCount = variant === '1v1' ? 2 : variant === '1v1v1' ? 3 : 4;

  const aggregateStats = useMemo(
    () => computeArenaStats(results, activeSeatCount, variant),
    [results, activeSeatCount, variant]
  );

  if (!open) return null;

  const getSeatLabel = (idx: number) => {
    if (variant !== '2v2') return `Seat ${idx + 1}`;
    if (idx === 0) return 'Seat 1 · Team A';
    if (idx === 1) return 'Seat 2 · Team B';
    if (idx === 2) return 'Seat 3 · Team A';
    return 'Seat 4 · Team B';
  };

  const getEffectiveBackend = (b: CanonicalAIBackend): CanonicalAIBackend =>
    !tdWeightsAvailable && getAIDifficultyProfile(b).isTD ? 'heuristic' : b;

  const handleStart = () => {
    const names = seatNames
      .slice(0, activeSeatCount)
      .map((raw, idx) => raw.trim().slice(0, 15) || DEFAULT_BENCH_NAMES[idx]);
    const backends = seatBackends
      .slice(0, activeSeatCount)
      .map((b) => getEffectiveBackend(b));

    const total = matchCount;
    const baseSeed = generateRandomSeed();

    cancelledRef.current = false;
    setResults([]);
    setInspectedMatch(null);
    setWasCancelled(false);
    setRunningTargetCount(total);
    setShowResultsScreen(true);
    setIsRunning(true);

    let index = 0;
    const runNext = () => {
      if (cancelledRef.current || index >= total) {
        setIsRunning(false);
        return;
      }
      const matchNumber = index + 1;
      const matchRes = runHeadlessBenchmarkMatch({
        matchIndex: matchNumber,
        variant,
        playerNames: names,
        playerAIBackends: backends,
        seed: ((baseSeed + index * 101) >>> 0) || 1,
        captureFinalState: true,
      });
      if (cancelledRef.current) {
        setIsRunning(false);
        return;
      }
      setResults((prev) => [...prev, matchRes]);
      index += 1;
      if (index < total) {
        timerRef.current = window.setTimeout(runNext, 12);
      } else {
        setIsRunning(false);
      }
    };

    timerRef.current = window.setTimeout(runNext, 16);
  };

  const handleCancelRun = () => {
    cancelledRef.current = true;
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setIsRunning(false);
    setWasCancelled(true);
  };

  const statusText = isRunning
    ? `Running ${results.length}/${runningTargetCount}`
    : wasCancelled
    ? `Cancelled (${results.length}/${runningTargetCount})`
    : `Complete (${results.length}/${runningTargetCount})`;

  const buildArenaLog = () => {
    const seatLabels = Array.from({ length: activeSeatCount }, (_, idx) => {
      const bLabel = getAIDifficultyProfile(getEffectiveBackend(seatBackends[idx])).shortLabel;
      const name = seatNames[idx].trim() || DEFAULT_BENCH_NAMES[idx];
      return `${name} (${bLabel})`;
    });
    return formatBenchmarkLogText({
      variant,
      statusLabel: statusText,
      seatLabels,
      results,
      stats: aggregateStats,
    });
  };

  const flashNotice = (msg: string) => {
    setLogNotice(msg);
    if (noticeTimerRef.current !== null) {
      window.clearTimeout(noticeTimerRef.current);
    }
    noticeTimerRef.current = window.setTimeout(() => {
      setLogNotice(null);
      setCopiedLog(false);
    }, 2200);
  };

  const handleSaveLog = () => {
    const text = buildArenaLog();
    const stamp = new Date().toISOString().slice(0, 10);
    downloadTextFile(`ai-arena-log-${variant}-${stamp}.txt`, text, 'text/plain;charset=utf-8');
    flashNotice('Log saved');
  };

  const handleCopyLog = async () => {
    if (typeof navigator === 'undefined' || !navigator.clipboard) {
      flashNotice('Clipboard unavailable');
      return;
    }
    try {
      await navigator.clipboard.writeText(buildArenaLog());
      setCopiedLog(true);
      flashNotice('Copied');
    } catch {
      flashNotice('Copy failed');
    }
  };

  const handleHeaderBack = () => {
    if (inspectedMatch) {
      setInspectedMatch(null);
      setInspectedStack(null);
      setInspectedCard(null);
    } else if (showResultsScreen) {
      if (isRunning) handleCancelRun();
      setShowResultsScreen(false);
      setCopiedLog(false);
      setLogNotice(null);
    } else {
      onClose();
    }
  };

  return (
    <>
      <div
        className="fixed inset-0 z-50 flex items-stretch sm:items-center justify-center bg-black/80 p-0 sm:p-4"
        role="dialog"
        aria-modal="true"
        aria-label={
          inspectedMatch
            ? `Match #${inspectedMatch.matchIndex} End State`
            : showResultsScreen
            ? 'AI Arena'
            : 'AI Arena Setup'
        }
        onClick={(e) => {
          if (e.target !== e.currentTarget) return;
          if (inspectedMatch) {
            setInspectedMatch(null);
            setInspectedStack(null);
            setInspectedCard(null);
          } else if (!isRunning) {
            handleHeaderBack();
          }
        }}
      >
        <div
          className={`w-full sm:max-w-4xl ${
            showResultsScreen
              ? 'h-[100dvh] max-h-[100dvh] sm:h-[86vh]'
              : 'h-[100dvh] max-h-[100dvh] sm:h-auto sm:max-h-[88vh]'
          } flex flex-col rounded-none sm:rounded-xl bg-[#27201B] border border-[#C88A1E]/45 text-[#F5EFE2] shadow-2xl overflow-hidden`}
        >
          {/* Modal Header */}
          <div className="flex items-center justify-between gap-2 px-safe pt-safe pb-2.5 sm:px-5 sm:py-3.5 border-b border-[#D9C7A3]/15 shrink-0">
            <div className="flex items-center gap-2.5 min-w-0">
              <button
                type="button"
                onClick={handleHeaderBack}
                aria-label={
                  inspectedMatch
                    ? 'Back to AI Arena'
                    : showResultsScreen
                    ? 'Back to AI Arena Setup'
                    : 'Back from AI Arena Setup'
                }
                className="inline-flex items-center gap-1.5 min-h-[36px] px-2.5 rounded-lg border border-[#D9C7A3]/20 text-xs font-medium text-[#D9C7A3] hover:text-[#F5EFE2] hover:bg-[#F5EFE2]/10 cursor-pointer shrink-0"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                <span>Back</span>
              </button>
              <span className="h-4 w-px bg-[#C88A1E]/40 shrink-0" aria-hidden="true" />
              <h2 className="font-display text-base sm:text-lg font-bold truncate">
                {inspectedMatch
                  ? `Match #${inspectedMatch.matchIndex} End State`
                  : showResultsScreen
                  ? 'AI Arena'
                  : 'AI Arena Setup'}
              </h2>
            </div>

            <div className="flex items-center justify-end gap-1.5 shrink-0">
              {inspectedMatch ? null : !showResultsScreen ? (
              <button
                type="button"
                onClick={() => setShowDifficultyHelp((v) => !v)}
                aria-label="AI Difficulty Info"
                aria-expanded={showDifficultyHelp}
                title="AI Difficulty Details"
                className={`min-h-[36px] min-w-[36px] flex items-center justify-center rounded-lg border transition-colors cursor-pointer ${
                  showDifficultyHelp
                    ? 'border-[#F6C945] bg-[#3A2D19] text-[#F6C945]'
                    : 'border-[#D9C7A3]/20 text-[#D9C7A3] hover:text-[#F5EFE2] hover:bg-[#F5EFE2]/10'
                }`}
              >
                <HelpCircle className="w-4 h-4" />
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={handleSaveLog}
                  disabled={results.length === 0}
                  aria-label="Save AI Arena Log"
                  title="Save Log (.txt)"
                  className="min-h-[36px] min-w-[36px] flex items-center justify-center rounded-lg border border-[#D9C7A3]/20 text-[#D9C7A3] hover:text-[#F6C945] hover:border-[#F6C945]/60 disabled:opacity-35 cursor-pointer transition-colors"
                >
                  <Save className="w-4 h-4" />
                </button>
                <button
                  type="button"
                  onClick={handleCopyLog}
                  disabled={results.length === 0}
                  aria-label="Copy AI Arena Log"
                  title="Copy Log"
                  className="min-h-[36px] min-w-[36px] flex items-center justify-center rounded-lg border border-[#D9C7A3]/20 text-[#D9C7A3] hover:text-[#F6C945] hover:border-[#F6C945]/60 disabled:opacity-35 cursor-pointer transition-colors"
                >
                  {copiedLog ? (
                    <Check className="w-4 h-4 text-[#8FD19E]" />
                  ) : (
                    <Copy className="w-4 h-4" />
                  )}
                </button>
              </>
            )}
          </div>
        </div>

        {!showResultsScreen ? (
          <div className="flex-1 overflow-y-auto p-5 space-y-4">
            {showDifficultyHelp && (
              <div className="rounded-lg border border-[#C88A1E]/45 bg-[#1C1714] p-3 text-xs space-y-1.5">
                <div className="font-semibold text-[#F6C945]">AI Difficulty Guide</div>
                {AI_DIFFICULTY_PROFILES.map((prof) => (
                  <div key={prof.id} className="leading-snug text-[#D9C7A3]">
                    <strong className="text-[#F5EFE2]">{prof.label}:</strong> {prof.description}
                  </div>
                ))}
              </div>
            )}

            {/* Variant Selector */}
            <div className="space-y-1.5">
              <div className="grid grid-cols-3 gap-2">
                {(['1v1', '1v1v1', '2v2'] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setVariant(v)}
                    aria-pressed={variant === v}
                    className={`min-h-[42px] rounded-lg border text-sm font-semibold transition-colors cursor-pointer ${
                      variant === v
                        ? 'bg-[#F5EFE2] text-[#1C1714] border-[#F5EFE2]'
                        : 'bg-[#1C1714] text-[#D9C7A3] border-[#D9C7A3]/20 hover:border-[#D9C7A3]/50'
                    }`}
                  >
                    {v === '1v1' ? '1 v 1' : v === '1v1v1' ? '3p FFA' : '2 v 2'}
                  </button>
                ))}
              </div>
              {!tdWeightsAvailable && (
                <p className="text-[11px] text-[#C8B9A6] text-center">
                  TD weights not detected for {variant === '1v1v1' ? '3p FFA' : variant} — TD AI
                  options are greyed out.
                </p>
              )}
            </div>

            {/* Match Count Selector */}
            <div className="space-y-1.5">
              <div className="text-xs font-semibold text-[#C8B9A6]">Number of Matches</div>
              <div className="grid grid-cols-5 gap-1.5">
                {MATCH_COUNTS.map((cnt) => (
                  <button
                    key={cnt}
                    type="button"
                    onClick={() => setMatchCount(cnt)}
                    aria-pressed={matchCount === cnt}
                    className={`min-h-[40px] rounded-lg border font-mono-num text-sm font-bold transition-colors cursor-pointer ${
                      matchCount === cnt
                        ? 'bg-[#C88A1E] text-[#1C1714] border-[#C88A1E]'
                        : 'bg-[#1C1714] text-[#D9C7A3] border-[#D9C7A3]/20 hover:border-[#F6C945]/50'
                    }`}
                  >
                    {cnt}
                  </button>
                ))}
              </div>
            </div>

            {/* Seat Configuration Cards (Human Disabled) */}
            <div className="flex flex-col gap-2.5">
              {Array.from({ length: activeSeatCount }, (_, idx) => {
                const isTeamA = variant === '2v2' && idx % 2 === 0;
                const isTeamB = variant === '2v2' && idx % 2 === 1;
                const effectiveBackend = getEffectiveBackend(seatBackends[idx]);
                return (
                  <div
                    key={idx}
                    className={`rounded-lg border p-2.5 space-y-2 ${
                      isTeamA
                        ? 'bg-[#192420]/90 border-[#4D856B]/45'
                        : isTeamB
                        ? 'bg-[#261A1D]/90 border-[#924E53]/45'
                        : 'bg-[#1C1714]/65 border-[#D9C7A3]/15'
                    }`}
                  >
                    <label
                      htmlFor={`bench-p${idx + 1}-name`}
                      className="block text-[11px] font-medium text-[#C8B9A6]"
                    >
                      {getSeatLabel(idx)}
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        id={`bench-p${idx + 1}-name`}
                        type="text"
                        maxLength={15}
                        value={seatNames[idx]}
                        onChange={(e) => {
                          const val = e.target.value;
                          setSeatNames((prev) => {
                            const next: [string, string, string, string] = [...prev];
                            next[idx] = val;
                            return next;
                          });
                        }}
                        className="flex-1 min-w-0 min-h-[38px] rounded-lg bg-[#1C1714] border border-[#D9C7A3]/25 px-3 text-sm text-[#F5EFE2]"
                      />
                      <div
                        className="grid grid-cols-2 rounded-lg bg-[#1C1714] border border-[#D9C7A3]/20 p-0.5 shrink-0"
                        role="group"
                        aria-label={`${getSeatLabel(idx)} controller`}
                      >
                        <button
                          type="button"
                          disabled
                          aria-disabled="true"
                          className="min-h-[34px] px-2.5 rounded-md text-xs font-semibold text-[#7D7061] opacity-40 cursor-not-allowed"
                        >
                          Human
                        </button>
                        <button
                          type="button"
                          aria-pressed="true"
                          className="min-h-[34px] px-2.5 rounded-md text-xs font-semibold bg-[#C88A1E] text-[#1C1714]"
                        >
                          AI
                        </button>
                      </div>
                    </div>

                    {/* All 5 AI Difficulty Options */}
                    <div
                      className="grid grid-cols-3 sm:grid-cols-5 gap-1 pt-1 border-t border-[#D9C7A3]/10"
                      role="group"
                      aria-label={`${getSeatLabel(idx)} AI Difficulty`}
                    >
                      {AI_DIFFICULTY_PROFILES.map((prof) => {
                        const disabled = prof.isTD && !tdWeightsAvailable;
                        const active = effectiveBackend === prof.id && !disabled;
                        return (
                          <button
                            key={prof.id}
                            type="button"
                            disabled={disabled}
                            onClick={() => {
                              if (disabled) return;
                              setSeatBackends((prev) => {
                                const next: [
                                  CanonicalAIBackend,
                                  CanonicalAIBackend,
                                  CanonicalAIBackend,
                                  CanonicalAIBackend,
                                ] = [...prev];
                                next[idx] = prof.id;
                                return next;
                              });
                            }}
                            aria-pressed={active}
                            className={`min-h-[34px] px-1.5 rounded-md text-[11px] font-semibold border transition-colors whitespace-nowrap truncate ${
                              disabled
                                ? 'bg-[#1C1714]/50 border-[#D9C7A3]/10 text-[#7D7061] opacity-35 cursor-not-allowed'
                                : active
                                ? 'bg-[#F5EFE2] text-[#1C1714] border-[#F5EFE2] cursor-pointer'
                                : 'bg-[#1C1714] text-[#D9C7A3] border-[#D9C7A3]/20 hover:border-[#F6C945]/60 cursor-pointer'
                            }`}
                          >
                            {prof.shortLabel}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>

            <button
              type="button"
              onClick={handleStart}
              className="w-full min-h-[48px] rounded-xl bg-[#C88A1E] text-[#1C1714] font-bold text-base flex items-center justify-center gap-2 hover:bg-[#d89928] transition-colors shadow-lg cursor-pointer"
            >
              <Play className="w-5 h-5 fill-current" />
              <span>Start Benchmark ({matchCount} {matchCount === 1 ? 'Match' : 'Matches'})</span>
            </button>
          </div>
        ) : inspectedMatch?.finalState ? (
          <div className="flex-1 overflow-y-auto p-3 sm:p-5 space-y-3">
            {/* Match Summary Header */}
            <div className="rounded-lg border border-[#C88A1E]/45 bg-[#1C1714] p-3 space-y-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="font-display text-sm sm:text-base font-bold text-[#F6C945]">
                  {inspectedMatch.summary}
                </div>
                <span className="font-mono-num text-[11px] text-[#B8A996]">
                  Seed {inspectedMatch.seed}
                </span>
              </div>
              <div className="text-xs font-mono-num text-[#E5DAC5]">
                {formatVictoryDetailLabel(inspectedMatch.reason, inspectedMatch.summary)} ·{' '}
                {inspectedMatch.turns} Turns ·{' '}
                {inspectedMatch.variant === '1v1v1' ? '3p FFA' : inspectedMatch.variant}
              </div>
            </div>

            {/* Player Final Boards */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
              {inspectedMatch.finalState.players.map((p, pIdx) => {
                const summaryPlayer = inspectedMatch.players[pIdx];
                const isWinner = summaryPlayer?.isWinner ?? false;
                const scoreTotal = summaryPlayer?.score ?? computeScoreTotal(p);
                const visibleIcons = getVisibleIconCounts(p.board);
                const backendLabel = getAIDifficultyProfile(
                  summaryPlayer?.aiBackend ?? p.aiBackend
                ).shortLabel;
                return (
                  <section
                    key={p.id}
                    className={`rounded-lg border p-2.5 space-y-2 ${
                      isWinner
                        ? 'border-[#C88A1E] bg-[#2D2318]'
                        : 'border-[#D9C7A3]/20 bg-[#1C1714]/80'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0 flex items-center gap-1.5">
                        <span className="font-display text-sm font-bold text-[#F5EFE2] truncate">
                          {p.name}
                        </span>
                        <span className="font-mono-num text-[10px] text-[#B8A996] shrink-0">
                          ({backendLabel})
                        </span>
                        {isWinner && (
                          <span className="font-mono-num text-[10px] font-bold px-1.5 py-0.5 rounded bg-[#C88A1E] text-[#1C1714] shrink-0">
                            WIN
                          </span>
                        )}
                      </div>
                      <span className="font-mono-num text-xs text-[#F6C945] shrink-0">
                        {p.achievements.length} Ach · {scoreTotal} Pts
                      </span>
                    </div>

                    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[10.5px] font-mono-num text-[#C8B9A6]">
                      <span>Tower {visibleIcons.tower}</span>
                      <span>Crown {visibleIcons.coin}</span>
                      <span>Leaf {visibleIcons.leaf}</span>
                      <span>Bulb {visibleIcons.lightbulb}</span>
                      <span>Fact {visibleIcons.factory}</span>
                      <span>Clock {visibleIcons.clock}</span>
                    </div>

                    {/* 5 Color Stacks (clickable to inspect full stack) */}
                    <div className="grid grid-cols-2 gap-1.5">
                      {ALL_COLORS.map((color) => (
                        <ColorStackView
                          key={color}
                          stack={p.board[color]}
                          boardCompact
                          onInspectStack={(st) => setInspectedStack(st)}
                        />
                      ))}
                      {(() => {
                        const sortedHand = [...p.hand].sort(
                          (a, b) => b.age - a.age || a.name.localeCompare(b.name)
                        );
                        return (
                          <div className="h-[54px] rounded-lg border border-[#D9C7A3]/15 bg-[#1C1714]/65 p-1.5 flex flex-col justify-between text-[10px] font-mono-num text-[#D9C7A3]">
                            <div className="truncate">
                              <span className="text-[#9E8F7E]">Hand ({p.hand.length}): </span>
                              {sortedHand.length === 0
                                ? 'Empty'
                                : sortedHand.map((c) => `[${c.age}]`).join(' ')}
                            </div>
                            <div className="truncate">
                              <span className="text-[#9E8F7E]">Ach: </span>
                              {p.achievements.length === 0
                                ? 'None'
                                : p.achievements
                                    .map((a) =>
                                      a.kind === 'special'
                                        ? SPECIAL_ACHIEVEMENTS[a.specialId!].name
                                        : a.kind === 'chain'
                                        ? `C[${a.age}]`
                                        : `[${a.age}]`
                                    )
                                    .join(' ')}
                            </div>
                          </div>
                        );
                      })()}
                    </div>

                    {p.hand.length > 0 && (
                      <div className="flex flex-wrap gap-1 pt-0.5">
                        {[...p.hand]
                          .sort((a, b) => b.age - a.age || a.name.localeCompare(b.name))
                          .map((c) => {
                            const theme = COLOR_THEMES[c.color];
                            return (
                              <button
                                key={c.instanceId}
                                type="button"
                                onClick={() => setInspectedCard(c)}
                                className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10.5px] font-medium border border-[#1F1A17] cursor-pointer hover:brightness-110"
                                style={{ backgroundColor: theme.header, color: theme.text }}
                              >
                                <ColorShapeMark color={c.color} size={8} />
                                <span>
                                  {c.name} ({c.age})
                                </span>
                              </button>
                            );
                          })}
                      </div>
                    )}
                  </section>
                );
              })}
            </div>

            {/* Remaining Decks & Junk */}
            <div className="rounded-lg border border-[#D9C7A3]/18 bg-[#1C1714] p-2.5 text-[11px] font-mono-num text-[#C8B9A6] flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-semibold text-[#F5EFE2]">Decks Left:</span>
              {ALL_AGES.map((age) => (
                <span key={age}>
                  [{age}]:{inspectedMatch.finalState!.decks[age].length}
                </span>
              ))}
              <span>Junk:{inspectedMatch.finalState.junk.length}</span>
            </div>
          </div>
        ) : (
          <>
            {/* Live Progress Bar & Aggregate Summary */}
            <div className="px-4 sm:px-5 py-2.5 border-b border-[#D9C7A3]/15 bg-[#1C1714]/75 space-y-1 shrink-0">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2 text-xs sm:text-sm font-mono-num">
                  <span className="font-bold text-[#F6C945]">{statusText}</span>
                  <span className="text-[#C8B9A6]">
                    · {variant === '1v1v1' ? '3p FFA' : variant} · Avg{' '}
                    {aggregateStats.avgTurns.toFixed(1)}t · {aggregateStats.draws}D
                  </span>
                  {logNotice && (
                    <span className="text-[11px] font-semibold text-[#8FD19E]" role="status">
                      · {logNotice}
                    </span>
                  )}
                </div>

                {isRunning && (
                  <button
                    type="button"
                    onClick={handleCancelRun}
                    className="min-h-[34px] px-3 rounded-lg bg-[#8E2920] text-[#F5EFE2] text-xs font-bold hover:bg-[#a63329] inline-flex items-center gap-1.5 cursor-pointer"
                  >
                    <Square className="w-3.5 h-3.5 fill-current" />
                    <span>Cancel</span>
                  </button>
                )}
              </div>

              {/* Line 1: Aggregate Wins Bar */}
              <div className="flex flex-wrap items-center gap-x-4 gap-y-0.5 text-xs font-mono-num text-[#E5DAC5]">
                {variant === '2v2' ? (
                  <>
                    <span>
                      Team A: <strong className="text-[#8FD19E]">{aggregateStats.teamAWins}W</strong>
                    </span>
                    <span>
                      Team B: <strong className="text-[#F1B7BD]">{aggregateStats.teamBWins}W</strong>
                    </span>
                  </>
                ) : (
                  Array.from({ length: activeSeatCount }, (_, idx) => {
                    const bLabel = getAIDifficultyProfile(
                      getEffectiveBackend(seatBackends[idx])
                    ).shortLabel;
                    const name = seatNames[idx].trim() || DEFAULT_BENCH_NAMES[idx];
                    return (
                      <span key={idx}>
                        {name} ({bLabel}):{' '}
                        <strong className="text-[#F6C945]">
                          {aggregateStats.winsBySeat[idx]}W
                        </strong>
                      </span>
                    );
                  })
                )}
              </div>

              {/* Line 2: Victory Method Breakdown */}
              <div
                className="flex flex-wrap items-center gap-x-4 gap-y-0.5 text-[11px] font-mono-num text-[#C8B9A6]"
                data-testid="arena-win-methods"
              >
                <span>
                  Ach wins: <strong className="text-[#F5EFE2]">{aggregateStats.achWins}</strong>
                </span>
                <span>
                  Special wins:{' '}
                  <strong className="text-[#F5EFE2]">{aggregateStats.specialWins}</strong>
                </span>
                <span>
                  Score wins: <strong className="text-[#F5EFE2]">{aggregateStats.scoreWins}</strong>
                </span>
                {aggregateStats.eliminationWins > 0 && (
                  <span>
                    Elim wins:{' '}
                    <strong className="text-[#F5EFE2]">{aggregateStats.eliminationWins}</strong>
                  </span>
                )}
              </div>
            </div>

            {/* Streamed Match Results List (Clickable to inspect end-game board state) */}
            <div className="flex-1 overflow-y-auto p-2.5 sm:p-3 space-y-1.5">
              {results.length === 0 ? (
                <div className="py-10 text-center text-xs text-[#C8B9A6] font-mono-num">
                  Running match #1…
                </div>
              ) : (
                results.map((res) => (
                  <button
                    key={res.matchIndex}
                    type="button"
                    disabled={!res.finalState}
                    onClick={() => {
                      if (res.finalState) {
                        setInspectedStack(null);
                        setInspectedCard(null);
                        setInspectedMatch(res);
                      }
                    }}
                    data-testid={`benchmark-row-${res.matchIndex}`}
                    title={res.finalState ? 'Click to inspect end-game board state' : undefined}
                    className="w-full text-left rounded-lg border border-[#D9C7A3]/20 bg-[#1C1714] hover:border-[#F6C945]/60 px-2.5 py-1.5 flex flex-col md:flex-row md:items-center md:justify-between gap-1.5 md:gap-2.5 transition-colors cursor-pointer disabled:cursor-default"
                  >
                    {/* Left Summary Block */}
                    <div className="flex items-center justify-between md:justify-start gap-2.5 md:w-[256px] shrink-0">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5 text-xs font-mono-num">
                          <span className="font-bold text-[#F6C945]">#{res.matchIndex}</span>
                          <span className="text-[#D9C7A3] font-semibold truncate">
                            {res.summary}
                          </span>
                        </div>
                        <div className="text-[11px] font-mono-num text-[#B8A996] leading-tight truncate">
                          {formatVictoryDetailLabel(res.reason, res.summary)} · {res.turns} Turns
                        </div>
                      </div>
                    </div>

                    {/* Player Breakdown: Vertical on Mobile, Horizontal Row on Desktop */}
                    <div
                      className={`flex-1 grid grid-cols-1 gap-1 md:gap-1.5 ${
                        res.players.length === 2
                          ? 'md:grid-cols-2'
                          : res.players.length === 3
                          ? 'md:grid-cols-3'
                          : 'md:grid-cols-4'
                      }`}
                    >
                      {res.players.map((p) => (
                        <div
                          key={p.id}
                          className={`rounded-md border px-2 py-1 flex items-center justify-between md:flex-col md:items-start md:justify-center gap-0.5 ${
                            p.isWinner
                              ? 'bg-[#3A2D19] border-[#C88A1E]'
                              : 'bg-[#27201B]/80 border-[#D9C7A3]/12'
                          }`}
                        >
                          <div className="min-w-0 flex items-center gap-1.5">
                            <span className="text-xs font-semibold text-[#F5EFE2] truncate leading-tight">
                              {p.name}
                            </span>
                            {p.isWinner && (
                              <span className="text-[10px] font-mono-num font-bold text-[#F6C945] shrink-0">
                                Win
                              </span>
                            )}
                          </div>
                          <div className="font-mono-num text-[11px] text-[#E5DAC5] shrink-0 leading-tight">
                            {p.achievements} Ach · {p.score} Pts
                          </div>
                        </div>
                      ))}
                    </div>
                  </button>
                ))
              )}
            </div>
          </>
        )}
      </div>
    </div>

    {(inspectedStack || inspectedCard) && (
      <CardInspectorModal
        stack={inspectedStack}
        card={inspectedCard}
        onClose={() => {
          setInspectedStack(null);
          setInspectedCard(null);
        }}
      />
    )}
    </>
  );
};
