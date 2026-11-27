import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  Download,
  FolderOpen,
  Maximize2,
  Minimize2,
  PlusCircle,
  Search,
  Trophy,
  X,
} from 'lucide-react';
import { ALL_AGES } from '../engine/constants';
import { listAllCardsWithLocations } from '../engine/debug';
import type {
  AppSettings,
  CardSizeMode,
  LayoutMode,
  ShowOpponentMovesMode,
} from '../engine/settings';
import type { Age, GameState } from '../engine/types';
import { usePwaInstall } from '../hooks/usePwaInstall';
import { ColorShapeMark } from './IconGlyph';
import { OfflineExportButton } from './OfflineExportButton';

interface SettingsModalProps {
  open: boolean;
  settings: AppSettings;
  onUpdateSettings: (patch: Partial<AppSettings>) => void;
  onOpenSaves: () => void;
  onSaveAndExitToMenu?: () => void;
  currentState: GameState | null;
  viewerId: string | null;
  onDebugEndGame?: (outcome: 'win' | 'lose') => void;
  onDebugTakeCard?: (defId: string) => void;
  onClose: () => void;
}

function isAppleIPhone(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const platform = navigator.platform || '';
  return /iPhone/i.test(ua) || /iPhone/i.test(platform);
}

function isFullscreenSupported(): boolean {
  if (typeof document === 'undefined' || isAppleIPhone()) return false;
  const root = document.documentElement as HTMLElement & {
    webkitRequestFullscreen?: () => Promise<void> | void;
  };
  return (
    typeof root?.requestFullscreen === 'function' ||
    typeof root?.webkitRequestFullscreen === 'function'
  );
}

const ToggleRow: React.FC<{
  label: string;
  description?: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}> = ({ label, description, checked, onChange }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    onClick={() => onChange(!checked)}
    className="w-full flex items-center justify-between gap-3 rounded-lg border border-[#D9C7A3]/18 bg-[#1C1714] px-3 py-1.5 text-left hover:border-[#F6C945]/60 cursor-pointer transition-colors"
  >
    <div className="min-w-0">
      <div className="text-[13px] sm:text-sm font-semibold text-[#F5EFE2] leading-snug">{label}</div>
      {description && (
        <div className="text-[11px] text-[#B8A996] leading-tight">{description}</div>
      )}
    </div>
    <span
      className={`shrink-0 inline-flex items-center w-11 h-6 rounded-full p-0.5 transition-colors ${
        checked ? 'bg-[#C88A1E]' : 'bg-[#382F29]'
      }`}
    >
      <span
        className={`w-5 h-5 rounded-full bg-[#F5EFE2] shadow transition-transform ${
          checked ? 'translate-x-5' : 'translate-x-0'
        }`}
      />
    </span>
  </button>
);

