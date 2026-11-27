import React, { useState } from 'react';
import { Award, Eye, ScrollText, TrendingUp } from 'lucide-react';
import type { MatchChronologyEvent } from '../engine/types';

export const PrivacyCurtain: React.FC<{
  playerName: string;
  phaseLabel: string;
  onReveal: () => void;
}> = ({ playerName, phaseLabel, onReveal }) => (
  <div
    className="fixed inset-0 z-40 bg-[#1C1714] flex flex-col items-center justify-center p-6 text-center"
    role="dialog"
    aria-modal="true"
    aria-label={`Pass device to ${playerName}`}
  >
    <div className="max-w-sm w-full rounded-2xl bg-[#27201B] border border-[#D9C7A3]/25 p-6 shadow-2xl space-y-5">
      <div className="text-xs uppercase tracking-wider text-[#C8B9A6]">{phaseLabel}</div>
      <h2 className="font-display text-2xl font-bold text-[#F5EFE2]">
        Pass Device to {playerName}
      </h2>
      <button
        type="button"
        onClick={onReveal}
        className="w-full min-h-[48px] rounded-xl bg-[#C88A1E] text-[#1C1714] font-bold text-sm inline-flex items-center justify-center gap-2 hover:bg-[#d89928] transition-colors cursor-pointer"
      >
        <Eye className="w-4 h-4" />
        <span>Reveal Hand &amp; Continue</span>
      </button>
    </div>
  </div>
);

export const VictoryModal: React.FC<{
  summary: string;
  reason: string;
  totalTurns: number;
  players: Array<{
    id: string;
    name: string;
    teamId?: string;
    score: number;
    achievements: number;
    highestTopAge: number;
    isWinner: boolean;
  }>;
  is2v2?: boolean;
  chronology: MatchChronologyEvent[];
  onInspectBoard?: () => void;
  onPlayAgain: () => void;
  onReturnTitle: () => void;
}> = ({ summary, reason, totalTurns, players, is2v2 = false, chronology, onInspectBoard, onPlayAgain, onReturnTitle }) => {
  const [showChronicle, setShowChronicle] = useState(false);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Match Results"
    >
      <div className="max-w-lg w-full max-h-[90vh] flex flex-col rounded-2xl bg-[#27201B] border border-[#C88A1E]/50 p-6 text-[#F5EFE2] shadow-2xl space-y-4 overflow-hidden">
        <div className="shrink-0">
          <div className="flex items-center justify-between gap-2 text-xs font-semibold uppercase tracking-wider text-[#F6C945]">
            <span>Victory · {reason.replace('_', ' ')}</span>
            <span className="font-mono-num text-[#C8B9A6]">{totalTurns} Turns</span>
          </div>
          <h2 className="font-display text-2xl font-bold mt-1 text-balance">{summary}</h2>
        </div>

        {!showChronicle ? (
          <div className="space-y-2.5 overflow-y-auto pr-0.5">
            {players.map((p) => (
              <div
                key={p.id}
                className={`rounded-lg px-3.5 py-2.5 border space-y-1 ${
                  p.isWinner
                    ? 'bg-[#3A2D19] border-[#C88A1E]'
                    : 'bg-[#1C1714] border-[#D9C7A3]/15'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-sm">
                    {is2v2 && p.teamId ? `[Team ${p.teamId}] ` : ''}
                    {p.name} {p.isWinner && '· Winner'}
                  </span>
                  <span className="font-mono-num text-xs text-[#F6C945] font-semibold">
                    {p.achievements} Ach · {p.score} Pts
                  </span>
                </div>
                <div className="text-[11px] font-mono-num text-[#C8B9A6]">
                  Highest Top Card Reached: Age {p.highestTopAge}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex-1 min-h-0 overflow-y-auto space-y-2 pr-1">
            {chronology.length === 0 ? (
              <p className="text-xs text-[#9E8F7E] py-6 text-center">
                No milestones or achievements were recorded in this match.
              </p>
            ) : (
              chronology.map((ev) => (
                <div
                  key={ev.id}
                  className="rounded-lg border border-[#D9C7A3]/15 bg-[#1C1714] px-3 py-2 space-y-1 text-xs"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-1.5 font-semibold text-[#F6C945]">
                      {ev.kind === 'achievement' ? (
                        <Award className="w-3.5 h-3.5 shrink-0" />
                      ) : (
                        <TrendingUp className="w-3.5 h-3.5 shrink-0" />
                      )}
                      <span>
                        {ev.label.startsWith(ev.playerName)
                          ? ev.label
                          : `${ev.playerName} · ${ev.label}`}
                      </span>
                    </span>
                    <span className="font-mono-num text-[11px] text-[#C8B9A6] shrink-0">
                      Turn {ev.turn}
                    </span>
                  </div>
                  {ev.kind === 'achievement' && (
                    <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] font-mono-num text-[#D9C7A3]">
                      {players.map((p) => (
                        <span key={p.id}>
                          {p.name}: {ev.scoresByPlayer[p.id] ?? 0} pts ({ev.achievementsByPlayer[p.id] ?? 0} ach)
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        )}

        <div className="space-y-2 pt-1 shrink-0">
          <div className={`grid ${onInspectBoard ? 'grid-cols-2' : 'grid-cols-1'} gap-2`}>
            {onInspectBoard && (
              <button
                type="button"
                onClick={onInspectBoard}
                className="min-h-[42px] rounded-lg border border-[#D9C7A3]/25 bg-[#1C1714] text-xs sm:text-sm font-semibold text-[#F5EFE2] hover:border-[#F6C945] inline-flex items-center justify-center gap-1.5 cursor-pointer"
              >
                <Eye className="w-4 h-4" />
                <span>Inspect Board</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => setShowChronicle((v) => !v)}
              className={`min-h-[42px] rounded-lg border text-xs sm:text-sm font-semibold inline-flex items-center justify-center gap-1.5 cursor-pointer ${
                showChronicle
                  ? 'border-[#F6C945] bg-[#3A2D19] text-[#F6C945]'
                  : 'border-[#D9C7A3]/25 bg-[#1C1714] text-[#F5EFE2] hover:border-[#F6C945]'
              }`}
            >
              <ScrollText className="w-4 h-4" />
              <span>{showChronicle ? 'Summary' : 'Chronicle'}</span>
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={onReturnTitle}
              className="min-h-[44px] rounded-lg border border-[#D9C7A3]/25 text-xs sm:text-sm font-medium text-[#F5EFE2] hover:bg-[#F5EFE2]/10 cursor-pointer"
            >
              Title Screen
            </button>
            <button
              type="button"
              data-start="true"
              onClick={onPlayAgain}
              className="min-h-[44px] rounded-lg bg-[#C88A1E] text-[#1C1714] text-xs sm:text-sm font-bold hover:bg-[#d89928] cursor-pointer"
            >
              Play Again
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
