import React, { useMemo, useState } from 'react';
import {
  ArrowLeft,
  BookOpen,
  HelpCircle,
  Info,
  Layers,
  Play,
  RotateCcw,
  Settings as SettingsIcon,
  Trash2,
} from 'lucide-react';
import {
  AI_DIFFICULTY_PROFILES,
  getAIDifficultyProfile,
  hasTrainedTDWeights,
  type CanonicalAIBackend,
} from '../engine/tdWeights';
import type {
  GameConfig,
  GameState,
  GameVariant,
} from '../engine/types';
import { useLongPress } from '../hooks/useLongPress';

interface TitleScreenProps {
  autoSavedGame: GameState | null;
  weightsVersion?: number;
  onStartGame: (config: GameConfig) => void;
  onResumeAutoSave: () => void;
  onDeleteAutoSave: () => void;
  onOpenSettings: () => void;
  onToggleDebugUnlock: () => void;
  onOpenRules: () => void;
  onOpenCardBrowser: () => void;
  onOpenAbout: () => void;
}

const DEFAULT_HUMAN_NAMES = ['Player 1', 'Player 2', 'Player 3', 'Player 4'] as const;
const DEFAULT_AI_NAMES = ['AI Scholar', 'AI Archivist', 'AI Tactician', 'AI Consul'] as const;