const SegmentedRow = <T extends string>({
  label,
  description,
  value,
  options,
  onChange,
}: {
  label: string;
  description?: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (next: T) => void;
}) => (
  <div className="rounded-lg border border-[#D9C7A3]/18 bg-[#1C1714] px-3 py-1.5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1.5 sm:gap-4">
    <div className="min-w-0">
      <div className="text-[13px] sm:text-sm font-semibold text-[#F5EFE2] leading-snug">{label}</div>
      {description && (
        <div className="text-[11px] text-[#B8A996] leading-tight">{description}</div>
      )}
    </div>
    <div
      className="grid gap-1.5 sm:shrink-0 sm:w-[276px]"
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          className={`min-h-[32px] px-2.5 rounded-md text-xs font-semibold border transition-colors cursor-pointer whitespace-nowrap ${
            value === opt.value
              ? 'bg-[#C88A1E] text-[#1C1714] border-[#C88A1E]'
              : 'bg-[#27201B] text-[#D9C7A3] border-[#D9C7A3]/20 hover:text-[#F5EFE2]'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  </div>
);

export const SettingsModal: React.FC<SettingsModalProps> = ({
  open,
  settings,
  onUpdateSettings,
  onOpenSaves,
  onSaveAndExitToMenu,
  currentState,
  viewerId,
  onDebugEndGame,
  onDebugTakeCard,
  onClose,
}) => {
  const [showTakeCardPicker, setShowTakeCardPicker] = useState(false);
  const [cardSearch, setCardSearch] = useState('');
  const [cardAgeFilter, setCardAgeFilter] = useState<'all' | Age>('all');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const { canInstall, installHint, triggerInstall } = usePwaInstall();

  const canUseFullscreen = useMemo(() => isFullscreenSupported(), []);

  useEffect(() => {
    if (!open || typeof document === 'undefined') return;
    const syncFullscreen = () => {
      const doc = document as Document & { webkitFullscreenElement?: Element | null };
      setIsFullscreen(Boolean(doc.fullscreenElement ?? doc.webkitFullscreenElement));
    };
    syncFullscreen();
    document.addEventListener('fullscreenchange', syncFullscreen);
    document.addEventListener('webkitfullscreenchange', syncFullscreen as EventListener);
    return () => {
      document.removeEventListener('fullscreenchange', syncFullscreen);
      document.removeEventListener('webkitfullscreenchange', syncFullscreen as EventListener);
    };
  }, [open]);

  const handleToggleFullscreen = () => {
    if (!canUseFullscreen || typeof document === 'undefined') return;
    try {
      const doc = document as Document & {
        webkitFullscreenElement?: Element | null;
        webkitExitFullscreen?: () => Promise<void> | void;
      };
      const root = document.documentElement as HTMLElement & {
        webkitRequestFullscreen?: () => Promise<void> | void;
      };
      const active = Boolean(doc.fullscreenElement ?? doc.webkitFullscreenElement);
      if (active) {
        const res = doc.exitFullscreen ? doc.exitFullscreen() : doc.webkitExitFullscreen?.();
        if (res && typeof (res as Promise<void>).catch === 'function') {
          (res as Promise<void>).catch(() => {});
        }
      } else {
        const res = root.requestFullscreen
          ? root.requestFullscreen()
          : root.webkitRequestFullscreen?.();
        if (res && typeof (res as Promise<void>).catch === 'function') {
          (res as Promise<void>).catch(() => {});
        }
      }
    } catch {
      // Ignore fullscreen errors cleanly on unsupported contexts
    }
  };

  useEffect(() => {
    if (!settings.debugUnlocked && showTakeCardPicker) {
      setShowTakeCardPicker(false);
    }
  }, [settings.debugUnlocked, showTakeCardPicker]);

  const cardLocations = useMemo(() => {
    if (!showTakeCardPicker || !currentState || !viewerId) return [];
    return listAllCardsWithLocations(currentState, viewerId);
  }, [showTakeCardPicker, currentState, viewerId]);

  const filteredDebugCards = useMemo(() => {
    const q = cardSearch.trim().toLowerCase();
    return cardLocations.filter(({ def, locationLabel }) => {
      if (cardAgeFilter !== 'all' && def.age !== cardAgeFilter) return false;
      if (!q) return true;
      return (
        def.name.toLowerCase().includes(q) ||
        def.id.toLowerCase().includes(q) ||
        locationLabel.toLowerCase().includes(q)
      );
    });
  }, [cardLocations, cardAgeFilter, cardSearch]);

  if (!open) return null;

  const inActiveMatch = Boolean(currentState && currentState.phase !== 'gameover' && viewerId);

  return (
    <>
      <div
        className="fixed inset-0 z-50 flex items-stretch sm:items-center justify-center bg-black/75 p-0 sm:p-4"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div className="w-full sm:max-w-4xl h-[100dvh] max-h-[100dvh] sm:h-auto sm:max-h-[88vh] flex flex-col rounded-none sm:rounded-xl bg-[#27201B] border border-[#D9C7A3]/25 text-[#F5EFE2] shadow-2xl overflow-hidden">
          <div className="flex items-center justify-between gap-2 px-safe pt-safe pb-2.5 sm:px-5 sm:py-3 border-b border-[#D9C7A3]/15 shrink-0">
            <div className="flex items-center gap-2.5 min-w-0">
              <button
                type="button"
                onClick={onClose}
                aria-label="Back from Settings"
                className="inline-flex items-center gap-1.5 min-h-[34px] px-2.5 rounded-lg border border-[#D9C7A3]/20 text-xs font-medium text-[#D9C7A3] hover:text-[#F5EFE2] hover:bg-[#F5EFE2]/10 cursor-pointer shrink-0"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                <span>Back</span>
              </button>
              <span className="h-4 w-px bg-[#C88A1E]/40 shrink-0" aria-hidden="true" />
              <h2 className="font-display text-base sm:text-xl font-bold truncate">Settings</h2>
            </div>
            {canUseFullscreen && (
              <button
                type="button"
                onClick={handleToggleFullscreen}
                aria-pressed={isFullscreen}
                aria-label={isFullscreen ? 'Exit Full Screen' : 'Enter Full Screen'}
                title={isFullscreen ? 'Exit Full Screen' : 'Full Screen'}
                className="inline-flex items-center justify-center gap-1 min-h-[34px] w-[68px] px-2.5 rounded-lg border border-[#D9C7A3]/20 text-xs font-medium text-[#D9C7A3] hover:text-[#F5EFE2] hover:bg-[#F5EFE2]/10 cursor-pointer shrink-0 transition-colors"
              >
                {isFullscreen ? (
                  <Minimize2 className="w-3.5 h-3.5" />
                ) : (
                  <Maximize2 className="w-3.5 h-3.5" />
                )}
                <span>{isFullscreen ? 'Exit' : 'Full'}</span>
              </button>
            )}
          </div>

          <div className="flex-1 overflow-y-auto p-3 sm:p-4 space-y-2.5">
            {currentState && (
              /* Mid-game Settings: Save & Exit to Menu */
              <section className="space-y-1.5">
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    onSaveAndExitToMenu?.();
                  }}
                  className="w-full min-h-[40px] rounded-lg border border-[#D9C7A3]/20 px-3.5 py-1.5 text-sm font-medium text-[#D9C7A3] hover:text-[#F5EFE2] hover:bg-[#F5EFE2]/10 inline-flex items-center justify-center cursor-pointer transition-colors"
                >
                  <span>Exit to Menu and Save Game</span>
                </button>
              </section>
            )}

            {/* Gameplay Settings */}
            <section className="space-y-1.5">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-[#F6C945]">
                Gameplay
              </h3>

              <ToggleRow
                label="Automatically End Turn"
                checked={settings.autoEndTurn}
                onChange={(next) => onUpdateSettings({ autoEndTurn: next })}
              />

              <SegmentedRow<ShowOpponentMovesMode>
                label="Opponent Move Popups"
                value={settings.showOpponentMoves}
                options={[
                  { value: 'off', label: 'Off' },
                  { value: 'dogma', label: 'Dogma' },
                  { value: 'full', label: 'Full' },
                ]}
                onChange={(next) => onUpdateSettings({ showOpponentMoves: next })}
              />

              <ToggleRow
                label="Achievement Popups"
                checked={settings.achievementPopups}
                onChange={(next) => onUpdateSettings({ achievementPopups: next })}
              />

              <ToggleRow
                label="Highlight Opponent's Last Turn"
                checked={settings.highlightOpponentLastTurn}
                onChange={(next) => onUpdateSettings({ highlightOpponentLastTurn: next })}
              />
            </section>

            {/* Display & Accessibility */}
            <section className="space-y-1.5">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-[#F6C945]">
                Display &amp; Layout
              </h3>

              <SegmentedRow<CardSizeMode>
                label="Card Size"
                value={settings.cardSize}
                options={[
                  { value: 'small', label: 'Small' },
                  { value: 'medium', label: 'Medium' },
                  { value: 'large', label: 'Large' },
                ]}
                onChange={(next) => onUpdateSettings({ cardSize: next })}
              />

              <SegmentedRow<LayoutMode>
                label="Layout View"
                value={settings.layoutMode}
                options={[
                  { value: 'auto', label: 'Auto' },
                  { value: 'landscape', label: 'Horizontal' },
                  { value: 'portrait', label: 'Vertical' },
                ]}
                onChange={(next) => onUpdateSettings({ layoutMode: next })}
              />

              {currentState && (
                <ToggleRow
                  label="Mobile Navigation Bar"
                  checked={settings.mobileNavBar}
                  onChange={(next) => onUpdateSettings({ mobileNavBar: next })}
                />
              )}

              <ToggleRow
                label="Show Expanded Hand (2 Rows)"
                checked={settings.expandedHand}
                onChange={(next) => onUpdateSettings({ expandedHand: next })}
              />

              <ToggleRow
                label="Color Blind Mode"
                description="Shows color shape emblems and text labels on board stacks and hand cards."
                checked={settings.colorBlindMode}
                onChange={(next) => onUpdateSettings({ colorBlindMode: next })}
              />
            </section>

            {/* Main Menu Settings: Saves & Offline HTML (second from bottom, ahead of Debug Tools) */}
            {!currentState && (
              <section className="space-y-1.5 pt-1.5 border-t border-[#D9C7A3]/15">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-[#F6C945]">
                  Saves &amp; Offline HTML
                </h3>
                <div className={`grid grid-cols-1 ${canInstall ? 'sm:grid-cols-3' : 'sm:grid-cols-2'} gap-2`}>
                  <button
                    type="button"
                    onClick={() => {
                      onClose();
                      onOpenSaves();
                    }}
                    className="min-h-[40px] rounded-lg border border-[#D9C7A3]/25 bg-[#1C1714] px-3 py-1.5 text-sm font-semibold text-[#F5EFE2] hover:border-[#F6C945] inline-flex items-center justify-center gap-2 cursor-pointer"
                  >
                    <FolderOpen className="w-4 h-4 text-[#F6C945]" />
                    <span>Saves &amp; Resume</span>
                  </button>
                  {canInstall && (
                    <button
                      type="button"
                      onClick={() => {
                        void triggerInstall();
                      }}
                      className="min-h-[40px] rounded-lg border border-[#D9C7A3]/25 bg-[#1C1714] px-3 py-1.5 text-sm font-semibold text-[#F5EFE2] hover:border-[#F6C945] inline-flex items-center justify-center gap-2 cursor-pointer"
                    >
                      <Download className="w-4 h-4 text-[#F6C945]" />
                      <span>Install App</span>
                    </button>
                  )}
                  <div className="flex items-stretch">
                    <OfflineExportButton className="w-full justify-center" />
                  </div>
                </div>
                {canInstall && installHint && (
                  <p className="text-[11px] text-[#E5DAC5] bg-[#1C1714] border border-[#D9C7A3]/20 rounded-lg px-3 py-2">
                    {installHint}
                  </p>
                )}
              </section>
            )}

            {/* Debug Tools (unlocked via 5-second hold on Settings button) */}
            {settings.debugUnlocked && (
              <section className="space-y-1.5 pt-1.5 border-t border-[#D9C7A3]/15">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-[#C8B9A6]">
                  Debug Tools
                </h3>

                <ToggleRow
                  label="Reveal Hidden Information"
                  description="Show Hidden Hands and Score Piles"
                  checked={settings.debugRevealHidden}
                  onChange={(next) => onUpdateSettings({ debugRevealHidden: next })}
                />

                <ToggleRow
                  label="Show AI Decision Making"
                  description="Show AI tab on chronicle showing heuristic candidate move scores"
                  checked={settings.debugShowAiDecisions}
                  onChange={(next) => onUpdateSettings({ debugShowAiDecisions: next })}
                />

                {inActiveMatch && onDebugEndGame && onDebugTakeCard && (
                  <div className="rounded-lg border border-[#D9C7A3]/18 bg-[#1C1714] px-3 py-2 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-4">
                    <div className="text-[13px] sm:text-sm font-semibold text-[#F5EFE2]">
                      Match Overrides
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 sm:shrink-0">
                      <button
                        type="button"
                        onClick={() => {
                          onDebugEndGame('win');
                          onClose();
                        }}
                        className="min-h-[36px] px-3 rounded-md bg-[#235B34] hover:bg-[#2c6f41] text-[#F5EFE2] text-xs font-semibold inline-flex items-center justify-center gap-1.5 cursor-pointer whitespace-nowrap"
                      >
                        <Trophy className="w-3.5 h-3.5" />
                        <span>Debug Win</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          onDebugEndGame('lose');
                          onClose();
                        }}
                        className="min-h-[36px] px-3 rounded-md bg-[#8E2920] hover:bg-[#a63329] text-[#F5EFE2] text-xs font-semibold inline-flex items-center justify-center gap-1.5 cursor-pointer whitespace-nowrap"
                      >
                        <span>Debug Lose</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowTakeCardPicker(true)}
                        className="min-h-[36px] px-3 rounded-md border border-[#C88A1E] bg-[#3A2D19] hover:bg-[#4d3b21] text-[#F6C945] text-xs font-semibold inline-flex items-center justify-center gap-1.5 cursor-pointer whitespace-nowrap"
                      >
                        <PlusCircle className="w-3.5 h-3.5" />
                        <span>Take Any Card</span>
                      </button>
                    </div>
                  </div>
                )}
              </section>
            )}
          </div>
        </div>
      </div>

      {/* Debug Take Any Card Picker Modal */}
      {settings.debugUnlocked && showTakeCardPicker && inActiveMatch && onDebugTakeCard && (
        <div
          className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center bg-black/80 p-0 sm:p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Debug Take Any Card"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowTakeCardPicker(false);
          }}
        >
          <div className="w-full sm:max-w-2xl h-[82vh] flex flex-col rounded-t-2xl sm:rounded-xl bg-[#27201B] border border-[#C88A1E] text-[#F5EFE2] shadow-2xl overflow-hidden">
            <div className="flex items-center justify-between gap-3 px-5 py-3.5 border-b border-[#D9C7A3]/15 shrink-0">
              <div>
                <h2 className="font-display text-lg font-bold text-[#F6C945]">
                  Debug: Take Any Card
                </h2>
                <p className="text-xs text-[#C8B9A6]">
                  Moves any card into your hand (or spawns a copy if already in your hand).
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowTakeCardPicker(false)}
                aria-label="Close Take Any Card"
                className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-lg hover:bg-[#F5EFE2]/10 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="px-5 py-3 border-b border-[#D9C7A3]/15 space-y-2 bg-[#1C1714]/65 shrink-0">
              <div className="relative">
                <Search className="w-4 h-4 text-[#A99B89] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="text"
                  value={cardSearch}
                  onChange={(e) => setCardSearch(e.target.value)}
                  placeholder="Search card name, ID (e.g. B016), or location..."
                  className="w-full min-h-[38px] rounded-lg bg-[#1C1714] border border-[#D9C7A3]/25 pl-9 pr-3 text-xs sm:text-sm text-[#F5EFE2] placeholder:text-[#7D7061]"
                />
              </div>

              <div className="flex items-center gap-1 overflow-x-auto no-scrollbar">
                <button
                  type="button"
                  onClick={() => setCardAgeFilter('all')}
                  className={`min-h-[30px] px-2.5 rounded text-xs font-semibold border cursor-pointer shrink-0 ${
                    cardAgeFilter === 'all'
                      ? 'bg-[#C88A1E] text-[#1C1714] border-[#C88A1E]'
                      : 'bg-[#1C1714] text-[#D9C7A3] border-[#D9C7A3]/20'
                  }`}
                >
                  All
                </button>
                {ALL_AGES.map((age) => (
                  <button
                    key={age}
                    type="button"
                    onClick={() => setCardAgeFilter(age)}
                    className={`min-h-[30px] min-w-[30px] px-2 rounded text-xs font-mono-num font-semibold border cursor-pointer shrink-0 ${
                      cardAgeFilter === age
                        ? 'bg-[#C88A1E] text-[#1C1714] border-[#C88A1E]'
                        : 'bg-[#1C1714] text-[#D9C7A3] border-[#D9C7A3]/20'
                    }`}
                  >
                    {age}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-1.5">
              {filteredDebugCards.map(({ def, locationLabel }) => (
                <div
                  key={def.id}
                  className="flex items-center justify-between gap-3 rounded-lg border border-[#D9C7A3]/15 bg-[#1C1714] px-3 py-2"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-mono-num text-[11px] font-bold px-1.5 py-0.5 rounded bg-[#27201B] border border-[#D9C7A3]/20 text-[#F6C945] shrink-0">
                      [{def.age}]
                    </span>
                    <ColorShapeMark color={def.color} size={12} />
                    <div className="min-w-0">
                      <div className="text-xs sm:text-sm font-semibold text-[#F5EFE2] truncate">
                        {def.name}{' '}
                        <span className="font-mono-num text-[10px] text-[#9E8F7E]">
                          {def.id}
                        </span>
                      </div>
                      <div className="text-[11px] text-[#B8A996] truncate">{locationLabel}</div>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      onDebugTakeCard(def.id);
                      setShowTakeCardPicker(false);
                    }}
                    className="min-h-[34px] px-3 rounded-md bg-[#C88A1E] text-[#1C1714] text-xs font-bold hover:bg-[#d89928] cursor-pointer shrink-0"
                  >
                    Take
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
};
