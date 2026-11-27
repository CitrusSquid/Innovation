import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  ArrowLeft,
  Award,
  Cpu,
  Download,
  RotateCcw,
  Search,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { AVAILABLE_DATABASE_AGES, BASE_CARD_DATABASE, instantiateCard } from '../data/cards/catalog';
import { getSpecialAchievementProgressLabel } from '../engine/ai';
import {
  AGE_NAMES,
  ALL_AGES,
  ALL_COLORS,
  COLOR_LABELS,
  ICON_LABELS,
  SPECIAL_ACHIEVEMENTS,
} from '../engine/constants';
import { getStackVisibleIcons } from '../engine/splay';
import {
  clearAutoMatch,
  deleteSaveSlot,
  deserializeGameState,
  isLocalStorageAvailable,
  listSaveSlots,
  loadAutoMatch,
  saveNamedSlot,
  serializeGameState,
  type SaveSlotRecord,
} from '../engine/storage';
import type { AppSettings, ShowOpponentMovesMode } from '../engine/settings';
import {
  getTDWeightMetadata,
  importTDWeightBundleJson,
  resetTDWeights,
  type TDVariantMetadata,
} from '../engine/tdWeights';
import type {
  Age,
  CardBack,
  CardColor,
  CardInstance,
  ClaimedAchievement,
  ColorStack,
  FunctionalIcon,
  GameState,
  PendingPrompt,
  PlayerBoard,
  PlayerView,
  PublicPlayerView,
  RepeatDrawStepEvent,
  SpecialAchievementId,
  TurnAction,
} from '../engine/types';
import {
  getSortedSpecialAchievements,
  getZeroSelectionSkipLabels,
} from '../engine/uiHelpers';
import { CardTile, groupCountByAge } from './CardView';
import { COLOR_THEMES, ColorShapeMark, IconGlyph } from './IconGlyph';
import { OfflineExportButton } from './OfflineExportButton';
import { downloadTextFile } from '../utils/offlineExport';