export const TitleScreen: React.FC<TitleScreenProps> = ({
  autoSavedGame,
  weightsVersion = 0,
  onStartGame,
  onResumeAutoSave,
  onDeleteAutoSave,
  onOpenSettings,
  onToggleDebugUnlock,
  onOpenRules,
  onOpenCardBrowser,
  onOpenAbout,
}) => {
  const settingsLongPressHandlers = useLongPress({
    durationMs: 5000,
    onLongPress: onToggleDebugUnlock,
    onClick: onOpenSettings,
  });
  const [showPlaySetup, setShowPlaySetup] = useState(false);
  const [showDifficultyInfo, setShowDifficultyInfo] = useState(false);
  const [variant, setVariant] = useState<GameVariant>('1v1');
  const [playerNames, setPlayerNames] = useState<[string, string, string, string]>([
    'Player 1',
    'AI Archivist',
    'AI Tactician',
    'AI Consul',
  ]);
  const [playerIsAI, setPlayerIsAI] = useState<[boolean, boolean, boolean, boolean]>([
    false,
    true,
    true,
    true,
  ]);
  const [playerAIBackends, setPlayerAIBackends] = useState<
    [CanonicalAIBackend, CanonicalAIBackend, CanonicalAIBackend, CanonicalAIBackend]
  >(['td_hard', 'td_hard', 'td_hard', 'td_hard']);

  const tdWeightsAvailable = useMemo(
    () => hasTrainedTDWeights(variant),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [variant, weightsVersion]
  );

  const activeSeatCount = variant === '1v1' ? 2 : variant === '1v1v1' ? 3 : 4;

  const setSeatName = (idx: number, val: string) => {
    setPlayerNames((prev) => {
      const next: [string, string, string, string] = [...prev];
      next[idx] = val;
      return next;
    });
  };

  const setSeatIsAI = (idx: number, isAI: boolean) => {
    setPlayerIsAI((prev) => {
      const next: [boolean, boolean, boolean, boolean] = [...prev];
      next[idx] = isAI;
      return next;
    });
    setPlayerNames((prev) => {
      const next: [string, string, string, string] = [...prev];
      const current = prev[idx].trim();
      if (isAI && (current === '' || current === DEFAULT_HUMAN_NAMES[idx])) {
        next[idx] = DEFAULT_AI_NAMES[idx];
      } else if (!isAI && (current === '' || current === DEFAULT_AI_NAMES[idx])) {
        next[idx] = DEFAULT_HUMAN_NAMES[idx];
      }
      return next;
    });
  };

  const setSeatAIBackend = (idx: number, backend: CanonicalAIBackend) => {
    setPlayerAIBackends((prev) => {
      const next: [
        CanonicalAIBackend,
        CanonicalAIBackend,
        CanonicalAIBackend,
        CanonicalAIBackend,
      ] = [...prev];
      next[idx] = backend;
      return next;
    });
  };

  const getEffectiveBackend = (b: CanonicalAIBackend): CanonicalAIBackend =>
    !tdWeightsAvailable && getAIDifficultyProfile(b).isTD ? 'heuristic' : b;

  const launch = () => {
    const names = playerNames.slice(0, activeSeatCount).map((raw, idx) => {
      const trimmed = raw.trim().slice(0, 15);
      if (trimmed) return trimmed;
      return playerIsAI[idx] ? DEFAULT_AI_NAMES[idx] : DEFAULT_HUMAN_NAMES[idx];
    });
    const aiFlags = playerIsAI.slice(0, activeSeatCount);
    const backends = playerAIBackends
      .slice(0, activeSeatCount)
      .map((b) => getEffectiveBackend(b));
    const humanCount = aiFlags.filter((x) => !x).length;
    onStartGame({
      variant,
      controlMode: humanCount > 1 ? 'pass_and_play' : 'vs_ai',
      playerNames: names,
      playerIsAI: aiFlags,
      playerAIBackends: backends,
    });
  };

  const getSeatLabel = (idx: number) => {
    if (variant !== '2v2') {
      return `Seat ${idx + 1}`;
    }
    if (idx === 0) return 'Seat 1 · Team A';
    if (idx === 1) return 'Seat 2 · Team B';
    if (idx === 2) return 'Seat 3 · Team A';
    return 'Seat 4 · Team B';
  };

  return (
    <main
      className={`min-h-screen bg-archival-table flex flex-col items-center ${
        showPlaySetup
          ? 'justify-start p-0 sm:px-4 sm:pt-4 sm:pb-8'
          : 'justify-center px-4 py-8 sm:px-8'
      }`}
    >
      <div className={`w-full ${showPlaySetup ? 'sm:max-w-4xl' : 'max-w-md space-y-6'}`}>
        {!showPlaySetup && (
          <div className="text-center">
            <h1 className="font-display text-4xl sm:text-5xl font-bold tracking-tight text-[#F5EFE2]">
              Innovation
              <br />
              4th Edition
            </h1>
            <p className="mt-1.5 text-sm sm:text-base text-[#C8B9A6]">
              A fan-made digital adaptation
            </p>
          </div>
        )}

        {!showPlaySetup ? (
          <>
          <section className="rounded-2xl bg-[#27201B] border border-[#D9C7A3]/20 p-6 shadow-2xl space-y-3">
            <button
              type="button"
              onClick={() => setShowPlaySetup(true)}
              className="w-full min-h-[52px] rounded-xl bg-[#C88A1E] text-[#1C1714] font-bold text-base flex items-center justify-center gap-2 hover:bg-[#d89928] transition-colors shadow-lg cursor-pointer"
            >
              <Play className="w-5 h-5 fill-current" />
              <span>Play</span>
            </button>

            <div className="grid grid-cols-2 gap-2.5 pt-1">
              <button
                type="button"
                onClick={onOpenRules}
                className="min-h-[46px] rounded-xl border border-[#D9C7A3]/25 bg-[#1C1714] px-3 text-sm font-semibold text-[#F5EFE2] hover:border-[#F6C945] inline-flex items-center justify-center gap-2 cursor-pointer"
              >
                <BookOpen className="w-4 h-4 text-[#F6C945]" />
                <span>Rules</span>
              </button>

              <button
                type="button"
                onClick={onOpenCardBrowser}
                className="min-h-[46px] rounded-xl border border-[#D9C7A3]/25 bg-[#1C1714] px-3 text-sm font-semibold text-[#F5EFE2] hover:border-[#F6C945] inline-flex items-center justify-center gap-2 cursor-pointer"
              >
                <Layers className="w-4 h-4 text-[#F6C945]" />
                <span>Cards</span>
              </button>

              <button
                type="button"
                {...settingsLongPressHandlers}
                className="min-h-[46px] rounded-xl border border-[#D9C7A3]/25 bg-[#1C1714] px-3 text-sm font-semibold text-[#F5EFE2] hover:border-[#F6C945] inline-flex items-center justify-center gap-2 cursor-pointer select-none"
              >
                <SettingsIcon className="w-4 h-4 text-[#F6C945]" />
                <span>Settings</span>
              </button>

              <button
                type="button"
                onClick={onOpenAbout}
                className="min-h-[46px] rounded-xl border border-[#D9C7A3]/25 bg-[#1C1714] px-3 text-sm font-semibold text-[#F5EFE2] hover:border-[#F6C945] inline-flex items-center justify-center gap-2 cursor-pointer"
              >
                <Info className="w-4 h-4 text-[#F6C945]" />
                <span>About</span>
              </button>
            </div>
          </section>
          <footer className="text-center text-xs text-[#9E8F7E]">
            Innovation is a trademark of Asmadi Games.
          </footer>
          </>
        ) : (
          <section className="min-h-screen sm:min-h-0 rounded-none sm:rounded-xl bg-[#27201B] border border-[#D9C7A3]/20 px-safe pt-safe pb-4 sm:p-6 shadow-2xl space-y-4">
            <div className="flex items-center justify-between gap-2 pb-2.5 border-b border-[#D9C7A3]/15">
              <div className="flex items-center gap-2.5 min-w-0">
                <button
                  type="button"
                  onClick={() => setShowPlaySetup(false)}
                  className="inline-flex items-center gap-1.5 min-h-[36px] px-2.5 rounded-lg border border-[#D9C7A3]/20 text-xs font-medium text-[#D9C7A3] hover:text-[#F5EFE2] hover:bg-[#F5EFE2]/10 cursor-pointer shrink-0"
                >
                  <ArrowLeft className="w-3.5 h-3.5" />
                  <span>Back</span>
                </button>
                <span className="h-4 w-px bg-[#C88A1E]/40 shrink-0" aria-hidden="true" />
                <h2 className="font-display text-base sm:text-lg font-bold text-[#F5EFE2] truncate">
                  Match Setup
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setShowDifficultyInfo((v) => !v)}
                aria-label="AI Difficulty Guide"
                aria-expanded={showDifficultyInfo}
                title="AI Difficulty Details"
                className={`min-h-[36px] min-w-[36px] flex items-center justify-center rounded-lg border transition-colors cursor-pointer shrink-0 ${
                  showDifficultyInfo
                    ? 'border-[#F6C945] bg-[#3A2D19] text-[#F6C945]'
                    : 'border-[#D9C7A3]/20 text-[#D9C7A3] hover:text-[#F5EFE2] hover:bg-[#F5EFE2]/10'
                }`}
              >
                <HelpCircle className="w-4 h-4" />
              </button>
            </div>

            {showDifficultyInfo && (
              <div className="rounded-lg border border-[#C88A1E]/45 bg-[#1C1714] p-3 text-xs space-y-1.5">
                <div className="font-semibold text-[#F6C945]">AI Difficulty Details</div>
                {AI_DIFFICULTY_PROFILES.map((prof) => (
                  <div key={prof.id} className="leading-snug text-[#D9C7A3]">
                    <strong className="text-[#F5EFE2]">{prof.label}:</strong> {prof.description}
                  </div>
                ))}
              </div>
            )}

            {autoSavedGame && autoSavedGame.phase !== 'gameover' && (
              <div className="rounded-xl bg-[#1C1714] border border-[#C88A1E]/50 p-3.5 space-y-2.5">
                <div className="text-xs text-[#E5DAC5]">
                  {autoSavedGame.variant} · Turn {autoSavedGame.turnNumber} ·{' '}
                  {autoSavedGame.players.map((p) => p.name).join(' vs ')}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={onResumeAutoSave}
                    className="flex-1 inline-flex items-center justify-center gap-2 min-h-[42px] px-4 py-2 rounded-lg bg-[#F5EFE2] text-[#1C1714] text-sm font-semibold hover:bg-[#E8DCC4] cursor-pointer whitespace-nowrap"
                  >
                    <RotateCcw className="w-4 h-4" />
                    <span>Resume Match</span>
                  </button>
                  <button
                    type="button"
                    onClick={onDeleteAutoSave}
                    aria-label="Delete saved match"
                    className="inline-flex items-center justify-center min-h-[42px] px-3 py-2 rounded-lg border border-[#D9C7A3]/25 text-xs font-medium text-[#E5DAC5] hover:bg-[#8E2920]/40 hover:border-[#E26D5C] cursor-pointer"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}

            <div className="space-y-1.5">
              <div className="grid grid-cols-3 gap-2">
                <button
                  type="button"
                  onClick={() => setVariant('1v1')}
                  aria-pressed={variant === '1v1'}
                  className={`min-h-[44px] rounded-lg border text-sm font-semibold transition-colors cursor-pointer ${
                    variant === '1v1'
                      ? 'bg-[#F5EFE2] text-[#1C1714] border-[#F5EFE2]'
                      : 'bg-[#1C1714] text-[#D9C7A3] border-[#D9C7A3]/20 hover:border-[#D9C7A3]/50'
                  }`}
                >
                  1 v 1
                </button>
                <button
                  type="button"
                  onClick={() => setVariant('1v1v1')}
                  aria-pressed={variant === '1v1v1'}
                  className={`min-h-[44px] rounded-lg border text-sm font-semibold transition-colors cursor-pointer ${
                    variant === '1v1v1'
                      ? 'bg-[#F5EFE2] text-[#1C1714] border-[#F5EFE2]'
                      : 'bg-[#1C1714] text-[#D9C7A3] border-[#D9C7A3]/20 hover:border-[#D9C7A3]/50'
                  }`}
                >
                  3p FFA
                </button>
                <button
                  type="button"
                  onClick={() => setVariant('2v2')}
                  aria-pressed={variant === '2v2'}
                  className={`min-h-[44px] rounded-lg border text-sm font-semibold transition-colors cursor-pointer ${
                    variant === '2v2'
                      ? 'bg-[#F5EFE2] text-[#1C1714] border-[#F5EFE2]'
                      : 'bg-[#1C1714] text-[#D9C7A3] border-[#D9C7A3]/20 hover:border-[#D9C7A3]/50'
                  }`}
                >
                  2 v 2
                </button>
              </div>
              <div className="min-h-5 flex items-center justify-center text-xs font-mono-num text-[#F6C945]">
                {variant === '1v1'
                  ? '6 achievements required to win'
                  : variant === '1v1v1'
                  ? '5 achievements required to win'
                  : '6 combined team achievements required to win'}
              </div>
              {!tdWeightsAvailable && (
                <div className="text-[11px] text-center text-[#B8A996]">
                  TD weights not detected for {variant === '1v1v1' ? '3p FFA' : variant} — TD AI
                  tiers are greyed out.
                </div>
              )}
            </div>

            <button
              type="button"
              data-start="true"
              onClick={launch}
              className="w-full min-h-[48px] rounded-xl bg-[#C88A1E] text-[#1C1714] font-bold text-base flex items-center justify-center gap-2 hover:bg-[#d89928] transition-colors shadow-lg cursor-pointer"
            >
              <Play className="w-5 h-5 fill-current" />
              <span>Start Match</span>
            </button>

            <div className="flex flex-col gap-2.5">
              {Array.from({ length: activeSeatCount }, (_, idx) => {
                const isAI = playerIsAI[idx];
                const isTeamA = variant === '2v2' && idx % 2 === 0;
                const isTeamB = variant === '2v2' && idx % 2 === 1;
                const effectiveBackend = getEffectiveBackend(playerAIBackends[idx]);
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
                      htmlFor={`p${idx + 1}-name`}
                      className="block text-[11px] font-medium text-[#C8B9A6]"
                    >
                      {getSeatLabel(idx)}
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        id={`p${idx + 1}-name`}
                        type="text"
                        maxLength={15}
                        value={playerNames[idx]}
                        onChange={(e) => setSeatName(idx, e.target.value)}
                        className="flex-1 min-w-0 min-h-[38px] rounded-lg bg-[#1C1714] border border-[#D9C7A3]/25 px-3 text-sm text-[#F5EFE2]"
                      />
                      <div
                        className="grid grid-cols-2 rounded-lg bg-[#1C1714] border border-[#D9C7A3]/20 p-0.5 shrink-0"
                        role="group"
                        aria-label={`${getSeatLabel(idx)} controller`}
                      >
                        <button
                          type="button"
                          onClick={() => setSeatIsAI(idx, false)}
                          aria-pressed={!isAI}
                          className={`min-h-[34px] px-2.5 rounded-md text-xs font-semibold transition-colors cursor-pointer ${
                            !isAI
                              ? 'bg-[#C88A1E] text-[#1C1714]'
                              : 'text-[#C8B9A6] hover:text-[#F5EFE2]'
                          }`}
                        >
                          Human
                        </button>
                        <button
                          type="button"
                          onClick={() => setSeatIsAI(idx, true)}
                          aria-pressed={isAI}
                          className={`min-h-[34px] px-2.5 rounded-md text-xs font-semibold transition-colors cursor-pointer ${
                            isAI
                              ? 'bg-[#C88A1E] text-[#1C1714]'
                              : 'text-[#C8B9A6] hover:text-[#F5EFE2]'
                          }`}
                        >
                          AI
                        </button>
                      </div>
                    </div>

                    {/* All 5 AI options permanently shown below; greyed out if Human or missing TD weights */}
                    <div
                      className="grid grid-cols-3 sm:grid-cols-5 gap-1 pt-1 border-t border-[#D9C7A3]/10"
                      role="group"
                      aria-label={`${getSeatLabel(idx)} AI Difficulty`}
                    >
                      {AI_DIFFICULTY_PROFILES.map((prof) => {
                        const disabled = !isAI || (prof.isTD && !tdWeightsAvailable);
                        const active = isAI && effectiveBackend === prof.id && !disabled;
                        return (
                          <button
                            key={prof.id}
                            type="button"
                            disabled={disabled}
                            onClick={() => {
                              if (!disabled) setSeatAIBackend(idx, prof.id);
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
          </section>
        )}
      </div>
    </main>
  );
};