export const DogmaPromptModal: React.FC<{
  prompt: PendingPrompt | null;
  viewerId: string;
  board: PlayerBoard;
  onAnswer: (action: TurnAction) => void;
  onInspectBoard?: () => void;
}> = ({ prompt, viewerId, board, onAnswer, onInspectBoard }) => {
  const [selectedCardIds, setSelectedCardIds] = useState<string[]>([]);
  const [orderedIds, setOrderedIds] = useState<string[]>([]);
  const [confirmingSkip, setConfirmingSkip] = useState(false);

  useEffect(() => {
    setSelectedCardIds([]);
    setOrderedIds([]);
    setConfirmingSkip(false);
  }, [prompt]);

  if (!prompt || prompt.kind === 'setup_meld') return null;

  const inspectButton = onInspectBoard ? (
    <button
      type="button"
      onClick={onInspectBoard}
      aria-label="Inspect board state"
      title="Inspect board state"
      className="min-h-[34px] min-w-[34px] shrink-0 rounded-lg border border-[#D9C7A3]/25 bg-[#1C1714] text-[#D9C7A3] hover:text-[#F6C945] hover:border-[#F6C945] flex items-center justify-center cursor-pointer"
    >
      <Search className="w-4 h-4" />
    </button>
  ) : null;

  if (prompt.kind === 'choose_color') {
    const targetLabel =
      prompt.splayDirection === 'aslant' ? 'askew' : prompt.splayDirection;
    const skipLabels = getZeroSelectionSkipLabels(prompt);

    return (
      <div
        className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/75 p-0 sm:p-4"
        role="dialog"
        aria-modal="true"
        aria-label={prompt.title}
        onClick={() => {
          if (confirmingSkip) setConfirmingSkip(false);
        }}
      >
        <div className="w-full sm:max-w-md rounded-t-2xl sm:rounded-xl bg-[#27201B] border border-[#C88A1E] p-5 text-[#F5EFE2] shadow-2xl space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="font-display text-lg font-bold text-[#F6C945]">{prompt.title}</h2>
              {prompt.subtitle && (
                <p className="text-xs text-[#E5DAC5] mt-1 leading-relaxed">{prompt.subtitle}</p>
              )}
            </div>
            {inspectButton}
          </div>

          <div className="space-y-2">
            {prompt.options.map((color) => {
              const stack = board[color];
              const currentLabel = stack.splay === 'aslant' ? 'askew' : stack.splay;
              const theme = COLOR_THEMES[color];
              return (
                <button
                  key={color}
                  type="button"
                  onClick={() => {
                    setConfirmingSkip(false);
                    onAnswer({
                      type: 'answer_prompt',
                      playerId: viewerId,
                      promptId: prompt.id,
                      selectedColor: color,
                    });
                  }}
                  className="w-full min-h-[48px] rounded-lg border border-[#D9C7A3]/25 bg-[#1C1714] px-3.5 py-2 flex items-center justify-between gap-3 hover:border-[#F6C945] cursor-pointer text-left"
                >
                  <div className="flex items-center gap-2.5">
                    <span
                      className="w-3 h-7 rounded-sm shrink-0"
                      style={{ backgroundColor: theme.header }}
                    />
                    <ColorShapeMark color={color} size={14} />
                    <span className="font-display text-sm font-bold capitalize text-[#F5EFE2]">
                      {color}
                    </span>
                  </div>
                  <span className="font-mono-num text-xs text-[#C8B9A6]">
                    {stack.cards.length} cards · {currentLabel}
                    {targetLabel ? ` → ${targetLabel}` : ''}
                  </span>
                </button>
              );
            })}
          </div>

          {prompt.allowSkip && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                if (!confirmingSkip) {
                  setConfirmingSkip(true);
                  return;
                }
                setConfirmingSkip(false);
                onAnswer({
                  type: 'answer_prompt',
                  playerId: viewerId,
                  promptId: prompt.id,
                });
              }}
              className={`w-full min-h-[44px] rounded-lg border text-sm transition-colors cursor-pointer ${
                confirmingSkip
                  ? 'border-[#F6C945] bg-[#3A2D19] text-[#F6C945] font-bold ring-1 ring-[#F6C945]/50'
                  : 'border-[#D9C7A3]/25 text-[#D9C7A3] font-medium hover:bg-[#F5EFE2]/10'
              }`}
            >
              {confirmingSkip ? skipLabels.confirmLabel : skipLabels.idleLabel}
            </button>
          )}
        </div>
      </div>
    );
  }

  if (prompt.kind === 'choose_cards') {
    const toggleCard = (instanceId: string) => {
      setConfirmingSkip(false);
      setSelectedCardIds((prev) => {
        if (prev.includes(instanceId)) {
          return prev.filter((id) => id !== instanceId);
        }
        if (prompt.max === 1) {
          return [instanceId];
        }
        if (prev.length >= prompt.max) {
          return prev;
        }
        return [...prev, instanceId];
      });
    };

    const canChooseZero = prompt.allowSkip || prompt.min === 0;
    const skipLabels = getZeroSelectionSkipLabels(prompt);
    const canConfirm =
      selectedCardIds.length > 0 &&
      selectedCardIds.length >= prompt.min &&
      selectedCardIds.length <= prompt.max;
    const isMultiOrder = prompt.max > 1;

    return (
      <div
        className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/75 p-0 sm:p-4"
        role="dialog"
        aria-modal="true"
        aria-label={prompt.title}
        onClick={() => {
          if (confirmingSkip) setConfirmingSkip(false);
        }}
      >
        <div className="w-full sm:max-w-3xl max-h-[90vh] flex flex-col rounded-t-2xl sm:rounded-xl bg-[#27201B] border border-[#C88A1E] text-[#F5EFE2] shadow-2xl overflow-hidden">
          <div className="p-5 pb-3 border-b border-[#D9C7A3]/15 shrink-0">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="font-display text-lg font-bold text-[#F6C945]">{prompt.title}</h2>
                {prompt.subtitle && (
                  <p className="text-xs text-[#E5DAC5] mt-1 leading-relaxed">{prompt.subtitle}</p>
                )}
              </div>
              {inspectButton}
            </div>
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-[#C8B9A6] font-mono-num">
              <span>
                {prompt.sourceLabel}
                {isMultiOrder ? ' · Click in order (#1 = top → bottom)' : ''}
              </span>
              <span>
                Selected: <strong className="text-[#F6C945]">{selectedCardIds.length}</strong> /{' '}
                {prompt.min === prompt.max ? prompt.max : `${prompt.min}–${prompt.max}`}
              </span>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-5">
            <div className="flex flex-wrap justify-center sm:justify-start gap-3">
              {prompt.candidates.map((card) => {
                const orderIdx = selectedCardIds.indexOf(card.instanceId);
                const isSelected = orderIdx !== -1;
                return (
                  <div key={card.instanceId} className="relative">
                    {isSelected && (
                      <span className="absolute -top-2 -right-2 z-10 w-6 h-6 rounded-full bg-[#F6C945] text-[#1C1714] font-mono-num text-xs font-bold flex items-center justify-center shadow-md pointer-events-none">
                        {orderIdx + 1}
                      </span>
                    )}
                    <CardTile
                      card={card}
                      compact
                      selected={isSelected}
                      onClick={() => toggleCard(card.instanceId)}
                    />
                  </div>
                );
              })}
            </div>
          </div>

          <div className="p-4 border-t border-[#D9C7A3]/15 bg-[#1C1714]/70 flex flex-wrap items-center justify-between gap-2 shrink-0">
            <div>
              {selectedCardIds.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setSelectedCardIds([]);
                    setConfirmingSkip(false);
                  }}
                  className="min-h-[44px] px-4 rounded-lg border border-[#D9C7A3]/25 text-sm font-medium text-[#E5DAC5] hover:bg-[#F5EFE2]/10 cursor-pointer"
                >
                  Reset
                </button>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {canChooseZero && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!confirmingSkip) {
                      setSelectedCardIds([]);
                      setConfirmingSkip(true);
                      return;
                    }
                    setConfirmingSkip(false);
                    onAnswer({
                      type: 'answer_prompt',
                      playerId: viewerId,
                      promptId: prompt.id,
                      selectedCardIds: [],
                    });
                  }}
                  className={`min-h-[44px] px-4 rounded-lg border text-sm transition-colors cursor-pointer ${
                    confirmingSkip
                      ? 'border-[#F6C945] bg-[#3A2D19] text-[#F6C945] font-bold ring-1 ring-[#F6C945]/50'
                      : 'border-[#D9C7A3]/25 text-[#D9C7A3] font-medium hover:bg-[#F5EFE2]/10'
                  }`}
                >
                  {confirmingSkip ? skipLabels.confirmLabel : skipLabels.idleLabel}
                </button>
              )}
              <button
                type="button"
                disabled={!canConfirm}
                onClick={() => {
                  setConfirmingSkip(false);
                  onAnswer({
                    type: 'answer_prompt',
                    playerId: viewerId,
                    promptId: prompt.id,
                    selectedCardIds,
                  });
                }}
                className="min-h-[44px] px-5 rounded-lg bg-[#C88A1E] text-[#1C1714] text-sm font-bold hover:bg-[#d89928] disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
              >
                {selectedCardIds.length > 0
                  ? `Confirm Selection (${selectedCardIds.length})`
                  : 'Confirm Selection'}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (prompt.kind === 'choose_yes_no') {
    return (
      <div
        className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/75 p-0 sm:p-4"
        role="dialog"
        aria-modal="true"
        aria-label={prompt.title}
      >
        <div className="w-full sm:max-w-md rounded-t-2xl sm:rounded-xl bg-[#27201B] border border-[#C88A1E] p-5 text-[#F5EFE2] shadow-2xl space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="font-display text-lg font-bold text-[#F6C945]">{prompt.title}</h2>
              {prompt.subtitle && (
                <p className="text-xs text-[#E5DAC5] mt-1 leading-relaxed">{prompt.subtitle}</p>
              )}
            </div>
            {inspectButton}
          </div>
          <div className="flex flex-col sm:flex-row gap-2">
            <button
              type="button"
              onClick={() =>
                onAnswer({
                  type: 'answer_prompt',
                  playerId: viewerId,
                  promptId: prompt.id,
                  confirmed: true,
                })
              }
              className="flex-1 min-h-[44px] px-4 rounded-lg bg-[#C88A1E] text-[#1C1714] text-sm font-bold hover:bg-[#d89928] cursor-pointer"
            >
              {prompt.confirmLabel}
            </button>
            <button
              type="button"
              onClick={() =>
                onAnswer({
                  type: 'answer_prompt',
                  playerId: viewerId,
                  promptId: prompt.id,
                  confirmed: false,
                })
              }
              className="flex-1 min-h-[44px] px-4 rounded-lg border border-[#D9C7A3]/25 text-sm font-medium text-[#D9C7A3] hover:bg-[#F5EFE2]/10 cursor-pointer"
            >
              {prompt.declineLabel}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (prompt.kind === 'choose_value') {
    return (
      <div
        className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/75 p-0 sm:p-4"
        role="dialog"
        aria-modal="true"
        aria-label={prompt.title}
      >
        <div className="w-full sm:max-w-md rounded-t-2xl sm:rounded-xl bg-[#27201B] border border-[#C88A1E] p-5 text-[#F5EFE2] shadow-2xl space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="font-display text-lg font-bold text-[#F6C945]">{prompt.title}</h2>
              {prompt.subtitle && (
                <p className="text-xs text-[#E5DAC5] mt-1 leading-relaxed">{prompt.subtitle}</p>
              )}
            </div>
            {inspectButton}
          </div>
          <div className="flex flex-wrap gap-2">
            {prompt.options.map((val) => (
              <button
                key={val}
                type="button"
                onClick={() =>
                  onAnswer({
                    type: 'answer_prompt',
                    playerId: viewerId,
                    promptId: prompt.id,
                    selectedValue: val,
                  })
                }
                className="flex-1 min-w-[100px] min-h-[48px] px-4 rounded-lg bg-[#C88A1E] text-[#1C1714] font-mono-num text-sm font-bold hover:bg-[#d89928] cursor-pointer"
              >
                Age {val} ({AGE_NAMES[val]})
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (prompt.kind === 'choose_option') {
    return (
      <div
        className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/75 p-0 sm:p-4"
        role="dialog"
        aria-modal="true"
        aria-label={prompt.title}
      >
        <div className="w-full sm:max-w-lg rounded-t-2xl sm:rounded-xl bg-[#27201B] border border-[#C88A1E] p-5 text-[#F5EFE2] shadow-2xl space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="font-display text-lg font-bold text-[#F6C945]">{prompt.title}</h2>
              {prompt.subtitle && (
                <p className="text-xs text-[#E5DAC5] mt-1 leading-relaxed">{prompt.subtitle}</p>
              )}
            </div>
            {inspectButton}
          </div>
          <div className="space-y-2">
            {prompt.options.map((opt) => (
              <button
                key={opt.id}
                type="button"
                onClick={() =>
                  onAnswer({
                    type: 'answer_prompt',
                    playerId: viewerId,
                    promptId: prompt.id,
                    selectedOptionId: opt.id,
                  })
                }
                className="w-full min-h-[48px] rounded-lg border border-[#D9C7A3]/25 bg-[#1C1714] px-4 py-2.5 text-left hover:border-[#F6C945] cursor-pointer space-y-0.5"
              >
                <div className="text-sm font-semibold text-[#F5EFE2]">{opt.label}</div>
                {opt.description && (
                  <div className="text-xs text-[#C8B9A6] font-mono-num">{opt.description}</div>
                )}
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (prompt.kind === 'choose_order') {
    const toggleOrderCard = (instanceId: string) => {
      setOrderedIds((prev) =>
        prev.includes(instanceId)
          ? prev.filter((id) => id !== instanceId)
          : [...prev, instanceId]
      );
    };
    const isComplete = orderedIds.length === prompt.cards.length;

    return (
      <div
        className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/75 p-0 sm:p-4"
        role="dialog"
        aria-modal="true"
        aria-label={prompt.title}
      >
        <div className="w-full sm:max-w-3xl max-h-[88vh] flex flex-col rounded-t-2xl sm:rounded-xl bg-[#27201B] border border-[#C88A1E] text-[#F5EFE2] shadow-2xl overflow-hidden">
          <div className="p-5 pb-3 border-b border-[#D9C7A3]/15 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="font-display text-lg font-bold text-[#F6C945]">{prompt.title}</h2>
              <p className="text-xs text-[#E5DAC5] mt-1">
                Click cards in order from #1 (first / top) to #{prompt.cards.length} (last / bottom).
              </p>
            </div>
            {inspectButton}
          </div>
          <div className="flex-1 overflow-y-auto p-5">
            <div className="flex flex-wrap justify-center sm:justify-start gap-3">
              {prompt.cards.map((c) => {
                const orderIdx = orderedIds.indexOf(c.instanceId);
                const isSelected = orderIdx !== -1;
                return (
                  <div key={c.instanceId} className="relative">
                    {isSelected && (
                      <span className="absolute -top-2 -right-2 z-10 w-6 h-6 rounded-full bg-[#F6C945] text-[#1C1714] font-mono-num text-xs font-bold flex items-center justify-center shadow-md pointer-events-none">
                        #{orderIdx + 1}
                      </span>
                    )}
                    <CardTile
                      card={c}
                      compact
                      selected={isSelected}
                      onClick={() => toggleOrderCard(c.instanceId)}
                    />
                  </div>
                );
              })}
            </div>
          </div>
          <div className="p-4 border-t border-[#D9C7A3]/15 bg-[#1C1714]/70 flex items-center justify-between gap-2">
            <button
              type="button"
              disabled={orderedIds.length === 0}
              onClick={() => setOrderedIds([])}
              className="min-h-[44px] px-4 rounded-lg border border-[#D9C7A3]/25 text-sm font-medium text-[#E5DAC5] hover:bg-[#F5EFE2]/10 disabled:opacity-35 cursor-pointer"
            >
              Reset
            </button>
            <button
              type="button"
              disabled={!isComplete}
              onClick={() =>
                onAnswer({
                  type: 'answer_prompt',
                  playerId: viewerId,
                  promptId: prompt.id,
                  orderedCardIds: orderedIds,
                })
              }
              className="min-h-[44px] px-5 rounded-lg bg-[#C88A1E] text-[#1C1714] text-sm font-bold hover:bg-[#d89928] disabled:opacity-40 cursor-pointer"
            >
              Confirm Order ({orderedIds.length}/{prompt.cards.length})
            </button>
          </div>
        </div>
      </div>
    );
  }

  return null;
};

export interface PileSummaryTarget {
  title: string;
  subtitle?: string;
  backs?: CardBack[];
  cards?: CardInstance[];
}

export const PileSummaryModal: React.FC<{
  target: PileSummaryTarget | null;
  onInspectCard: (card: CardInstance) => void;
  onClose: () => void;
}> = ({ target, onInspectCard, onClose }) => {
  if (!target) return null;

  const items = target.cards ?? target.backs ?? [];
  const ageCounts = groupCountByAge(items);
  const sortedCards = target.cards
    ? [...target.cards].sort((a, b) => b.age - a.age || a.name.localeCompare(b.name))
    : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/75 p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label={target.title}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full sm:max-w-lg max-h-[85vh] overflow-y-auto rounded-t-2xl sm:rounded-xl bg-[#27201B] border border-[#D9C7A3]/25 p-5 text-[#F5EFE2] shadow-2xl space-y-4">
        <div className="flex items-center justify-between gap-4 pb-3 border-b border-[#D9C7A3]/15">
          <div>
            <h2 className="font-display text-lg font-bold">{target.title}</h2>
            {target.subtitle && (
              <p className="text-xs text-[#C8B9A6] font-mono-num mt-0.5">{target.subtitle}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Pile Summary"
            className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg hover:bg-[#F5EFE2]/10 cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Numeric count per Age */}
        <div>
          <h3 className="text-xs font-semibold text-[#C8B9A6] mb-2">
            Count by Age ({items.length} total)
          </h3>
          {ageCounts.length === 0 ? (
            <p className="text-xs text-[#8D7F70]">No cards in this pile.</p>
          ) : (
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
              {ageCounts.map(({ age, count }) => (
                <div
                  key={age}
                  className="rounded-lg border border-[#D9C7A3]/20 bg-[#1C1714] px-3 py-2 flex items-center justify-between"
                >
                  <div>
                    <div className="font-mono-num text-xs font-bold text-[#F6C945]">
                      Age {age}
                    </div>
                    <div className="text-[10px] text-[#A99B89] truncate max-w-[72px]">
                      {AGE_NAMES[age]}
                    </div>
                  </div>
                  <span className="font-mono-num text-base font-bold text-[#F5EFE2]">
                    {count}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* If visible to viewer (Hand / Score Pile), allow clicking any card to inspect full text */}
        {sortedCards && sortedCards.length > 0 && (
          <div className="pt-3 border-t border-[#D9C7A3]/15 space-y-2">
            <h3 className="text-xs font-semibold text-[#C8B9A6]">
              Cards (Tap any card to inspect full details)
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {sortedCards.map((card) => {
                const theme = COLOR_THEMES[card.color];
                return (
                  <button
                    key={card.instanceId}
                    type="button"
                    onClick={() => onInspectCard(card)}
                    className="flex items-center justify-between gap-2 rounded-lg border border-[#D9C7A3]/20 bg-[#1C1714] px-3 py-2 text-left hover:border-[#F6C945] cursor-pointer min-h-[44px]"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className="font-mono-num text-xs font-bold px-1.5 py-0.5 rounded shrink-0"
                        style={{ backgroundColor: theme.header, color: theme.text }}
                      >
                        {card.age}
                      </span>
                      <ColorShapeMark color={card.color} size={11} />
                      <span className="font-display text-xs font-semibold truncate text-[#F5EFE2]">
                        {card.name}
                      </span>
                    </div>
                    <span className="text-[11px] text-[#C8B9A6] shrink-0">Inspect</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

const SplayedPileVisual: React.FC<{
  stack: ColorStack;
  focusedCardId: string | null;
  onSelectCard: (card: CardInstance) => void;
  onClearFocus: () => void;
}> = ({ stack, focusedCardId, onSelectCard, onClearFocus }) => {
  const [viewportW, setViewportW] = useState(
    typeof window !== 'undefined' ? window.innerWidth : 1024
  );

  useEffect(() => {
    const onResize = () => setViewportW(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const isMobile = viewportW < 640;
  const cards = stack.cards; // index 0 = bottom, index n-1 = top
  const n = cards.length;
  const theme = COLOR_THEMES[stack.color];

  // Bound Column 1 width strictly so splayed cards never overlap Column 2 on desktop
  const modalInnerW = isMobile ? Math.max(276, viewportW - 44) : Math.min(540, Math.max(400, viewportW - 340));
  const hasHorizSpread = n > 1 && stack.splay !== 'up';
  const cardW = isMobile
    ? Math.max(204, Math.min(240, modalInnerW - (hasHorizSpread ? Math.min(80, (n - 1) * 20) : 0)))
    : 286;
  const cardH = isMobile ? 330 : 365;

  const maxOffsetX = isMobile ? Math.max(0, modalInnerW - cardW) : Math.max(0, modalInnerW - cardW - 12);
  const maxOffsetY = isMobile ? 132 : 160;

  const stepX =
    n > 1
      ? stack.splay === 'left' || stack.splay === 'right' || stack.splay === 'aslant'
        ? Math.min(46, Math.floor(maxOffsetX / (n - 1)))
        : stack.splay === 'none'
        ? Math.min(12, Math.floor(Math.min(52, maxOffsetX) / (n - 1)))
        : 0
      : 0;

  const stepY =
    n > 1
      ? stack.splay === 'up' || stack.splay === 'aslant'
        ? Math.min(36, Math.floor(maxOffsetY / (n - 1)))
        : stack.splay === 'none'
        ? Math.min(10, Math.floor(42 / (n - 1)))
        : 0
      : 0;

  const positions = cards.map((_, idx) => {
    switch (stack.splay) {
      case 'right':
        return { x: idx * stepX, y: 0 };
      case 'left':
        return { x: (n - 1 - idx) * stepX, y: 0 };
      case 'up':
        return { x: 0, y: (n - 1 - idx) * stepY };
      case 'aslant':
        return { x: idx * stepX, y: (n - 1 - idx) * stepY };
      case 'none':
        return { x: idx * stepX, y: idx * stepY };
    }
  });

  const stageW = cardW + Math.max(0, ...positions.map((p) => p.x));
  const stageH = cardH + Math.max(0, ...positions.map((p) => p.y));
  const reversedCards = [...cards].reverse();

  return (
    <div className="space-y-3">
      <div className="flex flex-col sm:flex-row sm:items-start gap-4">
        {/* Column 1: Bounded overlapping pile visual */}
        <div className="flex-1 min-w-0 overflow-hidden flex flex-col items-center">
          <div
            className="relative mx-auto max-w-full cursor-default"
            style={{ width: `${stageW}px`, height: `${stageH}px` }}
            role="group"
            aria-label={`Overlapping ${stack.color} pile (${stack.splay === 'aslant' ? 'askew' : stack.splay})`}
            onClick={(e) => e.stopPropagation()}
          >
            {cards.map((c, idx) => {
              const pos = positions[idx];
              const isTop = idx === n - 1;
              const isFocused = c.instanceId === focusedCardId;
              const isDimmed = focusedCardId !== null && !isFocused;

              return (
                <button
                  key={c.instanceId}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (focusedCardId !== null) {
                      onClearFocus();
                    } else {
                      onSelectCard(c);
                    }
                  }}
                  style={{
                    left: `${pos.x}px`,
                    top: `${pos.y}px`,
                    width: `${cardW}px`,
                    height: `${cardH}px`,
                    zIndex: isFocused ? n + 10 : idx + 1,
                    backgroundColor: theme.soft,
                    color: '#1F1A17',
                  }}
                  className={`absolute flex flex-col rounded-lg border overflow-hidden text-left shadow-lg transition-all duration-150 cursor-pointer focus-visible:outline-2 focus-visible:outline-[#F6C945] ${
                    isFocused
                      ? 'ring-2 ring-[#F6C945] border-[#F6C945] shadow-2xl'
                      : isDimmed
                      ? 'opacity-35 grayscale brightness-75 border-[#1F1A17]/60'
                      : 'border-[#1F1A17]/85 hover:ring-2 hover:ring-[#C88A1E]'
                  }`}
                  aria-label={`Inspect ${isTop ? 'Top card' : `Card #${n - idx}`}: ${c.name} (Age ${c.age})`}
                >
                  {/* Card Header */}
                  <div
                    className="w-full px-2.5 py-1.5 flex items-center justify-between gap-1.5 shrink-0"
                    style={{ backgroundColor: theme.header, color: theme.text }}
                  >
                    <div className="flex items-center gap-1.5 min-w-0">
                      <ColorShapeMark color={c.color} size={12} />
                      <span className="font-display text-xs sm:text-sm font-bold truncate">
                        {c.name}
                      </span>
                    </div>
                    <span className="font-mono-num text-[11px] font-semibold px-1.5 py-0.5 rounded bg-black/30 shrink-0">
                      {c.age}
                    </span>
                  </div>

                  {/* L-Shaped Middle with Full Unclipped Prose */}
                  <div className="flex flex-1 min-h-0">
                    <div className="w-9 sm:w-10 shrink-0 flex flex-col items-center pt-2">
                      <IconGlyph slot={c.icons.tl} size={22} />
                    </div>
                    <div className="flex-1 min-w-0 bg-[#F5EFE2] rounded-bl-md border-l border-b border-[#1F1A17]/15 p-2 flex flex-col gap-1.5 overflow-y-auto">
                      {c.abilities.length > 0 ? (
                        c.abilities.map((ab) => {
                          const demandBody = ab.text.replace(/^I DEMAND\s*/i, '');
                          return (
                            <div
                              key={ab.index}
                              className={`rounded px-2 py-1.5 flex items-start gap-1.5 text-[10.5px] sm:text-[11.5px] leading-[1.3] ${
                                ab.isDemand
                                  ? 'bg-[#2B221D] text-[#F5EFE2]'
                                  : 'bg-[#E9DFC9] text-[#1F1A17] border border-[#1F1A17]/10'
                              }`}
                            >
                              <IconGlyph slot={ab.icon} size={13} className="shrink-0 mt-[1px]" />
                              <span className="min-w-0">
                                {ab.isDemand ? (
                                  <>
                                    <strong className="font-bold tracking-wide text-[#F6C945] mr-1">
                                      I DEMAND
                                    </strong>
                                    <span>{demandBody}</span>
                                  </>
                                ) : (
                                  <span>{ab.text}</span>
                                )}
                              </span>
                            </div>
                          );
                        })
                      ) : (
                        <span className="text-[11px] font-mono-num text-[#6E6053]">
                          {c.defId}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Bottom 3 Icons (BL, BC, BR) */}
                  <div className="flex items-center justify-between px-2.5 py-1.5 shrink-0">
                    <IconGlyph slot={c.icons.bl} size={22} />
                    <IconGlyph slot={c.icons.bc} size={22} />
                    <IconGlyph slot={c.icons.br} size={22} />
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Column 2 (Desktop): Fixed-width vertical list of truncated card buttons */}
        {!isMobile && (
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-[210px] shrink-0 flex flex-col gap-1.5 max-h-[420px] overflow-y-auto pr-0.5 cursor-default"
          >
            {reversedCards.map((c, revIdx) => {
              const isFocused = c.instanceId === focusedCardId;
              const prefix = revIdx === 0 ? 'Top' : `#${revIdx + 1}`;
              return (
                <button
                  key={c.instanceId}
                  type="button"
                  title={`${prefix}: ${c.name} [${c.age}]`}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (focusedCardId !== null) {
                      onClearFocus();
                    } else {
                      onSelectCard(c);
                    }
                  }}
                  className={`w-full min-h-[34px] rounded-md border px-2.5 py-1 text-left text-xs cursor-pointer transition-colors truncate ${
                    isFocused
                      ? 'border-[#F6C945] bg-[#3A2D19] text-[#F6C945] font-semibold'
                      : 'border-[#D9C7A3]/20 bg-[#1C1714] text-[#D9C7A3] hover:border-[#F6C945]/60'
                  }`}
                >
                  {prefix}: {c.name}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Mobile: Bottom equal-width compact index buttons (Top, #2, #3...) */}
      {isMobile && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="flex flex-wrap items-center justify-center gap-1.5 cursor-default"
        >
          {reversedCards.map((c, revIdx) => {
            const isFocused = c.instanceId === focusedCardId;
            const prefix = revIdx === 0 ? 'Top' : `#${revIdx + 1}`;
            return (
              <button
                key={c.instanceId}
                type="button"
                aria-label={`${prefix}: ${c.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  if (focusedCardId !== null) {
                    onClearFocus();
                  } else {
                    onSelectCard(c);
                  }
                }}
                className={`w-[54px] min-h-[32px] rounded-md border px-1.5 py-1 text-center font-mono-num text-xs cursor-pointer transition-colors ${
                  isFocused
                    ? 'border-[#F6C945] bg-[#3A2D19] text-[#F6C945] font-semibold'
                    : 'border-[#D9C7A3]/20 bg-[#1C1714] text-[#D9C7A3] hover:border-[#F6C945]/60'
                }`}
              >
                {prefix}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};

const STACK_SPLAY_TEXT: Record<ColorStack['splay'], string> = {
  none: 'Unsplayed',
  left: 'Splayed left',
  right: 'Splayed right',
  up: 'Splayed up',
  aslant: 'Splayed askew',
};

export const CardInspectorModal: React.FC<{
  card?: CardInstance | null;
  stack?: ColorStack | null;
  onClose: () => void;
}> = ({ card, stack, onClose }) => {
  const [focusedCardId, setFocusedCardId] = useState<string | null>(null);

  useEffect(() => {
    setFocusedCardId(null);
  }, [stack, card]);

  useEffect(() => {
    if (!card && !stack) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [card, stack, onClose]);

  if (!card && !stack) return null;

  const stackIcons = stack ? getStackVisibleIcons(stack) : null;
  const examinedCard =
    card ??
    (stack
      ? (focusedCardId
          ? stack.cards.find((c) => c.instanceId === focusedCardId)
          : stack.cards[stack.cards.length - 1]) ?? null
      : null);

  const isMultiStack = Boolean(stack && stack.cards.length >= 2);
  const nonZeroStackIcons = stackIcons
    ? (Object.keys(stackIcons) as FunctionalIcon[]).filter((ic) => stackIcons[ic] > 0)
    : [];

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center bg-black/70 p-0 sm:p-4 cursor-pointer"
      role="dialog"
      aria-modal="true"
      aria-label="Card Inspector"
      onClick={onClose}
    >
      <div
        className={`w-full ${
          isMultiStack ? 'sm:max-w-4xl' : 'sm:max-w-md'
        } max-h-[92vh] overflow-y-auto rounded-t-2xl sm:rounded-xl bg-[#27201B] border border-[#C88A1E] p-4 sm:p-5 text-[#F5EFE2] shadow-2xl space-y-3`}
      >
        <div className="text-center space-y-1">
          <div className="text-[11px] font-mono-num uppercase tracking-wider text-[#C8B9A6]">
            {stack
              ? `${STACK_SPLAY_TEXT[stack.splay]} · ${stack.cards.length} card${
                  stack.cards.length === 1 ? '' : 's'
                }${examinedCard ? ` · ${examinedCard.defId}` : ''}`
              : card
              ? `Age ${card.age} · ${COLOR_LABELS[card.color]} · ${card.defId}`
              : ''}
          </div>
          <h2 className="font-display text-lg font-bold text-[#F6C945] capitalize flex items-center justify-center gap-1.5">
            {stack && <ColorShapeMark color={stack.color} size={15} />}
            <span>{stack ? `${stack.color} Stack` : card?.name}</span>
          </h2>
          {nonZeroStackIcons.length > 0 && stackIcons && (
            <div className="flex flex-wrap items-center justify-center gap-x-2.5 gap-y-1 pt-0.5 text-[11px] text-[#D9C7A3]">
              {nonZeroStackIcons.map((ic) => (
                <span key={ic} className="inline-flex items-center gap-1 font-mono-num">
                  <IconGlyph slot={ic} size={14} />
                  <strong className="text-[#F6C945]">{stackIcons[ic]}</strong>
                </span>
              ))}
            </div>
          )}
        </div>

        {stack && stack.cards.length >= 2 && (
          <SplayedPileVisual
            stack={stack}
            focusedCardId={focusedCardId}
            onSelectCard={(clicked) => setFocusedCardId(clicked.instanceId)}
            onClearFocus={() => setFocusedCardId(null)}
          />
        )}

        {stack && stack.cards.length === 1 && (
          <div className="flex justify-center">
            <div onClick={(e) => e.stopPropagation()} className="cursor-default">
              <CardTile card={stack.cards[0]} />
            </div>
          </div>
        )}

        {card && (
          <div className="flex justify-center">
            <div onClick={(e) => e.stopPropagation()} className="cursor-default">
              <CardTile card={card} />
            </div>
          </div>
        )}

        <p className="text-center text-[11px] text-[#9E8F7E]">
          {isMultiStack
            ? focusedCardId
              ? 'Click card or stack button to return · click outside to close'
              : 'Click any covered card to bring forward · click outside to close'
            : 'Click anywhere outside card to close'}
        </p>
      </div>
    </div>
  );
};

export const RulesModal: React.FC<{ onClose: () => void }> = ({ onClose }) => (
  <div
    className="fixed inset-0 z-50 flex items-stretch sm:items-center justify-center bg-black/75 p-0 sm:p-4"
    role="dialog"
    aria-modal="true"
    aria-label="Rules"
    onClick={(e) => {
      if (e.target === e.currentTarget) onClose();
    }}
  >
    <div className="w-full sm:max-w-4xl h-[100dvh] max-h-[100dvh] sm:h-auto sm:max-h-[88vh] flex flex-col rounded-none sm:rounded-xl bg-[#27201B] border border-[#D9C7A3]/25 text-[#F5EFE2] shadow-2xl overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-safe pt-safe pb-2.5 border-b border-[#D9C7A3]/15 shrink-0">
        <div className="flex items-center gap-2.5 min-w-0">
          <button
            type="button"
            onClick={onClose}
            aria-label="Back from Rules"
            className="inline-flex items-center gap-1.5 min-h-[34px] px-2.5 rounded-lg border border-[#D9C7A3]/20 text-xs font-medium text-[#D9C7A3] hover:text-[#F5EFE2] hover:bg-[#F5EFE2]/10 cursor-pointer shrink-0"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>Back</span>
          </button>
          <span className="h-4 w-px bg-[#C88A1E]/40 shrink-0" aria-hidden="true" />
          <h2 className="font-display text-base sm:text-xl font-bold leading-tight truncate">
            Rules
          </h2>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-4 text-sm text-[#E5DAC5] leading-relaxed">
        <p>
          During Innovation, 4th edition, you play the progress of human society through 11 ages,
          hoping to defeat your opponents. Cards represent the various innovations of your society.
        </p>

        <section>
          <h3 className="font-display font-bold text-[#F6C945]">Goal of the game</h3>
          <p className="mt-1">
            Win by: <strong>6 achievements</strong> (<strong>5</strong> in 3p), or highest score
            when attempting to draw a card above age 11, a card win effect, or elimination of
            opponents.
          </p>
        </section>

        <section>
          <h3 className="font-display font-bold text-[#F6C945]">Turn Structure</h3>
          <p className="mt-1">
            Each turn, a player chooses <strong>2</strong> of the following actions (1&times; on the
            first turn, or first 2 turns on 2v2); repeats are permitted:
          </p>
          <ul className="mt-1.5 list-disc pl-5 space-y-1.5">
            <li>
              <strong>DRAW</strong> &ndash; Draw a card from the deck matching the highest top card
              on your tableau. If the deck is empty, draw from the deck one higher.
            </li>
            <li>
              <strong>MELD</strong> &ndash; Place a card on the matching colour pile, continuing any
              splay.
            </li>
            <li>
              <strong>DOGMA</strong> &ndash; Activate a top card:
              <ul className="mt-1 list-disc pl-5 space-y-1 text-[13px] text-[#D9C7A3]">
                <li>
                  <strong>Standard actions:</strong> Opponents with equal or more featured icons
                  perform the action first (Sharing). If opponents share the action, even if unwanted
                  or negative, the player performs a free draw action.
                </li>
                <li>
                  <strong>I DEMAND actions:</strong> Opponents with fewer featured icons are
                  vulnerable and perform the action in turn order.
                </li>
              </ul>
            </li>
            <li>
              <strong>ACHIEVE</strong> &ndash; Claim an available Standard Achievement.
              Requirements: top card of &ge; age, score &ge; 5 &times; age of achievement. Points
              are not spent.
            </li>
          </ul>
        </section>

        <section>
          <h3 className="font-display font-bold text-[#F6C945]">Key words</h3>
          <ul className="mt-1 list-disc pl-5 space-y-1">
            <li>
              <strong>Splay</strong> &ndash; Must have 2+ cards in a colour to splay. Covered cards
              expose additional icons depending on the direction they are splayed. Options: Left,
              Right, Up, Aslant. If &le; 1 card, reset to unsplayed.
            </li>
            <li>
              <strong>Return</strong> &ndash; Cards are returned under the appropriate deck. Player
              may choose the order.
            </li>
            <li>
              <strong>Junk</strong> &ndash; Cards are set aside and out of the game, unless
              specified by an action.
            </li>
            <li>
              <strong>Tuck</strong> &ndash; Move card under the appropriate stack.
            </li>
            <li>
              <strong>Self-execute</strong> &ndash; When self-executing a card, execute all
              non-demand effects, ignoring sharing.
            </li>
          </ul>
        </section>

        <section>
          <h3 className="font-display font-bold text-[#F6C945]">Other rules</h3>
          <ul className="mt-1 list-disc pl-5 space-y-1">
            <li>
              If you ever need to draw from a deck and it is empty, draw from the deck one higher.
            </li>
            <li>
              Sharing and vulnerability to Dogmas is only determined at the start of the Dogma
              action.
            </li>
            <li>All Dogma effects are mandatory unless they have the word &ldquo;May&rdquo;.</li>
            <li>
              Clarifying &ldquo;You&rdquo; in Dogma effects: Dogma effects are read from the active
              player; shared effects are read by the other players.
            </li>
            <li>
              <strong>Chain rule</strong> &ndash; When self-executing a card&apos;s effect, if you
              would self-execute another card, draw and achieve an 11; this is the Chain
              Achievement. There is no limit to the number of Chain Achievements that may be
              achieved.
            </li>
          </ul>
        </section>

        <section>
          <h3 className="font-display font-bold text-[#F6C945]">Special Achievements</h3>
          <p className="mt-1">
            Won as soon as the player is eligible, and count towards achievements along with standard
            achievements. Dogma effects may also claim them.
          </p>
          <ul className="mt-1.5 list-disc pl-5 space-y-1">
            {Object.values(SPECIAL_ACHIEVEMENTS).map((sa) => (
              <li key={sa.id}>
                <strong>{sa.name}</strong>: {sa.description}
              </li>
            ))}
          </ul>
        </section>

        <section>
          <h3 className="font-display font-bold text-[#F6C945]">2v2 Team Rules</h3>
          <p className="mt-1">
            Teammates sit across from each other and share a combined 6-achievement victory target.
            Teammates share non-demand Dogma effects (granting free draws) and are immune to
            Demands, while hands and score piles remain hidden.
          </p>
        </section>
      </div>
    </div>
  </div>
);

export const SaveLoadModal: React.FC<{
  currentState: GameState | null;
  onLoadState: (state: GameState) => void;
  onClose: () => void;
}> = ({ currentState, onLoadState, onClose }) => {
  const [slots, setSlots] = useState<SaveSlotRecord[]>(() => listSaveSlots());
  const [autoSave, setAutoSave] = useState<GameState | null>(() => loadAutoMatch());
  const [slotName, setSlotName] = useState('');
  const [importText, setImportText] = useState('');
  const [feedback, setFeedback] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const storageAvailable = useMemo(() => isLocalStorageAvailable(), []);

  const handleSaveSlot = () => {
    if (!currentState) return;
    if (!storageAvailable) {
      setFeedback('localStorage is restricted in this browser context. Use Download .json Save below.');
      return;
    }
    saveNamedSlot(currentState, slotName);
    setSlots(listSaveSlots());
    setSlotName('');
    setFeedback('Saved current match to localStorage slot.');
  };

  const handleDeleteSlot = (id: string) => {
    setSlots(deleteSaveSlot(id));
  };

  const handleLoadSlot = (record: SaveSlotRecord) => {
    try {
      const loaded = deserializeGameState(record.stateJson);
      onLoadState(loaded);
      onClose();
    } catch {
      setFeedback('Could not load save slot.');
    }
  };

  const handleCopyExport = async () => {
    if (!currentState || typeof navigator === 'undefined' || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(serializeGameState(currentState));
      setFeedback('Copied match JSON to clipboard.');
    } catch {
      setFeedback('Clipboard unavailable in this browser context.');
    }
  };

  const handleDownloadJson = () => {
    if (!currentState) return;
    const stamp = new Date().toISOString().slice(0, 10);
    const fileName = `innovation-save-turn-${currentState.turnNumber}-${stamp}.json`;
    downloadTextFile(fileName, serializeGameState(currentState));
    setFeedback(`Downloaded ${fileName}.`);
  };

  const handleFileImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = typeof reader.result === 'string' ? reader.result : '';
        const parsed = deserializeGameState(text);
        onLoadState(parsed);
        onClose();
      } catch {
        setFeedback('Invalid save state JSON file.');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleImport = () => {
    try {
      const parsed = deserializeGameState(importText);
      onLoadState(parsed);
      onClose();
    } catch {
      setFeedback('Invalid save state JSON.');
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch sm:items-center justify-center bg-black/75 p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Save and Load Matches"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full sm:max-w-4xl h-[100dvh] max-h-[100dvh] sm:h-auto sm:max-h-[88vh] flex flex-col rounded-none sm:rounded-xl bg-[#27201B] border border-[#D9C7A3]/25 text-[#F5EFE2] shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between gap-2 px-safe pt-safe pb-2.5 border-b border-[#D9C7A3]/15 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <button
              type="button"
              onClick={onClose}
              aria-label="Back from Save Menu"
              className="inline-flex items-center gap-1.5 min-h-[34px] px-2.5 rounded-lg border border-[#D9C7A3]/20 text-xs font-medium text-[#D9C7A3] hover:text-[#F5EFE2] hover:bg-[#F5EFE2]/10 cursor-pointer shrink-0"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>Back</span>
            </button>
            <span className="h-4 w-px bg-[#C88A1E]/40 shrink-0" aria-hidden="true" />
            <h2 className="font-display text-base sm:text-xl font-bold truncate">
              Save &amp; Resume
            </h2>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-4 sm:p-5">

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-[#1C1714] border border-[#C88A1E]/30 px-3.5 py-3">
          <div className="min-w-0">
            <div className="text-xs font-semibold text-[#F6C945]">Shareable Offline Game</div>
            <div className="text-[11px] text-[#C8B9A6] mt-0.5">
              Download a single self-contained .html file that runs anywhere offline.
            </div>
          </div>
          <OfflineExportButton compact />
        </div>

        {!storageAvailable && (
          <p className="mt-3 rounded-lg border border-[#E26D5C]/40 bg-[#8E2920]/25 px-3 py-2 text-xs text-[#F5EFE2]">
            Browser localStorage is blocked for this local file context. You can still save and restore matches using .json save files below.
          </p>
        )}

        {feedback && (
          <p className="mt-3 text-xs text-[#F6C945]" role="status">
            {feedback}
          </p>
        )}

        {currentState && (
          <div className="mt-4 space-y-2.5 pb-4 border-b border-[#D9C7A3]/15">
            <label htmlFor="save-slot-name" className="block text-xs font-medium text-[#D9C7A3]">
              Save Current Match (localStorage)
            </label>
            <div className="flex gap-2">
              <input
                id="save-slot-name"
                type="text"
                value={slotName}
                onChange={(e) => setSlotName(e.target.value)}
                placeholder={`Turn ${currentState.turnNumber} (${currentState.variant})`}
                className="flex-1 min-h-[44px] rounded-lg bg-[#1C1714] border border-[#D9C7A3]/25 px-3 text-sm text-[#F5EFE2] placeholder:text-[#7D7061]"
              />
              <button
                type="button"
                onClick={handleSaveSlot}
                className="min-h-[44px] px-4 rounded-lg bg-[#C88A1E] text-[#1C1714] text-sm font-semibold hover:bg-[#d89928] cursor-pointer whitespace-nowrap"
              >
                Save Slot
              </button>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={handleDownloadJson}
                className="inline-flex items-center gap-1.5 min-h-[38px] px-3 rounded-lg border border-[#D9C7A3]/25 text-xs font-medium text-[#F5EFE2] hover:bg-[#F5EFE2]/10 cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Download .json Save</span>
              </button>
              <button
                type="button"
                onClick={handleCopyExport}
                className="min-h-[38px] text-xs text-[#D9C7A3] underline hover:text-[#F5EFE2] cursor-pointer"
              >
                Copy Match JSON to Clipboard
              </button>
            </div>
          </div>
        )}

        {autoSave && autoSave.phase !== 'gameover' && (
          <div className="mt-4 space-y-2 pb-4 border-b border-[#D9C7A3]/15">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-[#F6C945]">
              Last Saved / Active Match
            </h3>
            <div className="flex items-center justify-between gap-2 rounded-lg bg-[#1C1714] border border-[#C88A1E]/40 px-3 py-2">
              <div className="min-w-0">
                <div className="text-sm font-medium truncate">
                  {autoSave.players.map((p) => p.name).join(' vs ')}
                </div>
                <div className="text-[11px] text-[#9E8F7E]">
                  {autoSave.variant} · Turn {autoSave.turnNumber}
                </div>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={() => {
                    onLoadState(autoSave);
                    onClose();
                  }}
                  className="min-h-[38px] px-3 rounded bg-[#C88A1E] text-[#1C1714] text-xs font-semibold hover:bg-[#d89928] cursor-pointer"
                >
                  Resume
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const stamp = new Date().toISOString().slice(0, 10);
                    const fileName = `innovation-save-turn-${autoSave.turnNumber}-${stamp}.json`;
                    downloadTextFile(fileName, serializeGameState(autoSave));
                    setFeedback(`Downloaded ${fileName}.`);
                  }}
                  aria-label="Download last saved match JSON"
                  title="Download .json Save"
                  className="min-h-[38px] px-2.5 rounded border border-[#D9C7A3]/20 text-xs text-[#D9C7A3] hover:bg-[#F5EFE2]/10 cursor-pointer"
                >
                  <Download className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    clearAutoMatch();
                    setAutoSave(null);
                  }}
                  aria-label="Delete last saved match"
                  className="min-h-[38px] px-2.5 rounded border border-[#D9C7A3]/20 text-xs text-[#D9C7A3] hover:bg-[#F5EFE2]/10 cursor-pointer"
                >
                  Delete
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="mt-4 space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-[#C8B9A6]">
            Saved Slots (localStorage)
          </h3>
          {slots.length === 0 ? (
            <p className="text-xs text-[#8D7F70]">No manual save slots yet.</p>
          ) : (
            <div className="space-y-2">
              {slots.map((slot) => (
                <div
                  key={slot.id}
                  className="flex items-center justify-between gap-2 rounded-lg bg-[#1C1714] border border-[#D9C7A3]/15 px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">{slot.label}</div>
                    <div className="text-[11px] text-[#9E8F7E]">
                      {slot.variant} · Turn {slot.turnNumber}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => handleLoadSlot(slot)}
                      className="min-h-[38px] px-3 rounded bg-[#C88A1E] text-[#1C1714] text-xs font-semibold hover:bg-[#d89928] cursor-pointer"
                    >
                      Load
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDeleteSlot(slot.id)}
                      aria-label={`Delete save ${slot.label}`}
                      className="min-h-[38px] px-2.5 rounded border border-[#D9C7A3]/20 text-xs text-[#D9C7A3] hover:bg-[#F5EFE2]/10 cursor-pointer"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="mt-4 pt-4 border-t border-[#D9C7A3]/15 space-y-2.5">
          <div className="flex items-center justify-between gap-2">
            <label htmlFor="import-save-json" className="block text-xs font-medium text-[#D9C7A3]">
              Import Save State JSON
            </label>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,application/json"
              onChange={handleFileImport}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex items-center gap-1.5 min-h-[36px] px-2.5 rounded-lg border border-[#D9C7A3]/25 text-xs font-medium text-[#F5EFE2] hover:bg-[#F5EFE2]/10 cursor-pointer"
            >
              <Upload className="w-3.5 h-3.5" />
              <span>Load .json File</span>
            </button>
          </div>
          <textarea
            id="import-save-json"
            rows={2}
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            placeholder="Paste exported save JSON..."
            className="w-full rounded-lg bg-[#1C1714] border border-[#D9C7A3]/25 p-2.5 text-xs font-mono-num text-[#F5EFE2] placeholder:text-[#7D7061]"
          />
          <button
            type="button"
            onClick={handleImport}
            disabled={!importText.trim()}
            className="min-h-[44px] w-full rounded-lg border border-[#D9C7A3]/30 text-sm font-medium text-[#F5EFE2] hover:bg-[#F5EFE2]/10 disabled:opacity-40 cursor-pointer"
          >
            Load Imported JSON
          </button>
        </div>
        </div>
      </div>
    </div>
  );
};

export const CardBrowserModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const [selectedAge, setSelectedAge] = useState<'all' | Age>('all');
  const [selectedColor, setSelectedColor] = useState<'all' | CardColor>('all');
  const [search, setSearch] = useState('');
  const [inspectedCard, setInspectedCard] = useState<CardInstance | null>(null);

  const cardInstances = useMemo(
    () => BASE_CARD_DATABASE.map((def) => instantiateCard(def)),
    []
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return cardInstances.filter((c) => {
      if (selectedAge !== 'all' && c.age !== selectedAge) return false;
      if (selectedColor !== 'all' && c.color !== selectedColor) return false;
      if (!q) return true;
      return (
        c.name.toLowerCase().includes(q) ||
        c.defId.toLowerCase().includes(q) ||
        c.abilities.some((ab) => ab.text.toLowerCase().includes(q))
      );
    });
  }, [cardInstances, selectedAge, selectedColor, search]);

  return (
    <>
      <div
        className="fixed inset-0 z-50 flex items-stretch sm:items-center justify-center bg-black/80 p-0 sm:p-4"
        role="dialog"
        aria-modal="true"
        aria-label="Card Database"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div className="w-full sm:max-w-4xl h-[100dvh] max-h-[100dvh] sm:h-[86vh] flex flex-col rounded-none sm:rounded-xl bg-[#27201B] border border-[#D9C7A3]/25 text-[#F5EFE2] shadow-2xl overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between gap-2 px-safe pt-safe pb-2 border-b border-[#D9C7A3]/15 shrink-0">
            <div className="flex items-center gap-2.5 min-w-0">
              <button
                type="button"
                onClick={onClose}
                aria-label="Back from Card Database"
                className="inline-flex items-center gap-1.5 min-h-[34px] px-2.5 rounded-lg border border-[#D9C7A3]/20 text-xs font-medium text-[#D9C7A3] hover:text-[#F5EFE2] hover:bg-[#F5EFE2]/10 cursor-pointer shrink-0"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                <span>Back</span>
              </button>
              <span className="h-4 w-px bg-[#C88A1E]/40 shrink-0" aria-hidden="true" />
              <h2 className="font-display text-base sm:text-xl font-bold leading-tight truncate">
                Card Database
              </h2>
            </div>
            <span className="text-[11px] sm:text-xs text-[#C8B9A6] font-mono-num shrink-0">
              {filtered.length}/{cardInstances.length}
            </span>
          </div>

          {/* Filter Bar */}
          <div className="px-3 sm:px-5 py-2 sm:py-2.5 border-b border-[#D9C7A3]/15 space-y-1.5 sm:space-y-2 bg-[#1C1714]/65 shrink-0">
            <div className="relative">
              <Search className="w-4 h-4 text-[#A99B89] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search card name, ID (e.g. B016), or ability text..."
                aria-label="Search cards"
                className="w-full min-h-[34px] sm:min-h-[38px] rounded-lg bg-[#1C1714] border border-[#D9C7A3]/25 pl-9 pr-3 text-xs sm:text-sm text-[#F5EFE2] placeholder:text-[#7D7061]"
              />
            </div>

            <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar">
              <span className="text-xs font-semibold text-[#C8B9A6] shrink-0 mr-1">Ages:</span>
              <button
                type="button"
                onClick={() => setSelectedAge('all')}
                className={`min-h-[32px] px-2.5 rounded-md text-xs font-semibold border cursor-pointer shrink-0 ${
                  selectedAge === 'all'
                    ? 'bg-[#C88A1E] text-[#1C1714] border-[#C88A1E]'
                    : 'bg-[#1C1714] text-[#D9C7A3] border-[#D9C7A3]/20 hover:border-[#F6C945]/50'
                }`}
              >
                All
              </button>
              {AVAILABLE_DATABASE_AGES.map((age) => (
                <button
                  key={age}
                  type="button"
                  onClick={() => setSelectedAge(age)}
                  className={`min-h-[32px] min-w-[32px] px-2 rounded-md text-xs font-mono-num font-semibold border cursor-pointer shrink-0 ${
                    selectedAge === age
                      ? 'bg-[#C88A1E] text-[#1C1714] border-[#C88A1E]'
                      : 'bg-[#1C1714] text-[#D9C7A3] border-[#D9C7A3]/20 hover:border-[#F6C945]/50'
                  }`}
                >
                  {age}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-1 sm:gap-1.5 overflow-x-auto no-scrollbar">
              <button
                type="button"
                onClick={() => setSelectedColor('all')}
                className={`min-h-[30px] px-2 sm:px-2.5 rounded-md text-xs font-medium border cursor-pointer shrink-0 ${
                  selectedColor === 'all'
                    ? 'bg-[#F5EFE2] text-[#1C1714] border-[#F5EFE2]'
                    : 'bg-[#1C1714] text-[#D9C7A3] border-[#D9C7A3]/20'
                }`}
              >
                <span className="sm:hidden">All</span>
                <span className="hidden sm:inline">All Colors</span>
              </button>
              {ALL_COLORS.map((color) => {
                const shortColor: Record<CardColor, string> = {
                  red: 'R',
                  yellow: 'Y',
                  green: 'G',
                  blue: 'B',
                  purple: 'P',
                };
                return (
                  <button
                    key={color}
                    type="button"
                    onClick={() => setSelectedColor(color)}
                    className={`min-h-[30px] px-2 sm:px-2.5 rounded-md text-xs font-medium border inline-flex items-center gap-1 sm:gap-1.5 cursor-pointer shrink-0 ${
                      selectedColor === color
                        ? 'bg-[#F5EFE2] text-[#1C1714] border-[#F5EFE2]'
                        : 'bg-[#1C1714] text-[#D9C7A3] border-[#D9C7A3]/20 hover:border-[#F6C945]/50'
                    }`}
                  >
                    <ColorShapeMark color={color} size={11} />
                    <span className="sm:hidden">{shortColor[color]}</span>
                    <span className="hidden sm:inline">{COLOR_LABELS[color]}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Cards Grid */}
          <div className="flex-1 overflow-y-auto p-5">
            {filtered.length === 0 ? (
              <div className="py-12 text-center text-sm text-[#A99B89]">
                No cards match the current filter.
              </div>
            ) : (
              <div className="flex flex-wrap justify-center sm:justify-start gap-3">
                {filtered.map((card) => (
                  <CardTile
                    key={card.instanceId}
                    card={card}
                    compact
                    colorBlindMode
                    onClick={() => setInspectedCard(card)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {inspectedCard && (
        <CardInspectorModal card={inspectedCard} onClose={() => setInspectedCard(null)} />
      )}
    </>
  );
};

export const AchieveModal: React.FC<{
  open: boolean;
  scoreTotal: number;
  highestTopAge: number;
  standardAchievementBacks: CardBack[];
  onClaim: (age: Age) => void;
  onClose: () => void;
}> = ({
  open,
  scoreTotal,
  highestTopAge,
  standardAchievementBacks,
  onClaim,
  onClose,
}) => {
  if (!open) return null;

  const sortedBacks = [...standardAchievementBacks].sort((a, b) => a.age - b.age);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/75 p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Claim Standard Achievement"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full sm:max-w-lg max-h-[88vh] flex flex-col rounded-t-2xl sm:rounded-xl bg-[#27201B] border border-[#C88A1E] text-[#F5EFE2] shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between gap-2 px-safe pt-safe pb-2.5 border-b border-[#D9C7A3]/15 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <button
              type="button"
              onClick={onClose}
              aria-label="Back to Board"
              className="inline-flex items-center gap-1.5 min-h-[34px] px-2.5 rounded-lg border border-[#D9C7A3]/20 text-xs font-medium text-[#D9C7A3] hover:text-[#F5EFE2] hover:bg-[#F5EFE2]/10 cursor-pointer shrink-0"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>Back</span>
            </button>
            <span className="h-4 w-px bg-[#C88A1E]/40 shrink-0" aria-hidden="true" />
            <h2 className="font-display text-base sm:text-lg font-bold text-[#F6C945] flex items-center gap-1.5 truncate">
              <Award className="w-4 h-4 shrink-0" />
              <span className="truncate">Achievements</span>
            </h2>
          </div>
          <p className="text-[11px] text-[#C8B9A6] font-mono-num shrink-0">
            Score <strong className="text-[#F6C945]">{scoreTotal}</strong> · Top{' '}
            <strong className="text-[#F6C945]">[{highestTopAge}]</strong>
          </p>
        </div>

        <div className="flex-1 overflow-y-auto p-3.5 sm:p-4 space-y-2">
          {sortedBacks.length === 0 ? (
            <p className="text-sm text-[#A99B89] py-6 text-center">
              No standard achievements remain available.
            </p>
          ) : (
            sortedBacks.map((back) => {
              const requiredScore = back.age * 5;
              const hasPoints = scoreTotal >= requiredScore;
              const hasTopCard = highestTopAge >= back.age;
              const eligible = hasPoints && hasTopCard;

              const rowContent = (
                <>
                  <div className="min-w-0 space-y-1 text-left">
                    <div className="font-display text-sm font-bold text-[#F5EFE2] truncate">
                      Age {back.age}: {AGE_NAMES[back.age]}
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 font-mono-num text-[11px]">
                      <span
                        className={`rounded border px-1.5 py-0.5 leading-none ${
                          hasPoints
                            ? 'border-[#E5B842]/45 bg-[#1C1714] text-[#F6C945]'
                            : 'border-[#D9C7A3]/18 bg-[#1C1714]/70 text-[#9E8F7E]'
                        }`}
                      >
                        [{requiredScore} points]
                      </span>
                      <span
                        className={`rounded border px-1.5 py-0.5 leading-none ${
                          hasTopCard
                            ? 'border-[#E5B842]/45 bg-[#1C1714] text-[#F6C945]'
                            : 'border-[#D9C7A3]/18 bg-[#1C1714]/70 text-[#9E8F7E]'
                        }`}
                      >
                        [Age {back.age}]
                      </span>
                    </div>
                  </div>
                  {eligible && (
                    <span className="min-h-[34px] px-3.5 rounded-lg bg-[#C88A1E] text-[#1C1714] text-xs font-bold inline-flex items-center justify-center shrink-0">
                      Claim
                    </span>
                  )}
                </>
              );

              if (eligible) {
                return (
                  <button
                    key={back.instanceId}
                    type="button"
                    onClick={() => onClaim(back.age)}
                    className="w-full rounded-lg border border-[#E5B842]/55 bg-[#2A2117] hover:border-[#F6C945] hover:bg-[#35291B] px-3.5 py-2.5 flex items-center justify-between gap-3 transition-colors cursor-pointer"
                  >
                    {rowContent}
                  </button>
                );
              }

              return (
                <div
                  key={back.instanceId}
                  className="rounded-lg border border-[#D9C7A3]/15 bg-[#1C1714]/60 px-3.5 py-2.5 flex items-center justify-between gap-3 opacity-50"
                >
                  {rowContent}
                </div>
              );
            })
          )}
        </div>

        <div className="px-4 py-2.5 border-t border-[#D9C7A3]/15 bg-[#1C1714]/70 flex items-center justify-end shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="min-h-[36px] px-4 rounded-lg border border-[#D9C7A3]/25 text-xs font-medium text-[#E5DAC5] hover:bg-[#F5EFE2]/10 cursor-pointer shrink-0"
          >
            Back
          </button>
        </div>
      </div>
    </div>
  );
};

export const AboutModal: React.FC<{
  onClose: () => void;
  onOpenBenchmark?: () => void;
  onWeightsChanged?: () => void;
  initialSubView?: 'main' | 'changelog' | 'ai';
}> = ({ onClose, onOpenBenchmark, onWeightsChanged, initialSubView = 'main' }) => {
  const [subView, setSubView] = useState<'main' | 'changelog' | 'ai'>(initialSubView);
  const [tdMeta, setTdMeta] = useState<TDVariantMetadata[]>(() => getTDWeightMetadata());
  const [tdStatus, setTdStatus] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const weightFileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setSubView(initialSubView);
  }, [initialSubView]);

  const handleWeightFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    if (files.length === 0) return;
    try {
      const updated = new Set<string>();
      for (const file of files) {
        const text = await file.text();
        const res = importTDWeightBundleJson(text);
        if (!res.ok) {
          setTdStatus({
            kind: 'err',
            text: `${file.name}: ${res.error ?? 'Failed to import weights.'}`,
          });
          setTdMeta(getTDWeightMetadata());
          return;
        }
        for (const v of res.updatedVariants ?? []) updated.add(v);
      }
      setTdMeta(getTDWeightMetadata());
      onWeightsChanged?.();
      setTdStatus({
        kind: 'ok',
        text: `Imported custom TD weights for ${Array.from(updated).join(', ')}.`,
      });
    } catch {
      setTdStatus({ kind: 'err', text: 'Could not read selected file(s).' });
    }
  };

  const modalTitle =
    subView === 'ai' ? 'AI' : subView === 'changelog' ? 'Changelog' : 'About';

  const handleHeaderBack = () => {
    if (subView !== 'main') {
      setSubView('main');
    } else {
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch sm:items-center justify-center bg-black/75 p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label={modalTitle}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full sm:max-w-4xl h-[100dvh] max-h-[100dvh] sm:h-auto sm:max-h-[88vh] flex flex-col rounded-none sm:rounded-xl bg-[#27201B] border border-[#D9C7A3]/25 text-[#F5EFE2] shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between gap-2 px-safe pt-safe pb-2.5 sm:px-5 sm:py-3 border-b border-[#D9C7A3]/15 shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <button
              type="button"
              onClick={handleHeaderBack}
              aria-label={subView !== 'main' ? 'Back to About' : 'Back from About'}
              className="inline-flex items-center gap-1.5 min-h-[34px] px-2.5 rounded-lg border border-[#D9C7A3]/20 text-xs font-medium text-[#D9C7A3] hover:text-[#F5EFE2] hover:bg-[#F5EFE2]/10 cursor-pointer shrink-0"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>Back</span>
            </button>
            <span className="h-4 w-px bg-[#C88A1E]/40 shrink-0" aria-hidden="true" />
            <h2 className="font-display text-base sm:text-xl font-bold truncate">
              {modalTitle}
            </h2>
          </div>
          {subView === 'changelog' && (
            <span className="font-mono-num text-xs text-[#9E8F7E] shrink-0">v1.7</span>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {subView === 'main' && (
            <>
              <div className="space-y-2.5 text-sm text-[#E5DAC5] leading-relaxed">
                <p className="font-semibold text-[#F5EFE2]">CitrusSquid</p>
                <p>Based on Innovation, 4th edition by Carl Chudyk.</p>
                <p className="text-xs sm:text-sm text-[#D9C7A3] leading-relaxed">
                  This is an unofficial, non-commercial fan project created with permission from
                  Asmadi Games. It is not affiliated with, endorsed, or supported by Asmadi Games
                  or designer Carl Chudyk. Innovation is a trademark of Asmadi Games. All game
                  rules, card names, and concepts belong to their respective owners.
                </p>
              </div>

              <div className="pt-3 border-t border-[#D9C7A3]/15 space-y-3">
                <div className="grid grid-cols-2 gap-2.5">
                  <button
                    type="button"
                    onClick={() => setSubView('changelog')}
                    className="min-h-[44px] px-4 rounded-lg border border-[#D9C7A3]/25 bg-[#1C1714] text-sm font-semibold text-[#F6C945] hover:border-[#F6C945] hover:bg-[#F5EFE2]/5 cursor-pointer transition-colors"
                  >
                    Changelog
                  </button>
                  <button
                    type="button"
                    onClick={() => setSubView('ai')}
                    className="min-h-[44px] px-4 rounded-lg border border-[#D9C7A3]/25 bg-[#1C1714] text-sm font-semibold text-[#F6C945] hover:border-[#F6C945] hover:bg-[#F5EFE2]/5 cursor-pointer transition-colors"
                  >
                    AI
                  </button>
                </div>
                <div className="text-right">
                  <span className="font-mono-num text-[11px] text-[#9E8F7E]">v1.7</span>
                </div>
              </div>
            </>
          )}

          {subView === 'ai' && (
            <>
              {/* TD AI Methodology & Benchmark */}
              <section className="rounded-lg border border-[#D9C7A3]/18 bg-[#1C1714] p-3.5 space-y-2.5">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-[#F6C945]">
                  TD AI Methodology
                </h3>
                <p className="text-xs text-[#E5DAC5] leading-relaxed">
                  The neural TD(λ) AI uses a 2-layer funnel network over fair-play card and board
                  state features. Weights were warm-started on 2,000 Heuristic games with value
                  distillation, then trained across 15,000 self-play games per mode (λ = 0.7) with
                  200 paired evaluation games.
                </p>
                {onOpenBenchmark && (
                  <button
                    type="button"
                    onClick={onOpenBenchmark}
                    className="w-full min-h-[42px] rounded-lg bg-[#C88A1E] text-[#1C1714] text-xs sm:text-sm font-bold hover:bg-[#d89928] inline-flex items-center justify-center gap-2 cursor-pointer transition-colors"
                  >
                    <Activity className="w-4 h-4" />
                    <span>AI Arena</span>
                  </button>
                )}
              </section>

              {/* TD AI Weights */}
              <section className="space-y-2">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-[#F6C945] flex items-center gap-1.5">
                  <Cpu className="w-3.5 h-3.5" />
                  <span>TD AI Weights</span>
                </h3>

                <div className="rounded-lg border border-[#D9C7A3]/18 bg-[#1C1714] p-3 space-y-2.5">
                  <div className="space-y-1.5">
                    {tdMeta.map((item) => {
                      const label =
                        item.variant === '1v1'
                          ? '1 v 1'
                          : item.variant === '1v1v1'
                          ? '3p FFA'
                          : '2 v 2';
                      const sourceLabel =
                        item.source === 'custom'
                          ? 'Custom Imported'
                          : item.source === 'bundled'
                          ? 'Bundled Trained'
                          : 'Not Loaded';
                      return (
                        <div
                          key={item.variant}
                          className="flex items-center justify-between gap-2 rounded-md border border-[#D9C7A3]/12 bg-[#27201B]/80 px-2.5 py-2 text-xs"
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-semibold text-[#F5EFE2]">{label}</span>
                              <span
                                className={`font-mono-num text-[10px] font-semibold ${
                                  item.source === 'custom'
                                    ? 'text-[#8FD19E]'
                                    : item.source === 'bundled'
                                    ? 'text-[#F6C945]'
                                    : 'text-[#9E8F7E]'
                                }`}
                              >
                                {sourceLabel}
                              </span>
                            </div>
                            <div className="font-mono-num text-[10.5px] text-[#B8A996]">
                              {item.layerSizes.join('→')} ({item.activation}) · {item.warmstartGames}w
                              + {item.trainedGames} TD
                              {item.benchmarkWinRate !== undefined
                                ? ` · ${(item.benchmarkWinRate * 100).toFixed(0)}% vs Heuristic`
                                : ''}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  <input
                    ref={weightFileInputRef}
                    type="file"
                    accept=".json,application/json"
                    multiple
                    onChange={handleWeightFileChange}
                    className="hidden"
                    aria-label="Upload TD weights JSON file(s)"
                  />

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => weightFileInputRef.current?.click()}
                      className="min-h-[40px] rounded-lg border border-[#C88A1E]/60 bg-[#3A2D19]/75 px-3 text-xs font-semibold text-[#F6C945] hover:bg-[#4d3b21] inline-flex items-center justify-center gap-1.5 cursor-pointer whitespace-nowrap"
                    >
                      <Upload className="w-3.5 h-3.5" />
                      <span>Import Weights JSON</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        resetTDWeights();
                        setTdMeta(getTDWeightMetadata());
                        onWeightsChanged?.();
                        setTdStatus({
                          kind: 'ok',
                          text: 'Reset all variants to bundled weights.',
                        });
                      }}
                      className="min-h-[40px] rounded-lg border border-[#D9C7A3]/25 bg-[#27201B] px-3 text-xs font-semibold text-[#E5DAC5] hover:border-[#F6C945]/50 inline-flex items-center justify-center gap-1.5 cursor-pointer whitespace-nowrap"
                    >
                      <RotateCcw className="w-3.5 h-3.5" />
                      <span>Reset to Bundled</span>
                    </button>
                  </div>

                  {tdStatus && (
                    <p
                      role="status"
                      className={`text-[11px] leading-snug ${
                        tdStatus.kind === 'err' ? 'text-[#E89B90]' : 'text-[#8FD19E]'
                      }`}
                    >
                      {tdStatus.text}
                    </p>
                  )}
                </div>
              </section>
            </>
          )}

          {subView === 'changelog' && (
            <div className="rounded-lg border border-[#D9C7A3]/15 bg-[#1C1714] p-3.5 text-xs text-[#D9C7A3] space-y-2.5">
              <div>
                <div className="font-mono-num font-bold text-[#F5EFE2] mb-0.5">v1.7</div>
                <p>
                  Reorganized the About screen into Changelog and AI submenus (moving TD AI
                  Methodology, AI Arena, and TD AI Weights into the AI menu and removing the in-app
                  training GUI link in favor of the standalone trainer page); gated Debug Tools behind
                  a 5-second hold on the Settings button with a soft confirmation prompt; updated
                  desktop Settings multi-option rows to place right-justified buttons inline beside
                  their labels while keeping the stacked layout on mobile; and removed section and
                  exit icons in Settings.
                </p>
              </div>
              <div className="pt-2 border-t border-[#D9C7A3]/10">
                <div className="font-mono-num font-bold text-[#F5EFE2] mb-0.5">v1.6.3</div>
                  <p>
                    Enabled the Full Screen button on the Main Menu Settings screen as well as
                    in-game Settings across desktop and mobile (hidden only on Apple iPhones), with
                    equal-width unlit Full/Exit and Hand Compact/Expand toggles; adopted
                    left-anchored modal headers with brass dividers and safe-area padding to clear
                    central punch-hole cameras on Samsung devices; added smooth CSS scroll-snap
                    swiping in Compact mobile mode (Decks left, Board center, Log right); displayed
                    Special Achievements inline by default on mobile Decks with alt-card triggers,
                    greyed-out claimed entries sorted to the bottom, no icons, and tighter spacing;
                    added two-step Choose None / Skip confirmation on optional selection prompts
                    and removed Confirm Selection (0); added per-card draw popups for repeated-draw
                    Dogma cards (Metalworking, Colonialism, Astronomy, Reclamation, Space Traffic);
                    added the Dogma icon inline beside Dogma text in Compact mode with tighter
                    spacing and hand-card-style age badges; hid the hexagon icon on compacted
                    mobile hand cards to save horizontal space; defaulted AI seats to Hard TD AI,
                    removed hover tooltips on AI tier selectors, updated AI difficulty descriptions
                    in the help guide, and updated the empty AI Chronicle tab note to &ldquo;No
                    Heuristic AI detected&rdquo; when no Heuristic AI is present; and redesigned
                    the Card Inspector popup to match the Dogma popup with click-anywhere dismissal
                    (preserving clicks on cards and stack buttons).
                  </p>
                </div>
                <div className="pt-2 border-t border-[#D9C7A3]/10">
                  <div className="font-mono-num font-bold text-[#F5EFE2] mb-0.5">v1.6.2</div>
                  <p>
                    Updated the in-game Settings Full Screen button so it is only hidden on Apple
                    iPhones and remains available on Macs, iPads, and all other supported devices.
                  </p>
                </div>
                <div className="pt-2 border-t border-[#D9C7A3]/10">
                  <div className="font-mono-num font-bold text-[#F5EFE2] mb-0.5">v1.6.1</div>
                  <p>
                    Fixed desktop Dogma pop-up horizontal clipping across the card and Icon Counts
                    &amp; Effects panel; fixed AI Arena end-game inspection backdrop clicks jumping
                    away instead of returning to the matches list; removed the Rules button from the
                    in-game header (keeping Settings across all layouts); and refined Settings
                    labels and button styling (Exit to Menu and Save Game).
                  </p>
                </div>
                <div className="pt-2 border-t border-[#D9C7A3]/10">
                  <div className="font-mono-num font-bold text-[#F5EFE2] mb-0.5">v1.6</div>
                  <p>
                    Enforced dark-only color-scheme meta and CSS rules across browsers; updated Auto
                    orientation to default to Vertical and switch to Horizontal only when landscape
                    (aspect ≥ 1.25) and wide (≥ 900px); updated Compact mobile card footers to
                    always display all top-card icons when unsplayed and splayed icons plus top-card
                    icons when splayed; extended mobile Decks and Log views to cover the bottom
                    action dock; persisted every move immediately to localStorage across all modes;
                    redesigned the Achievements modal with clean Age: Name rows, [points] [Age]
                    badges, yellow eligibility highlights, and a Back button; fixed bottom-player
                    active-turn board highlighting in 1v1 and AI vs AI; and added a standalone
                    dev-only TD Training &amp; Weights Studio GUI (excluded from offline HTML builds)
                    for training new models without deleting existing weights, head-to-head
                    multi-model benchmarking with PNG chart export, and selecting the primary bundled
                    model.
                  </p>
                </div>
                <div className="pt-2 border-t border-[#D9C7A3]/10">
                  <div className="font-mono-num font-bold text-[#F5EFE2] mb-0.5">v1.5.1</div>
                  <p>
                    Fixed opponent Score displays showing score card count instead of public score
                    points total; added lighter yellow active highlights for Meld/Dogma buttons,
                    lighter Achieve and End Turn arrow buttons, refined 1px Dogma card hover borders,
                    muted 1px opponent last-action borders, and icon-count comparison boxes (light
                    blue higher, muted yellow same/active, light red lower) in both the player icon
                    bar and Dogma pop-up (below the card on mobile, to the right on desktop);
                    ensured Dogma always requires clicking a target card on both desktop and
                    mobile; tightened desktop 2v2/3p horizontal card spacing and added ellipsis
                    truncation on desktop dogma text; streamlined mobile Card Database color filters
                    onto one horizontal row; moved Score/Ach/H and Decks/Log into the 6th grid slot
                    across Compact, Swipe, and Vertical mobile views with tighter spacing and Mobile
                    Navigation Bar off by default; moved hand Sort/Compact and scroll controls
                    right-justified onto the hand header line and enabled Compact hand in all
                    modes; ordered hand summaries highest-to-lowest age; replaced splay words with
                    directional arrows, matched exposed icon size to player icon bars with tighter
                    spacing, and fixed fallback from individual icons to compressed summaries to
                    ellipsis; added an in-game Full Screen button in Settings (disabled on Apple
                    devices); and updated the Rules reference wording.
                  </p>
                </div>
                <div className="pt-2 border-t border-[#D9C7A3]/10">
                  <div className="font-mono-num font-bold text-[#F5EFE2] mb-0.5">v1.5</div>
                  <p>
                    Unified desktop menu widths and removed Match Setup top title clutter; eliminated
                    mobile modal top whitespace and tightened Card Database/Rules headers; made Compact
                    mode the mobile default with Score/Ach/H buttons beside Purple; disabled hand swipe
                    interference, added an in-game Mobile Navigation Bar toggle, strengthened match
                    random seeding, added clickable AI Arena end-game board inspection, and added CLI
                    progress reporting, specific card-victory tracking, and rolling game-end snapshot
                    exports.
                  </p>
                </div>
                <div className="pt-2 border-t border-[#D9C7A3]/10">
                  <div className="font-mono-num font-bold text-[#F5EFE2] mb-0.5">v1.4</div>
                  <p>
                    Included trained TD(λ) neural network weights (15k self-play games, 2k warm-start
                    games, λ=0.7), added 5 AI difficulty tiers on Match Setup (Heuristic, Easy/Medium/Hard/Full
                    TD AI), added headless in-app and CLI AI benchmarking, relocated TD AI weights
                    under About, and overhauled mobile layout views (Large Swipe, Compact, Large
                    Vertical), newest-first hand ordering with Age/Color/Name sorting, mobile hand
                    compact toggle, double-tap mobile confirmations, and clean 2v2/mobile headers.
                  </p>
                </div>
                <div className="pt-2 border-t border-[#D9C7A3]/10">
                  <div className="font-mono-num font-bold text-[#F5EFE2] mb-0.5">v1.3.1</div>
                  <p>
                    Fixed TD(λ) prompt scoring by simulating major prompt effects directly inside TD
                    search without Heuristic delegation, upgraded to v3 turn-ownership features
                    (1,229 inputs) with balanced lookahead/no-op penalties, removed all weight
                    pruning (100% weight retention), and added mini-batch Adam (batch size 32) with
                    Heuristic value distillation during warm-start.
                  </p>
                </div>
                <div className="pt-2 border-t border-[#D9C7A3]/10">
                  <div className="font-mono-num font-bold text-[#F5EFE2] mb-0.5">v1.3</div>
                  <p>
                    Upgraded the TD(λ) neural AI to v2 card-aware features (1,225 inputs with exact
                    top-card, splayed/buried stack, and hand card IDs across all modes), TD-native
                    prompt and two-step Action-1 lookahead, stabilized full-strength warm-start/self-play
                    training with higher weight retention, Windows multi-worker CLI compatibility, and
                    card rule fixes across Statistics, Skyscrapers, Services, Near-Field Comm,
                    Measurement, and Space Traffic.
                  </p>
                </div>
                <div className="pt-2 border-t border-[#D9C7A3]/10">
                  <div className="font-mono-num font-bold text-[#F5EFE2] mb-0.5">v1.2</div>
                  <p>
                    Added TD(λ) 2-layer neural-network AI paired with 1-ply expectiminimax lookahead
                    over draws, per-seat Heuristic/TD AI selection, offline trainer CLI with heuristic
                    warm-start, and custom JSON weight loader in Settings.
                  </p>
                </div>
                <div className="pt-2 border-t border-[#D9C7A3]/10">
                  <div className="font-mono-num font-bold text-[#F5EFE2] mb-0.5">v1.1</div>
                  <p>
                    Added 2v2 team mode (with 2v2 Dogma sharing/demand rules and team AI logic) and
                    per-player Human/AI setup including AI vs AI with revealed cards.
                  </p>
                </div>
                <div className="pt-2 border-t border-[#D9C7A3]/10">
                  <div className="font-mono-num font-bold text-[#F5EFE2] mb-0.5">v1.0</div>
                  <p>V1.0, all ages and AI implemented.</p>
                </div>
              </div>
            )}
        </div>
      </div>
    </div>
  );
};

export interface DogmaParticipantStatus {
  playerId: string;
  playerName: string;
  iconCount: number;
  highlight: 'blue' | 'yellow' | 'red';
  shortStatus: string;
  statusLabel: string;
}

export interface OpponentMoveNotice {
  id: string;
  actorName: string;
  kind: 'dogma' | 'meld' | 'draw' | 'achieve';
  title: string;
  card?: CardInstance;
  featuredIcon?: FunctionalIcon;
  dogmaParticipants?: DogmaParticipantStatus[];
  drawnAges?: Age[];
  achievedAge?: Age;
  details: string[];
}

export const OpponentMoveModal: React.FC<{
  notice: OpponentMoveNotice | null;
  onDismiss: () => void;
}> = ({ notice, onDismiss }) => {
  if (!notice) return null;

  const hasDogmaList = Boolean(
    notice.card &&
      notice.featuredIcon &&
      notice.dogmaParticipants &&
      notice.dogmaParticipants.length > 0
  );

  const highlightToneClasses: Record<
    DogmaParticipantStatus['highlight'],
    { box: string; text: string }
  > = {
    blue: {
      box: 'bg-[#38BDF8]/20 border-[#7DD3FC]/85',
      text: 'text-[#BAE6FD]',
    },
    yellow: {
      box: 'bg-[#EAB308]/18 border-[#EAB308]/65',
      text: 'text-[#FDE047]/90',
    },
    red: {
      box: 'bg-[#F87171]/22 border-[#FCA5A5]/85',
      text: 'text-[#FECACA]',
    },
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 p-0 sm:p-4 cursor-pointer"
      role="dialog"
      aria-modal="true"
      aria-label={notice.title}
      onClick={onDismiss}
    >
      <div
        className={`w-full ${
          hasDogmaList ? 'sm:max-w-2xl' : 'sm:max-w-md'
        } max-h-[92vh] overflow-y-auto rounded-t-2xl sm:rounded-xl bg-[#27201B] border border-[#C88A1E] p-4 sm:p-5 text-[#F5EFE2] shadow-2xl space-y-3 sm:space-y-4`}
      >
        <div className="text-center space-y-1">
          <div className="text-[11px] font-mono-num uppercase tracking-wider text-[#C8B9A6]">
            {notice.actorName}
          </div>
          <h2 className="font-display text-lg font-bold text-[#F6C945]">{notice.title}</h2>
        </div>

        {notice.card && hasDogmaList && notice.featuredIcon && notice.dogmaParticipants ? (
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-center gap-2.5 sm:gap-4">
            <div className="w-full sm:flex-1 sm:min-w-0 flex justify-center">
              <CardTile card={notice.card} />
            </div>

            {/* Mobile: compact small strip below the card */}
            <div className="sm:hidden grid grid-cols-2 gap-1">
              {notice.dogmaParticipants.map((p) => {
                const tone = highlightToneClasses[p.highlight];
                return (
                  <div
                    key={p.playerId}
                    className={`rounded border px-1.5 py-1 flex items-center justify-between gap-1 text-[10px] leading-tight ${tone.box}`}
                  >
                    <span className="font-semibold text-[#F5EFE2] truncate min-w-0">
                      {p.playerName}
                    </span>
                    <span className="inline-flex items-center gap-1 shrink-0 font-mono-num">
                      <span className="inline-flex items-center gap-0.5 text-[#F5EFE2]">
                        <IconGlyph slot={notice.featuredIcon!} size={10} />
                        {p.iconCount}
                      </span>
                      <span className={`font-semibold ${tone.text}`}>{p.shortStatus}</span>
                    </span>
                  </div>
                );
              })}
            </div>

            {/* Desktop: structured vertical list to the right of the card */}
            <div className="hidden sm:flex sm:flex-col sm:w-[220px] shrink-0 gap-1.5">
              <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-[#C8B9A6] pb-1 border-b border-[#D9C7A3]/15">
                <IconGlyph slot={notice.featuredIcon} size={13} />
                <span>Icon Counts &amp; Effects</span>
              </div>
              {notice.dogmaParticipants.map((p) => {
                const tone = highlightToneClasses[p.highlight];
                return (
                  <div
                    key={p.playerId}
                    className={`rounded-lg border px-2.5 py-2 flex items-center justify-between gap-2 ${tone.box}`}
                  >
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-[#F5EFE2] truncate">
                        {p.playerName}
                      </div>
                      <div className={`text-[11px] font-medium ${tone.text}`}>
                        {p.statusLabel}
                      </div>
                    </div>
                    <div className="inline-flex items-center gap-1 font-mono-num text-xs font-bold text-[#F5EFE2] shrink-0">
                      <IconGlyph slot={notice.featuredIcon!} size={14} />
                      <span>{p.iconCount}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          notice.card && (
            <div className="flex justify-center">
              <CardTile card={notice.card} />
            </div>
          )
        )}

        {notice.drawnAges && notice.drawnAges.length > 0 && (
          <div className="flex flex-wrap justify-center gap-2 py-2">
            {notice.drawnAges.map((age, idx) => (
              <div
                key={`${age}_${idx}`}
                className="w-20 h-28 rounded-xl border-2 border-[#C88A1E]/70 bg-[#1C1714] flex flex-col items-center justify-center gap-1 shadow-lg"
              >
                <span className="font-mono-num text-2xl font-bold text-[#F6C945]">{age}</span>
                <span className="text-[10px] text-[#C8B9A6]">{AGE_NAMES[age]}</span>
              </div>
            ))}
          </div>
        )}

        {notice.achievedAge !== undefined && (
          <div className="flex justify-center py-2">
            <div className="rounded-xl border-2 border-[#C88A1E] bg-[#3A2D19] px-5 py-3 flex items-center gap-2.5 text-[#F6C945]">
              <Award className="w-5 h-5" />
              <span className="font-mono-num text-base font-bold">
                Age {notice.achievedAge} · {AGE_NAMES[notice.achievedAge]}
              </span>
            </div>
          </div>
        )}

        {notice.details.length > 0 && (
          <div className="rounded-lg border border-[#D9C7A3]/15 bg-[#1C1714] p-3 space-y-1 text-xs text-[#D9C7A3] max-h-28 sm:max-h-36 overflow-y-auto">
            {notice.details.map((line, i) => (
              <p key={i} className="leading-snug">
                {line}
              </p>
            ))}
          </div>
        )}

        <p className="text-center text-[11px] text-[#9E8F7E]">Click anywhere to continue</p>
      </div>
    </div>
  );
};

export const RepeatDrawModal: React.FC<{
  event: RepeatDrawStepEvent | null;
  remainingCount: number;
  onDismiss: () => void;
}> = ({ event, remainingCount, onDismiss }) => {
  if (!event) return null;

  return (
    <div
      className="fixed inset-0 z-[55] flex items-end sm:items-center justify-center bg-black/70 p-0 sm:p-4 cursor-pointer"
      role="dialog"
      aria-modal="true"
      aria-label={`${event.sourceCardName} Draw ${event.stepNumber}`}
      onClick={onDismiss}
    >
      <div className="w-full sm:max-w-md max-h-[92vh] overflow-y-auto rounded-t-2xl sm:rounded-xl bg-[#27201B] border border-[#C88A1E] p-4 sm:p-5 text-[#F5EFE2] shadow-2xl space-y-3">
        <div className="text-center space-y-1">
          <div className="text-[11px] font-mono-num uppercase tracking-wider text-[#C8B9A6]">
            {event.actorName} · {event.sourceCardName} (Draw #{event.stepNumber})
          </div>
          <h2 className="font-display text-lg font-bold text-[#F6C945]">
            Drew {event.card.name} [{event.card.age}]
          </h2>
          <div className="pt-0.5 flex justify-center">
            <span
              className={`inline-flex items-center rounded-md border px-2.5 py-0.5 text-[11px] font-semibold tracking-wide ${
                event.repeats
                  ? 'border-[#C88A1E] bg-[#3A2D19] text-[#F6C945]'
                  : 'border-[#D9C7A3]/25 bg-[#1C1714] text-[#D9C7A3]'
              }`}
            >
              {event.badge}
            </span>
          </div>
        </div>

        <div className="flex justify-center">
          <CardTile card={event.card} />
        </div>

        <div className="rounded-lg border border-[#D9C7A3]/15 bg-[#1C1714] px-3 py-2 text-xs text-[#D9C7A3] text-center leading-snug">
          {event.outcomeText}
        </div>

        <p className="text-center text-[11px] text-[#9E8F7E]">
          {remainingCount > 0 ? 'Click anywhere for next draw' : 'Click anywhere to continue'}
        </p>
      </div>
    </div>
  );
};

export interface AchievementsWonTarget {
  playerName: string;
  achievementTarget: number;
  achievements: ReadonlyArray<ClaimedAchievement | PublicPlayerView['achievementBacks'][number]>;
}

export const AchievementsWonModal: React.FC<{
  target: AchievementsWonTarget | null;
  onClose: () => void;
}> = ({ target, onClose }) => {
  if (!target) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/75 p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`${target.playerName} Achievements`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full sm:max-w-md max-h-[85vh] flex flex-col rounded-t-2xl sm:rounded-xl bg-[#27201B] border border-[#D9C7A3]/25 p-5 text-[#F5EFE2] shadow-2xl space-y-4">
        <div className="flex items-center justify-between gap-4 pb-3 border-b border-[#D9C7A3]/15">
          <div>
            <h2 className="font-display text-lg font-bold flex items-center gap-2">
              <Award className="w-5 h-5 text-[#F6C945]" />
              <span>{target.playerName}&apos;s Achievements</span>
            </h2>
            <p className="text-xs font-mono-num text-[#C8B9A6] mt-0.5">
              {target.achievements.length} / {target.achievementTarget} required
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Achievements"
            className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg hover:bg-[#F5EFE2]/10 cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto space-y-2">
          {target.achievements.length === 0 ? (
            <p className="text-xs text-[#8D7F70] py-6 text-center">
              No achievements claimed yet.
            </p>
          ) : (
            target.achievements.map((ach) => (
              <div
                key={ach.id}
                className="rounded-lg border border-[#D9C7A3]/20 bg-[#1C1714] px-3.5 py-2.5 flex items-center justify-between gap-3"
              >
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-[#F5EFE2]">
                    {ach.kind === 'special'
                      ? SPECIAL_ACHIEVEMENTS[ach.specialId!].name
                      : ach.kind === 'chain'
                      ? `Chain Achievement · Age ${ach.age}`
                      : `Standard Achievement · Age ${ach.age} (${AGE_NAMES[ach.age!]})`}
                  </div>
                  {ach.kind === 'special' && (
                    <div className="text-[11px] text-[#C8B9A6] mt-0.5">
                      {SPECIAL_ACHIEVEMENTS[ach.specialId!].description}
                    </div>
                  )}
                </div>
                <span className="font-mono-num text-[11px] uppercase px-2 py-0.5 rounded bg-[#27201B] border border-[#D9C7A3]/20 text-[#F6C945] shrink-0">
                  {ach.kind === 'special' ? 'Special' : ach.kind === 'chain' ? 'Chain' : `[${ach.age}]`}
                </span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};

export const JunkPileModal: React.FC<{
  open: boolean;
  view: PlayerView;
  onClose: () => void;
}> = ({ open, view, onClose }) => {
  if (!open) return null;

  const ageCounts = groupCountByAge(view.junkBacks);
  const claimedSpecials = new Set<SpecialAchievementId>();
  for (const p of view.players) {
    for (const a of p.achievementBacks) {
      if (a.kind === 'special' && a.specialId) claimedSpecials.add(a.specialId);
    }
  }
  const junkedSpecials = (Object.keys(SPECIAL_ACHIEVEMENTS) as SpecialAchievementId[]).filter(
    (id) => !view.availableSpecialAchievements.includes(id) && !claimedSpecials.has(id)
  );
  const junkedStandard = [...view.junkedStandardAges].sort((a, b) => a - b);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/75 p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Junk Pile"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full sm:max-w-lg max-h-[85vh] overflow-y-auto rounded-t-2xl sm:rounded-xl bg-[#27201B] border border-[#D9C7A3]/25 p-5 text-[#F5EFE2] shadow-2xl space-y-4">
        <div className="flex items-center justify-between gap-4 pb-3 border-b border-[#D9C7A3]/15">
          <div>
            <h2 className="font-display text-lg font-bold flex items-center gap-2">
              <Trash2 className="w-5 h-5 text-[#F6C945]" />
              <span>Junk Pile</span>
            </h2>
            <p className="text-xs font-mono-num text-[#C8B9A6] mt-0.5">
              {view.junkCount} junked card(s) · {junkedStandard.length + junkedSpecials.length} junked achievement(s)
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Junk Pile"
            className="min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg hover:bg-[#F5EFE2]/10 cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="space-y-2">
          <h3 className="text-xs font-semibold text-[#C8B9A6]">Junked Cards by Age</h3>
          {ageCounts.length === 0 ? (
            <p className="text-xs text-[#8D7F70]">No cards in the Junk pile.</p>
          ) : (
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
              {ageCounts.map(({ age, count }) => (
                <div
                  key={age}
                  className="rounded-lg border border-[#D9C7A3]/20 bg-[#1C1714] px-3 py-2 flex items-center justify-between"
                >
                  <div>
                    <div className="font-mono-num text-xs font-bold text-[#F6C945]">Age {age}</div>
                    <div className="text-[10px] text-[#A99B89] truncate max-w-[72px]">
                      {AGE_NAMES[age]}
                    </div>
                  </div>
                  <span className="font-mono-num text-base font-bold text-[#F5EFE2]">{count}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="pt-3 border-t border-[#D9C7A3]/15 space-y-2">
          <h3 className="text-xs font-semibold text-[#C8B9A6]">Junked Achievements</h3>
          {junkedStandard.length === 0 && junkedSpecials.length === 0 ? (
            <p className="text-xs text-[#8D7F70]">No achievements have been junked.</p>
          ) : (
            <div className="space-y-1.5">
              {junkedStandard.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {junkedStandard.map((age) => (
                    <span
                      key={age}
                      className="rounded border border-[#D9C7A3]/25 bg-[#1C1714] px-2.5 py-1 font-mono-num text-xs text-[#E5DAC5]"
                    >
                      Standard [{age}] · {AGE_NAMES[age]}
                    </span>
                  ))}
                </div>
              )}
              {junkedSpecials.map((sp) => (
                <div
                  key={sp}
                  className="rounded-lg border border-[#D9C7A3]/20 bg-[#1C1714] px-3 py-2 flex items-center justify-between text-xs"
                >
                  <span className="font-semibold text-[#F6C945] inline-flex items-center gap-1.5">
                    <Sparkles className="w-3.5 h-3.5" />
                    {SPECIAL_ACHIEVEMENTS[sp].name}
                  </span>
                  <span className="text-[11px] font-mono-num text-[#9E8F7E]">Junked</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export const SpecialAchievementsModal: React.FC<{
  open: boolean;
  view: PlayerView;
  onClose: () => void;
}> = ({ open, view, onClose }) => {
  if (!open) return null;

  const sortedSpecials = getSortedSpecialAchievements(
    view.availableSpecialAchievements,
    view.players
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/75 p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Special Achievements"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full sm:max-w-lg max-h-[85vh] flex flex-col rounded-t-2xl sm:rounded-xl bg-[#27201B] border border-[#D9C7A3]/25 p-4 text-[#F5EFE2] shadow-2xl space-y-3">
        <div className="flex items-center justify-between gap-3 pb-2 border-b border-[#D9C7A3]/15">
          <div>
            <h2 className="font-display text-base sm:text-lg font-bold">Special Achievements</h2>
            <p className="text-[11px] font-mono-num text-[#C8B9A6]">
              {view.availableSpecialAchievements.length} / 5 available
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close Special Achievements"
            className="min-h-[36px] min-w-[36px] flex items-center justify-center rounded-lg hover:bg-[#F5EFE2]/10 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto space-y-1.5">
          {sortedSpecials.map(({ def: sa, available, ownerName }) => (
            <div
              key={sa.id}
              className={`rounded-md border px-2.5 py-2 text-xs ${
                available
                  ? 'border-[#D9C7A3]/25 bg-[#1C1714]'
                  : 'border-[#D9C7A3]/10 bg-[#1C1714]/45 opacity-55'
              }`}
            >
              <div className="flex items-center justify-between gap-2 font-semibold">
                <span className={available ? 'text-[#F6C945]' : 'text-[#9E8F7E]'}>{sa.name}</span>
                <span className="font-mono-num text-[11px] text-[#C8B9A6]">
                  {available
                    ? getSpecialAchievementProgressLabel(view, sa.id)
                    : ownerName
                    ? `Claimed (${ownerName})`
                    : 'Junked'}
                </span>
              </div>
              <p className="mt-0.5 text-[11px] text-[#D9C7A3] leading-snug">{sa.description}</p>
              <p className="mt-0.5 text-[10.5px] font-mono-num text-[#B8A996]">
                Card: {sa.altCardName} [{sa.altCardAge}]
              </p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export interface AchievementPopupNotice {
  id: string;
  playerName: string;
  kind: 'standard' | 'special' | 'chain';
  title: string;
  subtitle?: string;
}

export const AchievementPopupModal: React.FC<{
  notice: AchievementPopupNotice | null;
  onDismiss: () => void;
}> = ({ notice, onDismiss }) => {
  if (!notice) return null;

  return (
    <div
      className="fixed inset-0 z-[65] flex items-end sm:items-center justify-center bg-black/70 p-0 sm:p-4 cursor-pointer"
      role="dialog"
      aria-modal="true"
      aria-label={notice.title}
      onClick={onDismiss}
    >
      <div className="w-full sm:max-w-sm rounded-t-2xl sm:rounded-xl bg-[#27201B] border border-[#C88A1E] p-5 text-[#F5EFE2] shadow-2xl space-y-3 text-center">
        <div className="w-11 h-11 mx-auto rounded-full bg-[#3A2D19] border border-[#C88A1E] flex items-center justify-center text-[#F6C945]">
          {notice.kind === 'special' ? <Sparkles className="w-5 h-5" /> : <Award className="w-5 h-5" />}
        </div>
        <div className="text-[11px] font-mono-num uppercase tracking-wider text-[#C8B9A6]">
          {notice.playerName}
        </div>
        <h2 className="font-display text-lg font-bold text-[#F6C945]">{notice.title}</h2>
        {notice.subtitle && <p className="text-xs text-[#D9C7A3]">{notice.subtitle}</p>}
        <p className="pt-1 text-[11px] text-[#9E8F7E]">Click anywhere to continue</p>
      </div>
    </div>
  );
};

export const AllAISetupModal: React.FC<{
  open: boolean;
  autoMode: boolean;
  onChangeAutoMode: (next: boolean) => void;
  settings: AppSettings;
  onUpdateSettings: (patch: Partial<AppSettings>) => void;
  onConfirmStart: () => void;
  onCancel: () => void;
}> = ({
  open,
  autoMode,
  onChangeAutoMode,
  settings,
  onUpdateSettings,
  onConfirmStart,
  onCancel,
}) => {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/75 p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label="AI Match Options"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="w-full sm:max-w-md rounded-t-2xl sm:rounded-xl bg-[#27201B] border border-[#C88A1E] text-[#F5EFE2] shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-[#D9C7A3]/15">
          <h2 className="font-display text-lg font-bold text-[#F6C945]">AI Match Options</h2>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Close AI Match Options"
            className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-lg hover:bg-[#F5EFE2]/10 cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-3">
          {/* Auto Mode */}
          <div className="rounded-lg border border-[#D9C7A3]/18 bg-[#1C1714] px-3.5 py-2.5 space-y-2">
            <div>
              <div className="text-sm font-semibold text-[#F5EFE2]">Auto Mode</div>
              <div className="text-[11px] text-[#B8A996] mt-0.5 leading-snug">
                {autoMode
                  ? 'All popups advance automatically. Use the bottom Pause button anytime.'
                  : 'Click through popups manually and press End Turn when Auto End Turn is off.'}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              <button
                type="button"
                onClick={() => onChangeAutoMode(true)}
                className={`min-h-[36px] rounded-md text-xs font-bold border transition-colors cursor-pointer ${
                  autoMode
                    ? 'bg-[#C88A1E] text-[#1C1714] border-[#C88A1E]'
                    : 'bg-[#27201B] text-[#D9C7A3] border-[#D9C7A3]/20 hover:text-[#F5EFE2]'
                }`}
              >
                YES
              </button>
              <button
                type="button"
                onClick={() => onChangeAutoMode(false)}
                className={`min-h-[36px] rounded-md text-xs font-bold border transition-colors cursor-pointer ${
                  !autoMode
                    ? 'bg-[#C88A1E] text-[#1C1714] border-[#C88A1E]'
                    : 'bg-[#27201B] text-[#D9C7A3] border-[#D9C7A3]/20 hover:text-[#F5EFE2]'
                }`}
              >
                NO
              </button>
            </div>
          </div>

          {/* Automatically End Turn (synced with Settings) */}
          <button
            type="button"
            role="switch"
            aria-checked={settings.autoEndTurn}
            onClick={() => onUpdateSettings({ autoEndTurn: !settings.autoEndTurn })}
            className="w-full flex items-center justify-between gap-4 rounded-lg border border-[#D9C7A3]/18 bg-[#1C1714] px-3.5 py-2.5 text-left hover:border-[#F6C945]/60 cursor-pointer transition-colors"
          >
            <span className="text-sm font-semibold text-[#F5EFE2]">Automatically End Turn</span>
            <span
              className={`shrink-0 inline-flex items-center w-11 h-6 rounded-full p-0.5 transition-colors ${
                settings.autoEndTurn ? 'bg-[#C88A1E]' : 'bg-[#382F29]'
              }`}
            >
              <span
                className={`w-5 h-5 rounded-full bg-[#F5EFE2] shadow transition-transform ${
                  settings.autoEndTurn ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </span>
          </button>

          {/* Achievement Popups (synced with Settings) */}
          <button
            type="button"
            role="switch"
            aria-checked={settings.achievementPopups}
            onClick={() => onUpdateSettings({ achievementPopups: !settings.achievementPopups })}
            className="w-full flex items-center justify-between gap-4 rounded-lg border border-[#D9C7A3]/18 bg-[#1C1714] px-3.5 py-2.5 text-left hover:border-[#F6C945]/60 cursor-pointer transition-colors"
          >
            <span className="text-sm font-semibold text-[#F5EFE2]">Achievement Popups</span>
            <span
              className={`shrink-0 inline-flex items-center w-11 h-6 rounded-full p-0.5 transition-colors ${
                settings.achievementPopups ? 'bg-[#C88A1E]' : 'bg-[#382F29]'
              }`}
            >
              <span
                className={`w-5 h-5 rounded-full bg-[#F5EFE2] shadow transition-transform ${
                  settings.achievementPopups ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </span>
          </button>

          {/* Opponent Move Popups (clone of Settings screen) */}
          <div className="rounded-lg border border-[#D9C7A3]/18 bg-[#1C1714] px-3.5 py-2.5 space-y-2">
            <div className="text-sm font-semibold text-[#F5EFE2]">Opponent Move Popups</div>
            <div className="grid grid-cols-3 gap-1.5">
              {(
                [
                  { value: 'off', label: 'Off' },
                  { value: 'dogma', label: 'Dogma' },
                  { value: 'full', label: 'Full' },
                ] as Array<{ value: ShowOpponentMovesMode; label: string }>
              ).map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => onUpdateSettings({ showOpponentMoves: opt.value })}
                  className={`min-h-[36px] rounded-md text-xs font-semibold border transition-colors cursor-pointer ${
                    settings.showOpponentMoves === opt.value
                      ? 'bg-[#C88A1E] text-[#1C1714] border-[#C88A1E]'
                      : 'bg-[#27201B] text-[#D9C7A3] border-[#D9C7A3]/20 hover:text-[#F5EFE2]'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="px-5 py-4 border-t border-[#D9C7A3]/15 bg-[#1C1714]/70 flex items-center gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 min-h-[44px] rounded-lg border border-[#D9C7A3]/25 text-sm font-medium text-[#D9C7A3] hover:bg-[#F5EFE2]/10 cursor-pointer"
          >
            Back
          </button>
          <button
            type="button"
            onClick={onConfirmStart}
            className="flex-1 min-h-[44px] rounded-lg bg-[#C88A1E] text-[#1C1714] text-sm font-bold hover:bg-[#d89928] cursor-pointer"
          >
            Begin AI Match
          </button>
        </div>
      </div>
    </div>
  );
};
