import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Eye,
  Pause,
  Play,
  Settings as SettingsIcon,
  Trash2,
} from 'lucide-react';
import { getSpecialAchievementProgressLabel } from '../engine/ai';
import {
  AGE_NAMES,
  ALL_AGES,
  ALL_COLORS,
  ALL_FUNCTIONAL_ICONS,
  ICON_LABELS,
} from '../engine/constants';
import {
  computeIsHorizontalView,
  type AppSettings,
  type MobileViewMode,
} from '../engine/settings';
import { sortHandCards, type HandSortMode } from '../engine/tdBenchmark';
import { normalizeAIBackend } from '../engine/tdWeights';
import { getSortedSpecialAchievements } from '../engine/uiHelpers';
import type {
  AIDecisionTrace,
  ActionLogEntry,
  Age,
  CardColor,
  CardInstance,
  ColorStack,
  FunctionalIcon,
  PlayerView,
  PublicPlayerView,
  TurnAction,
} from '../engine/types';
import { CardTile, ColorStackView, formatAgeCountsCompact } from './CardView';
import { IconGlyph } from './IconGlyph';
import { useLongPress } from '../hooks/useLongPress';
import {
  AchieveModal,
  AchievementsWonModal,
  CardInspectorModal,
  DogmaPromptModal,
  JunkPileModal,
  PileSummaryModal,
  SpecialAchievementsModal,
  type AchievementsWonTarget,
  type PileSummaryTarget,
} from './Modals';

interface TabletopViewProps {
  view: PlayerView;
  settings: AppSettings;
  aiTraces: AIDecisionTrace[];
  aiAutoMode?: boolean;
  isAiPaused?: boolean;
  onToggleAiPause?: () => void;
  onReopenVictory?: () => void;
  onAction: (action: TurnAction) => void;
  onUpdateSettings: (patch: Partial<AppSettings>) => void;
  onOpenSettings: () => void;
  onToggleDebugUnlock: () => void;
}

type MobileSectionTab = 'play' | 'opponents' | 'supply' | 'chronicle';
type ActionSelectionMode = 'none' | 'meld' | 'dogma';
type PendingMobileConfirm =
  | { kind: 'draw' }
  | { kind: 'achieve' }
  | { kind: 'meld'; cardInstanceId: string }
  | { kind: 'setup_meld'; cardInstanceId: string }
  | { kind: 'dogma'; color: CardColor };

const MOBILE_VIEW_MODES: Array<{ value: MobileViewMode; label: string; title: string }> = [
  { value: 'large_swipe', label: 'Swipe', title: 'Mobile View: Large Swipe' },
  { value: 'compact', label: 'Compact', title: 'Mobile View: Compact Boards' },
  { value: 'large_vertical', label: 'Vertical', title: 'Mobile View: Large Vertical' },
];

interface GroupedLogItem {
  entry: ActionLogEntry;
  subEntries: ActionLogEntry[];
}

interface PlayerLogGroup {
  actorId: string;
  actorName: string;
  entries: GroupedLogItem[];
}

interface TurnLogGroup {
  turn: number;
  players: PlayerLogGroup[];
}

function groupLogEntriesNewestFirst(log: ActionLogEntry[]): TurnLogGroup[] {
  const byParent = new Map<string, ActionLogEntry[]>();
  const topLevelEntries: ActionLogEntry[] = [];

  for (const entry of log) {
    if (entry.parentLogId) {
      const children = byParent.get(entry.parentLogId) ?? [];
      children.push(entry);
      byParent.set(entry.parentLogId, children);
    } else {
      topLevelEntries.push(entry);
    }
  }

  const byTurn = new Map<number, ActionLogEntry[]>();
  for (const entry of topLevelEntries) {
    const list = byTurn.get(entry.turn) ?? [];
    list.push(entry);
    byTurn.set(entry.turn, list);
  }

  // Newest turn at the top; newest action & newest sub-log at the top within each turn
  const turns = Array.from(byTurn.keys()).sort((a, b) => b - a);
  return turns.map((turn) => {
    const entries = [...(byTurn.get(turn) ?? [])].reverse();
    const playerGroups: PlayerLogGroup[] = [];
    for (const entry of entries) {
      const groupedItem: GroupedLogItem = {
        entry,
        subEntries: [...(byParent.get(entry.id) ?? [])].reverse(),
      };
      const last = playerGroups[playerGroups.length - 1];
      if (last && last.actorId === entry.actorId) {
        last.entries.push(groupedItem);
      } else {
        playerGroups.push({
          actorId: entry.actorId,
          actorName: entry.actorName,
          entries: [groupedItem],
        });
      }
    }
    return { turn, players: playerGroups };
  });
}

const GroupedChronicle: React.FC<{ log: ActionLogEntry[] }> = ({ log }) => {
  const groupedTurns = useMemo(() => groupLogEntriesNewestFirst(log), [log]);

  return (
    <div className="space-y-2">
      {groupedTurns.map((turnGroup) => (
        <div
          key={turnGroup.turn}
          className="rounded-md border border-[#D9C7A3]/12 bg-[#1C1714]/75 p-2 space-y-1.5"
        >
          <div className="flex items-center justify-between text-[11px] font-mono-num font-semibold text-[#F6C945] border-b border-[#D9C7A3]/10 pb-0.5">
            <span>{turnGroup.turn === 0 ? 'Setup' : `Turn ${turnGroup.turn}`}</span>
          </div>

          <div className="space-y-1.5">
            {turnGroup.players.map((pg, idx) => (
              <div key={`${turnGroup.turn}_${pg.actorId}_${idx}`} className="space-y-0.5">
                {pg.actorId !== 'system' && (
                  <div className="text-[11px] font-semibold text-[#F5EFE2]">{pg.actorName}</div>
                )}
                <div className="space-y-1 pl-2 border-l border-[#D9C7A3]/20">
                  {pg.entries.map(({ entry, subEntries }) => (
                    <div key={entry.id} className="space-y-0.5">
                      <div className="text-[11.5px] leading-snug text-[#D9C7A3]">
                        {entry.actionTag && (
                          <span className="font-mono-num text-[10px] font-semibold text-[#C88A1E] mr-1">
                            [{entry.actionTag}]
                          </span>
                        )}
                        <span className="whitespace-pre-line">{entry.message}</span>
                      </div>
                      {subEntries.length > 0 && (
                        <div className="pl-2.5 space-y-0.5 border-l border-[#D9C7A3]/15">
                          {subEntries.map((sub) => (
                            <div key={sub.id} className="text-[10.5px] leading-snug text-[#B8A996]">
                              {sub.actionTag && (
                                <span className="font-mono-num text-[9.5px] font-medium text-[#C88A1E]/85 mr-1">
                                  [{sub.actionTag}]
                                </span>
                              )}
                              <span className="whitespace-pre-line">{sub.message}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
};

const AIDecisionTraceList: React.FC<{
  traces: AIDecisionTrace[];
  hasHeuristicAI: boolean;
}> = ({ traces, hasHeuristicAI }) => {
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  if (traces.length === 0) {
    return (
      <div className="py-8 text-center text-xs text-[#9E8F7E]">
        {hasHeuristicAI ? 'No AI decisions recorded yet.' : 'No Heuristic AI detected'}
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {[...traces].reverse().map((trace) => (
        <div
          key={trace.id}
          className="rounded-md border border-[#D9C7A3]/15 bg-[#1C1714]/85 p-2 space-y-1.5"
        >
          <div className="flex items-center justify-between gap-1 text-[10.5px] font-mono-num">
            <span className="font-bold text-[#F6C945]">
              Turn {trace.turn} · {trace.actorName}
            </span>
            <span className="text-[#C8B9A6]">{trace.actionLabel}</span>
          </div>
          <div className="text-[10px] text-[#B8A996] font-mono-num">{trace.situationSummary}</div>
          <div className="text-[11px] font-semibold text-[#F5EFE2]">
            Chosen: <span className="text-[#F6C945]">{trace.chosenLabel}</span>
          </div>
          {trace.candidates.length > 0 && (
            <div className="space-y-1 pt-1 border-t border-[#D9C7A3]/10">
              {trace.candidates.map((cand, idx) => {
                const candKey = `${trace.id}_c_${idx}`;
                const hasBreakdown = Boolean(cand.breakdown && cand.breakdown.length > 0);
                const isExpanded = expandedKey === candKey;
                const isTDTrace = trace.actionLabel.startsWith('TD AI');
                return (
                  <div key={candKey} className="space-y-0.5">
                    <button
                      type="button"
                      disabled={!hasBreakdown}
                      onClick={() =>
                        setExpandedKey((prev) => (prev === candKey ? null : candKey))
                      }
                      className={`w-full flex items-center justify-between gap-2 text-left text-[10.5px] font-mono-num px-1.5 py-0.5 rounded transition-colors ${
                        cand.selected
                          ? 'bg-[#3A2D19] text-[#F6C945] font-semibold'
                          : 'text-[#C8B9A6] hover:bg-[#F5EFE2]/5'
                      } ${hasBreakdown ? 'cursor-pointer' : 'cursor-default'}`}
                    >
                      <span className="flex items-center gap-1 min-w-0 truncate">
                        {hasBreakdown &&
                          (isExpanded ? (
                            <ChevronUp className="w-3 h-3 shrink-0 opacity-75" />
                          ) : (
                            <ChevronDown className="w-3 h-3 shrink-0 opacity-75" />
                          ))}
                        <span className="truncate">{cand.label}</span>
                      </span>
                      <span className="shrink-0">
                        {isTDTrace ? `${cand.score.toFixed(1)}%` : cand.score.toFixed(2)}
                      </span>
                    </button>

                    {isExpanded && cand.breakdown && cand.breakdown.length > 0 && (
                      <div className="ml-3 pl-2 border-l border-[#D9C7A3]/20 py-0.5 space-y-0.5">
                        {cand.breakdown.map((item) => {
                          const isPct = item.factor.endsWith('%');
                          const isSigned =
                            !isPct ||
                            item.factor.includes('Delta') ||
                            item.factor.includes('Adjustment');
                          const formatted =
                            item.factor === 'Chance Branches Evaluated'
                              ? `${Math.round(item.delta)}`
                              : isPct
                              ? `${isSigned && item.delta >= 0 ? '+' : ''}${item.delta.toFixed(1)}%`
                              : item.delta >= 0
                              ? `+${item.delta.toFixed(2)}`
                              : item.delta.toFixed(2);
                          return (
                            <div
                              key={item.factor}
                              className="flex items-center justify-between gap-2 text-[10px] font-mono-num text-[#B8A996]"
                            >
                              <span className="truncate">{item.factor}</span>
                              <span
                                className={
                                  item.delta >= 0 ? 'text-[#8FD19E]' : 'text-[#E89B90]'
                                }
                              >
                                {formatted}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ))}
    </div>
  );
};

function getIconLeaderColorClass(
  view: PlayerView,
  playerId: string,
  icon: FunctionalIcon
): string {
  const activePlayers = view.players.filter((p) => !p.eliminated);
  let maxVal = 0;
  for (const p of activePlayers) {
    const val = p.visibleIcons[icon];
    if (val > maxVal) maxVal = val;
  }
  if (maxVal === 0) return 'text-[#F5EFE2]';
  const countAtMax = activePlayers.filter((p) => p.visibleIcons[icon] === maxVal).length;
  const mine = activePlayers.find((p) => p.id === playerId)?.visibleIcons[icon] ?? 0;
  if (mine === maxVal) {
    return countAtMax === 1 ? 'text-[#F6C945] font-bold' : 'text-[#C88A1E] font-semibold';
  }
  return 'text-[#F5EFE2]';
}

export const TabletopView: React.FC<TabletopViewProps> = ({
  view,
  settings,
  aiTraces,
  aiAutoMode = true,
  isAiPaused = false,
  onToggleAiPause,
  onReopenVictory,
  onAction,
  onUpdateSettings,
  onOpenSettings,
  onToggleDebugUnlock,
}) => {
  const settingsLongPressHandlers = useLongPress({
    durationMs: 5000,
    onLongPress: onToggleDebugUnlock,
    onClick: onOpenSettings,
  });
  const [inspectCard, setInspectCard] = useState<CardInstance | null>(null);
  const [inspectStack, setInspectStack] = useState<ColorStack | null>(null);
  const [pileSummary, setPileSummary] = useState<PileSummaryTarget | null>(null);
  const [achievementsWonTarget, setAchievementsWonTarget] =
    useState<AchievementsWonTarget | null>(null);
  const [showJunkModal, setShowJunkModal] = useState(false);
  const [showSpecialModal, setShowSpecialModal] = useState(false);
  const [mobileTab, setMobileTab] = useState<MobileSectionTab>('play');
  const [sidebarTab, setSidebarTab] = useState<'chronicle' | 'ai'>('chronicle');
  const [activeOpponentIdx, setActiveOpponentIdx] = useState(0);
  const [showAchievePicker, setShowAchievePicker] = useState(false);
  const [actionMode, setActionMode] = useState<ActionSelectionMode>('none');
  const [hoveredDogmaColor, setHoveredDogmaColor] = useState<CardColor | null>(null);
  const [setupMeldMode, setSetupMeldMode] = useState(false);
  const [handSortMode, setHandSortMode] = useState<HandSortMode>('newest');
  const [mobileHandCompact, setMobileHandCompact] = useState(false);
  const [pendingMobileConfirm, setPendingMobileConfirm] =
    useState<PendingMobileConfirm | null>(null);
  const [minimizedPromptId, setMinimizedPromptId] = useState<string | null>(null);
  const touchStartRef = useRef<{ x: number; y: number; t: number } | null>(null);
  const compactCarouselRef = useRef<HTMLDivElement | null>(null);
  const carouselScrollTimerRef = useRef<number | null>(null);
  const handSectionRef = useRef<HTMLElement | null>(null);
  const handScrollRef = useRef<HTMLDivElement | null>(null);
  const handDragRef = useRef<{ active: boolean; startX: number; scrollLeft: number; moved: boolean }>({
    active: false,
    startX: 0,
    scrollLeft: 0,
    moved: false,
  });

  const is2v2 = view.variant === '2v2';
  const isAllAI = view.players.every((p) => p.isAI);
  const viewerIdx = view.players.findIndex((p) => p.id === view.viewerId);
  const viewerPublic = viewerIdx >= 0 ? view.players[viewerIdx] : undefined;
  const viewerIsHuman = !viewerPublic?.isAI;

  const displayedHand = useMemo(
    () => sortHandCards(view.viewer.hand, handSortMode),
    [view.viewer.hand, handSortMode]
  );

  useEffect(() => {
    if (
      minimizedPromptId &&
      (!view.pendingPromptForViewer || view.pendingPromptForViewer.id !== minimizedPromptId)
    ) {
      setMinimizedPromptId(null);
    }
  }, [minimizedPromptId, view.pendingPromptForViewer]);

  const isPromptMinimized =
    Boolean(view.pendingPromptForViewer) &&
    view.pendingPromptForViewer?.id === minimizedPromptId;

  const isSetupMeldReady =
    view.phase === 'setup' &&
    view.pendingPromptForViewer?.kind === 'setup_meld' &&
    viewerIsHuman;

  useEffect(() => {
    setSetupMeldMode(false);
    setPendingMobileConfirm(null);
  }, [isSetupMeldReady, view.viewerId]);

  const isViewerTurn =
    view.phase === 'playing' &&
    view.currentPlayerId === view.viewerId &&
    !view.pendingPromptForViewer &&
    view.waitingOnPlayerId === null;

  const canActOnTurn = isViewerTurn && view.actionsRemaining > 0 && viewerIsHuman;
  const canManualEndTurn =
    !settings.autoEndTurn &&
    view.phase === 'playing' &&
    view.actionsRemaining === 0 &&
    !view.pendingPromptForViewer &&
    view.waitingOnPlayerId === null &&
    ((viewerIsHuman && view.currentPlayerId === view.viewerId) || (isAllAI && !aiAutoMode));

  useEffect(() => {
    if (!canActOnTurn) {
      setActionMode('none');
      setShowAchievePicker(false);
    }
    setPendingMobileConfirm(null);
  }, [canActOnTurn, view.turnNumber, view.actionsRemaining, view.viewerId]);

  useEffect(() => {
    setPendingMobileConfirm(null);
  }, [actionMode, setupMeldMode]);

  useEffect(() => {
    if (actionMode !== 'dogma' || !canActOnTurn) {
      setHoveredDogmaColor(null);
    }
  }, [actionMode, canActOnTurn]);

  const previewDogmaColor: CardColor | null =
    actionMode === 'dogma' && canActOnTurn
      ? hoveredDogmaColor ??
        (pendingMobileConfirm?.kind === 'dogma' ? pendingMobileConfirm.color : null)
      : null;

  const previewDogmaCard = useMemo(() => {
    if (!previewDogmaColor) return null;
    const cards = view.viewer.board[previewDogmaColor].cards;
    const top = cards.length > 0 ? cards[cards.length - 1] : null;
    return top && top.abilities.length > 0 ? top : null;
  }, [previewDogmaColor, view.viewer.board]);

  const showAiTab = settings.debugUnlocked && settings.debugShowAiDecisions;

  useEffect(() => {
    if (!showAiTab && sidebarTab === 'ai') {
      setSidebarTab('chronicle');
    }
  }, [showAiTab, sidebarTab]);

  const currentPlayerPublic = view.players.find((p) => p.id === view.currentPlayerId);

  const viewerTeamId = view.viewer.teamId;

  const allyPlayer: PublicPlayerView | null =
    is2v2 && viewerIdx >= 0 ? view.players[(viewerIdx + 2) % 4] ?? null : null;
  const enemies2v2: PublicPlayerView[] =
    is2v2 && viewerIdx >= 0
      ? [view.players[(viewerIdx + 1) % 4], view.players[(viewerIdx + 3) % 4]].filter(
          (p): p is PublicPlayerView => Boolean(p)
        )
      : [];

  const opponents: PublicPlayerView[] = is2v2
    ? [allyPlayer, ...enemies2v2].filter((p): p is PublicPlayerView => Boolean(p))
    : view.players.filter((p) => p.id !== view.viewerId);
  const safeOpponentIdx = Math.min(activeOpponentIdx, Math.max(0, opponents.length - 1));

  const getPlayerPanelSurfaceClass = (teamId: string, isActiveTurn: boolean) => {
    if (!is2v2) {
      return isActiveTurn
        ? 'bg-[#2B221B] border-[#C88A1E]'
        : 'bg-[#221B17]/90 border-[#D9C7A3]/18';
    }
    if (teamId === viewerTeamId) {
      return isActiveTurn
        ? 'bg-[#1C2D27] border-[#66B08E]'
        : 'bg-[#18231F]/95 border-[#4D856B]/45';
    }
    return isActiveTurn
      ? 'bg-[#321F23] border-[#C88A1E]'
      : 'bg-[#261A1D]/95 border-[#924E53]/45';
  };

  // Layout mode computation: Horizontal/Desktop vs Vertical/Mobile
  const [viewportSize, setViewportSize] = useState<{ width: number; height: number }>(() =>
    typeof window !== 'undefined'
      ? { width: window.innerWidth, height: window.innerHeight }
      : { width: 1280, height: 800 }
  );
  useEffect(() => {
    const updateSize = () =>
      setViewportSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener('resize', updateSize);
    window.addEventListener('orientationchange', updateSize);
    return () => {
      window.removeEventListener('resize', updateSize);
      window.removeEventListener('orientationchange', updateSize);
    };
  }, []);

  const isLandscapeLayout = computeIsHorizontalView(
    settings.layoutMode,
    viewportSize.width,
    viewportSize.height
  );
  const isNarrowHorizontal = isLandscapeLayout && viewportSize.width < 1024;
  const isCompactCarousel = !isLandscapeLayout && settings.mobileViewMode === 'compact';

  const getCarouselPaneIndex = (tab: MobileSectionTab): number => {
    if (tab === 'supply') return 0;
    if (tab === 'chronicle') return 2;
    return 1;
  };

  const navigateMobileTab = (tab: MobileSectionTab, instant = false) => {
    setMobileTab(tab);
    if (isCompactCarousel && compactCarouselRef.current) {
      const el = compactCarouselRef.current;
      const targetLeft = getCarouselPaneIndex(tab) * el.clientWidth;
      if (instant) {
        el.scrollLeft = targetLeft;
      } else {
        el.scrollTo({ left: targetLeft, behavior: 'smooth' });
      }
    }
  };

  useLayoutEffect(() => {
    if (!isCompactCarousel) return;
    const el = compactCarouselRef.current;
    if (!el) return;
    const idx = getCarouselPaneIndex(mobileTab);
    el.scrollLeft = idx * el.clientWidth;
    // Only snap instantly when entering compact carousel or resizing width
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isCompactCarousel, viewportSize.width]);

  useEffect(() => {
    return () => {
      if (carouselScrollTimerRef.current !== null) {
        window.clearTimeout(carouselScrollTimerRef.current);
      }
    };
  }, []);

  const handleCompactCarouselScroll = () => {
    const el = compactCarouselRef.current;
    if (!el || el.clientWidth <= 0) return;
    if (carouselScrollTimerRef.current !== null) {
      window.clearTimeout(carouselScrollTimerRef.current);
    }
    const syncTab = () => {
      const w = el.clientWidth;
      if (w <= 0) return;
      const idx = Math.max(0, Math.min(2, Math.round(el.scrollLeft / w)));
      const nextTab: MobileSectionTab =
        idx === 0 ? 'supply' : idx === 2 ? 'chronicle' : 'play';
      setMobileTab((prev) => (prev === nextTab ? prev : nextTab));
    };
    const w = el.clientWidth;
    const nearestIdx = Math.max(0, Math.min(2, Math.round(el.scrollLeft / w)));
    if (Math.abs(el.scrollLeft - nearestIdx * w) < 3) {
      syncTab();
    } else {
      carouselScrollTimerRef.current = window.setTimeout(syncTab, 80);
    }
  };

  useEffect(() => {
    setPendingMobileConfirm(null);
  }, [isLandscapeLayout]);

  useEffect(() => {
    if (!isLandscapeLayout && settings.mobileViewMode !== 'large_swipe' && mobileTab === 'opponents') {
      setMobileTab('play');
    }
  }, [isLandscapeLayout, settings.mobileViewMode, mobileTab]);

  const handleTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    if (isLandscapeLayout || isCompactCarousel) return;
    const targetNode = e.target as Node | null;
    if (targetNode && handSectionRef.current?.contains(targetNode)) {
      touchStartRef.current = null;
      return;
    }
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    touchStartRef.current = { x: t.clientX, y: t.clientY, t: Date.now() };
  };

  const handleTouchEnd = (e: React.TouchEvent<HTMLDivElement>) => {
    if (isLandscapeLayout || isCompactCarousel) return;
    const start = touchStartRef.current;
    touchStartRef.current = null;
    if (!start || e.changedTouches.length === 0) return;

    const end = e.changedTouches[0];
    const dx = end.clientX - start.x;
    const dy = end.clientY - start.y;
    const dt = Date.now() - start.t;

    if (dt > 700 || Math.abs(dx) < 48 || Math.abs(dx) < Math.abs(dy) * 1.35) {
      return;
    }

    const useOpponentsTab = settings.mobileViewMode === 'large_swipe';

    if (dx < 0) {
      if (mobileTab === 'play') {
        if (useOpponentsTab) {
          setActiveOpponentIdx(0);
          setMobileTab('opponents');
        } else {
          setMobileTab('supply');
        }
      } else if (mobileTab === 'opponents') {
        if (safeOpponentIdx < opponents.length - 1) {
          setActiveOpponentIdx(safeOpponentIdx + 1);
        } else {
          setMobileTab('supply');
        }
      } else if (mobileTab === 'supply') {
        setMobileTab('chronicle');
      }
    } else {
      if (mobileTab === 'chronicle') {
        setMobileTab('supply');
      } else if (mobileTab === 'supply') {
        if (useOpponentsTab) {
          setActiveOpponentIdx(Math.max(0, opponents.length - 1));
          setMobileTab('opponents');
        } else {
          setMobileTab('play');
        }
      } else if (mobileTab === 'opponents') {
        if (safeOpponentIdx > 0) {
          setActiveOpponentIdx(safeOpponentIdx - 1);
        } else {
          setMobileTab('play');
        }
      }
    }
  };

  const currentMobileViewMeta =
    MOBILE_VIEW_MODES.find((m) => m.value === settings.mobileViewMode) ?? MOBILE_VIEW_MODES[0];

  const handleCycleMobileViewMode = () => {
    const idx = MOBILE_VIEW_MODES.findIndex((m) => m.value === settings.mobileViewMode);
    const next = MOBILE_VIEW_MODES[(idx + 1) % MOBILE_VIEW_MODES.length].value;
    onUpdateSettings({ mobileViewMode: next });
    if (next !== 'large_swipe' && mobileTab === 'opponents') {
      setMobileTab('play');
    }
  };

  const drawAgeTarget = ALL_AGES.find(
    (age) => age >= Math.max(1, view.viewer.highestTopAge) && view.deckCounts[age] > 0
  );

  const eligibleAchieveAges = Array.from(
    new Set(
      view.standardAchievementBacks
        .map((b) => b.age)
        .filter(
          (age) =>
            view.viewer.scoreTotal >= age * 5 && view.viewer.highestTopAge >= age
        )
    )
  ).sort((a, b) => a - b);

  const dogmaReadyColors = ALL_COLORS.filter((color) => {
    const cards = view.viewer.board[color].cards;
    const top = cards.length > 0 ? cards[cards.length - 1] : null;
    return top !== null && top.abilities.length > 0;
  });

  const handleMeldButtonPress = () => {
    if (!canActOnTurn || view.viewer.hand.length === 0) return;
    setShowAchievePicker(false);
    setPendingMobileConfirm(null);
    navigateMobileTab('play');
    setActionMode((prev) => (prev === 'meld' ? 'none' : 'meld'));
  };

  const handleAchieveButtonPress = () => {
    if (!canActOnTurn || eligibleAchieveAges.length === 0) return;
    setActionMode('none');
    setPendingMobileConfirm(null);
    setShowAchievePicker(true);
  };

  const handleDogmaButtonPress = () => {
    if (!canActOnTurn || dogmaReadyColors.length === 0) return;
    setShowAchievePicker(false);
    setPendingMobileConfirm(null);
    navigateMobileTab('play');
    setActionMode((prev) => (prev === 'dogma' ? 'none' : 'dogma'));
  };

  const scrollHandBy = (delta: number) => {
    const el = handScrollRef.current;
    if (!el) return;
    el.scrollBy({ left: delta, behavior: 'smooth' });
  };

  const onHandPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (settings.expandedHand || e.button !== 0) return;
    const el = handScrollRef.current;
    if (!el) return;
    handDragRef.current = {
      active: true,
      startX: e.clientX,
      scrollLeft: el.scrollLeft,
      moved: false,
    };
  };

  const onHandPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const state = handDragRef.current;
    const el = handScrollRef.current;
    if (!state.active || !el) return;
    const dx = e.clientX - state.startX;
    if (Math.abs(dx) > 6) {
      state.moved = true;
    }
    el.scrollLeft = state.scrollLeft - dx;
  };

  const onHandPointerUp = () => {
    handDragRef.current.active = false;
  };

  const isCompactHand = mobileHandCompact;
  const handContainerHeightClass = isCompactHand
    ? settings.expandedHand
      ? 'min-h-[66px] max-h-[180px]'
      : 'h-[66px] sm:h-[70px]'
    : settings.expandedHand
    ? settings.cardSize === 'large'
      ? 'h-[404px] sm:h-[428px]'
      : settings.cardSize === 'medium'
      ? 'h-[372px] sm:h-[396px]'
      : 'h-[346px] sm:h-[364px]'
    : settings.cardSize === 'large'
    ? 'h-[196px] sm:h-[208px]'
    : settings.cardSize === 'medium'
    ? 'h-[180px] sm:h-[190px]'
    : 'h-[168px] sm:h-[178px]';

  const standardAchieveAges: Age[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const availableStandardAgeSet = new Set(view.standardAchievementBacks.map((b) => b.age));

  const sortedSpecialAchievements = useMemo(
    () => getSortedSpecialAchievements(view.availableSpecialAchievements, view.players),
    [view.availableSpecialAchievements, view.players]
  );

  const renderSupplySectionContent = (inlineSpecials = false) => (
    <div className={inlineSpecials ? 'space-y-2' : 'space-y-2.5'}>
      <div>
        <div className="flex items-center justify-between gap-2">
          <span className="font-display font-semibold text-xs sm:text-sm text-[#F5EFE2]">
            Decks
          </span>
          <button
            type="button"
            onClick={() => setShowJunkModal(true)}
            title="Inspect Junk pile"
            className="min-h-[26px] inline-flex items-center gap-1 rounded border border-[#D9C7A3]/20 bg-[#1C1714] px-2 py-0.5 font-mono-num text-[11px] text-[#E5DAC5] hover:border-[#F6C945] cursor-pointer"
          >
            <Trash2 className="w-3 h-3 text-[#C8B9A6]" />
            <span>{view.junkCount}</span>
          </button>
        </div>

        {/* 11 Age Decks */}
        <div className="mt-1.5 grid grid-cols-6 gap-1">
          {ALL_AGES.map((age) => {
            const count = view.deckCounts[age];
            const isNextDraw = drawAgeTarget === age;
            return (
              <div
                key={age}
                title={`Age ${age}: ${AGE_NAMES[age]} (${count} left)`}
                className={`rounded border px-1 py-0.5 text-center ${
                  isNextDraw
                    ? 'border-[#C88A1E] bg-[#3A2D19]'
                    : count === 0
                    ? 'border-[#D9C7A3]/10 bg-[#1C1714]/50 opacity-45'
                    : 'border-[#D9C7A3]/20 bg-[#1C1714]'
                }`}
              >
                <div className="font-mono-num text-[11px] font-bold text-[#F5EFE2] leading-tight">
                  {age}
                </div>
                <div className="font-mono-num text-[9.5px] text-[#C8B9A6] leading-tight">
                  {count}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Achievements Section (2 rows of 5 for Ages 1..10 + Special button on desktop or inline list on mobile) */}
      <div className="pt-2 border-t border-[#D9C7A3]/15">
        <div className="flex items-center justify-between gap-2">
          <span className="font-display font-semibold text-xs sm:text-sm text-[#F5EFE2]">
            Achievements
          </span>
          {!inlineSpecials && (
            <button
              type="button"
              onClick={() => setShowSpecialModal(true)}
              className="min-h-[26px] rounded border border-[#D9C7A3]/20 bg-[#1C1714] px-2 py-0.5 font-mono-num text-[11px] text-[#E5DAC5] hover:border-[#F6C945] cursor-pointer"
            >
              Special {view.availableSpecialAchievements.length}/5
            </button>
          )}
        </div>

        <div className="mt-1.5 grid grid-cols-5 gap-1">
          {standardAchieveAges.map((age) => {
            const available = availableStandardAgeSet.has(age);
            return (
              <div
                key={age}
                title={
                  available
                    ? `Standard Achievement Age ${age} available`
                    : `Standard Achievement Age ${age} claimed or junked`
                }
                className={`rounded border py-1 text-center font-mono-num text-[11px] font-bold ${
                  available
                    ? 'border-[#D9C7A3]/25 bg-[#1C1714] text-[#F5EFE2]'
                    : 'border-[#D9C7A3]/10 bg-[#1C1714]/35 text-[#6E6053] line-through opacity-45'
                }`}
              >
                {age}
              </div>
            );
          })}
        </div>

        {inlineSpecials && (
          <div className="mt-2 pt-2 border-t border-[#D9C7A3]/15 space-y-1">
            <div className="flex items-center justify-between gap-2">
              <span className="font-display font-semibold text-xs text-[#F5EFE2]">
                Special Achievements
              </span>
              <span className="font-mono-num text-[10.5px] text-[#C8B9A6]">
                {view.availableSpecialAchievements.length}/5 available
              </span>
            </div>
            <div className="space-y-1">
              {sortedSpecialAchievements.map(({ def: sa, available, ownerName }) => (
                <div
                  key={sa.id}
                  data-testid={`inline-special-${sa.id}`}
                  data-available={available ? 'true' : 'false'}
                  className={`rounded border px-2 py-1.5 text-xs ${
                    available
                      ? 'border-[#D9C7A3]/20 bg-[#1C1714]'
                      : 'border-[#D9C7A3]/10 bg-[#1C1714]/40 opacity-50'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 leading-tight">
                    <span
                      className={`font-display font-bold text-xs ${
                        available ? 'text-[#F6C945]' : 'text-[#9E8F7E]'
                      }`}
                    >
                      {sa.name}
                    </span>
                    <span className="font-mono-num text-[10.5px] text-[#C8B9A6] shrink-0">
                      {available
                        ? getSpecialAchievementProgressLabel(view, sa.id)
                        : ownerName
                        ? `Claimed (${ownerName})`
                        : 'Junked'}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[11px] text-[#D9C7A3] leading-tight">
                    {sa.description}
                  </p>
                  <p className="mt-0.5 font-mono-num text-[10px] text-[#B8A996] leading-tight">
                    Card: {sa.altCardName} [{sa.altCardAge}]
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );

  const renderPlayerIconStrip = (
    playerId: string,
    counts: Record<FunctionalIcon, number>,
    size: number
  ) => (
    <div className="flex items-center gap-1.5 sm:gap-2 text-[11px] sm:text-[11.5px] font-mono-num">
      {ALL_FUNCTIONAL_ICONS.map((ic) => {
        let dogmaBoxClass = '';
        if (previewDogmaCard && ic === previewDogmaCard.featuredIcon) {
          const actorCount = view.viewer.visibleIcons[ic];
          const targetCount = counts[ic];
          if (playerId === view.viewerId || targetCount === actorCount) {
            dogmaBoxClass =
              '-mx-[3px] px-[3px] py-[1px] rounded bg-[#EAB308]/18 ring-1 ring-[#EAB308]/65';
          } else if (targetCount > actorCount) {
            dogmaBoxClass =
              '-mx-[3px] px-[3px] py-[1px] rounded bg-[#38BDF8]/20 ring-1 ring-[#7DD3FC]/85';
          } else {
            dogmaBoxClass =
              '-mx-[3px] px-[3px] py-[1px] rounded bg-[#F87171]/22 ring-1 ring-[#FCA5A5]/85';
          }
        }
        return (
          <span
            key={ic}
            title={`${ICON_LABELS[ic]}: ${counts[ic]}`}
            className={`inline-flex items-center gap-0.5 ${getIconLeaderColorClass(
              view,
              playerId,
              ic
            )} ${dogmaBoxClass}`}
          >
            <IconGlyph slot={ic} size={size} />
            <span>{counts[ic]}</span>
          </span>
        );
      })}
    </div>
  );

  const renderMobileSupplyCard = (inCarousel: boolean) => (
    <section
      className={`${
        inCarousel ? 'min-h-full' : 'min-h-[calc(100dvh-3.75rem)] pb-safe'
      } rounded-lg bg-[#221B17]/95 border border-[#D9C7A3]/18 p-2.5`}
    >
      {!settings.mobileNavBar && (
        <div className="flex items-center justify-between gap-2 pb-1.5 mb-2 border-b border-[#D9C7A3]/15">
          {inCarousel ? (
            <>
              <span className="font-display text-sm font-bold text-[#F5EFE2]">
                Decks &amp; Achievements
              </span>
              <button
                type="button"
                onClick={() => navigateMobileTab('play')}
                className="min-h-[28px] px-2 rounded border border-[#D9C7A3]/20 bg-[#1C1714] text-[11px] font-medium text-[#E5DAC5] hover:border-[#F6C945] inline-flex items-center gap-1 cursor-pointer"
              >
                <span>Board</span>
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => navigateMobileTab('play')}
                className="min-h-[28px] px-2 rounded border border-[#D9C7A3]/20 bg-[#1C1714] text-[11px] font-medium text-[#E5DAC5] hover:border-[#F6C945] inline-flex items-center gap-1 cursor-pointer"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
                <span>Board</span>
              </button>
              <button
                type="button"
                onClick={() => navigateMobileTab('chronicle')}
                className="min-h-[28px] px-2.5 rounded border border-[#D9C7A3]/20 bg-[#1C1714] text-[11px] font-mono-num text-[#E5DAC5] hover:border-[#F6C945] cursor-pointer"
              >
                Log
              </button>
            </>
          )}
        </div>
      )}
      {renderSupplySectionContent(true)}
    </section>
  );

  const renderMobileChronicleCard = (inCarousel: boolean) => (
    <section
      className={`${
        inCarousel ? 'min-h-full' : 'min-h-[calc(100dvh-3.75rem)] pb-safe'
      } rounded-lg bg-[#221B17]/95 border border-[#D9C7A3]/20 p-2.5 space-y-2`}
    >
      <div className="flex items-center justify-between gap-2 pb-1.5 border-b border-[#D9C7A3]/15">
        <div className="flex items-center gap-2 min-w-0">
          {!settings.mobileNavBar && (
            <button
              type="button"
              onClick={() => navigateMobileTab('play')}
              className="min-h-[28px] px-2 rounded border border-[#D9C7A3]/20 bg-[#1C1714] text-[11px] font-medium text-[#E5DAC5] hover:border-[#F6C945] inline-flex items-center gap-1 cursor-pointer shrink-0"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
              <span>Board</span>
            </button>
          )}
          <h2 className="font-display text-sm font-bold text-[#F5EFE2] truncate">
            {sidebarTab === 'ai' ? 'AI Decisions' : 'Chronicles'}
          </h2>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {!settings.mobileNavBar && !inCarousel && (
            <button
              type="button"
              onClick={() => navigateMobileTab('supply')}
              className="min-h-[26px] px-2 rounded border border-[#D9C7A3]/20 bg-[#1C1714] font-mono-num text-[11px] text-[#E5DAC5] hover:border-[#F6C945] cursor-pointer text-center shrink-0"
            >
              Decks
            </button>
          )}
          {showAiTab && (
            <button
              type="button"
              onClick={() =>
                setSidebarTab((prev) => (prev === 'chronicle' ? 'ai' : 'chronicle'))
              }
              className="min-h-[26px] w-[88px] rounded border border-[#D9C7A3]/20 bg-[#1C1714] px-2 py-0.5 font-mono-num text-[11px] text-[#E5DAC5] hover:border-[#F6C945] cursor-pointer text-center shrink-0"
            >
              {sidebarTab === 'ai' ? 'Chronicles' : 'AI'}
            </button>
          )}
        </div>
      </div>
      {sidebarTab === 'ai' && showAiTab ? (
        <AIDecisionTraceList
          traces={aiTraces}
          hasHeuristicAI={view.players.some(
            (p) => p.isAI && normalizeAIBackend(p.aiBackend) === 'heuristic'
          )}
        />
      ) : (
        <GroupedChronicle log={view.log} />
      )}
    </section>
  );

  const renderPortraitActionDock = (isFixed: boolean) => (
    <div
      className={`${
        isFixed ? 'fixed bottom-0 left-0 right-0 z-30' : 'shrink-0'
      } bg-[#1C1714] border-t border-[#D9C7A3]/20 px-2 py-1.5 pb-safe`}
    >
      {view.phase === 'gameover' ? (
        <button
          type="button"
          onClick={() => onReopenVictory?.()}
          className="max-w-3xl mx-auto w-full min-h-[40px] rounded-lg border bg-[#C88A1E] border-[#C88A1E] text-[#1C1714] text-xs sm:text-sm font-bold flex items-center justify-center px-3 hover:bg-[#d89928] transition-colors cursor-pointer"
        >
          End Game
        </button>
      ) : isPromptMinimized ? (
        <button
          type="button"
          onClick={() => setMinimizedPromptId(null)}
          className="max-w-3xl mx-auto w-full min-h-[40px] rounded-lg border bg-[#C88A1E] border-[#C88A1E] text-[#1C1714] text-xs sm:text-sm font-bold flex items-center justify-center px-3 hover:bg-[#d89928] transition-colors cursor-pointer"
        >
          Return
        </button>
      ) : view.phase === 'setup' ? (
        <button
          type="button"
          disabled={!isSetupMeldReady}
          onClick={() => {
            if (isSetupMeldReady) setSetupMeldMode((prev) => !prev);
          }}
          aria-pressed={setupMeldMode}
          className={`max-w-3xl mx-auto w-full min-h-[40px] rounded-lg border text-xs sm:text-sm font-bold flex items-center justify-center px-3 transition-colors cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed ${
            setupMeldMode
              ? 'bg-[#F6C945] border-[#FAE078] text-[#1C1714] ring-1 ring-[#FAE078] hover:bg-[#fae078]'
              : 'bg-[#27201B] border-[#D9C7A3]/35 text-[#F5EFE2]'
          }`}
        >
          {isSetupMeldReady
            ? 'Meld Starting Card'
            : isAllAI
            ? 'AI selecting starting melds...'
            : 'Waiting for opponent starting meld...'}
        </button>
      ) : (
        view.phase === 'playing' && (
          <div className="max-w-3xl mx-auto flex items-center gap-1.5">
            <div
              title="Actions remaining"
              className="min-h-[40px] min-w-[42px] rounded-lg border border-[#D9C7A3]/25 bg-[#221B17] px-1.5 flex flex-col items-center justify-center shrink-0"
            >
              <span className="text-[8px] uppercase text-[#C8B9A6] leading-none">Act</span>
              <span className="font-mono-num text-sm font-bold text-[#F6C945] leading-tight">
                {view.actionsRemaining}
              </span>
            </div>

            <div className="flex-1 grid grid-cols-4 gap-1 sm:gap-1.5">
              <button
                type="button"
                disabled={!canActOnTurn}
                onClick={(e) => {
                  e.stopPropagation();
                  if (pendingMobileConfirm?.kind === 'draw') {
                    setPendingMobileConfirm(null);
                    setActionMode('none');
                    setShowAchievePicker(false);
                    onAction({ type: 'draw', playerId: view.viewerId });
                    return;
                  }
                  setActionMode('none');
                  setShowAchievePicker(false);
                  setPendingMobileConfirm({ kind: 'draw' });
                }}
                className={`min-h-[40px] rounded-lg border text-[11px] sm:text-xs font-bold transition-colors px-1 whitespace-nowrap truncate ${
                  pendingMobileConfirm?.kind === 'draw'
                    ? 'bg-[#F6C945] border-[#F5EFE2] text-[#1C1714] ring-2 ring-[#F5EFE2]/70 cursor-pointer'
                    : canActOnTurn
                    ? 'bg-[#C88A1E] border-[#C88A1E] text-[#1C1714] hover:bg-[#d89928] cursor-pointer'
                    : 'bg-[#27201B] border-[#D9C7A3]/15 text-[#7D7061] opacity-50 cursor-not-allowed'
                }`}
              >
                {pendingMobileConfirm?.kind === 'draw'
                  ? 'Confirm'
                  : drawAgeTarget
                  ? `Draw [${drawAgeTarget}]`
                  : 'Draw [12+]'}
              </button>

              <button
                type="button"
                disabled={!canActOnTurn || view.viewer.hand.length === 0}
                onClick={(e) => {
                  e.stopPropagation();
                  handleMeldButtonPress();
                }}
                className={`min-h-[40px] rounded-lg border text-[11px] sm:text-xs font-bold transition-colors px-1 whitespace-nowrap truncate ${
                  actionMode === 'meld' && canActOnTurn
                    ? 'bg-[#F6C945] border-[#FAE078] text-[#1C1714] ring-1 ring-[#FAE078] hover:bg-[#fae078] cursor-pointer'
                    : canActOnTurn && view.viewer.hand.length > 0
                    ? 'bg-[#C88A1E] border-[#C88A1E] text-[#1C1714] hover:bg-[#d89928] cursor-pointer'
                    : 'bg-[#27201B] border-[#D9C7A3]/15 text-[#7D7061] opacity-50 cursor-not-allowed'
                }`}
              >
                {actionMode === 'meld' ? 'Cancel' : 'Meld'}
              </button>

              <button
                type="button"
                disabled={!canActOnTurn || dogmaReadyColors.length === 0}
                onClick={(e) => {
                  e.stopPropagation();
                  handleDogmaButtonPress();
                }}
                className={`min-h-[40px] rounded-lg border text-[11px] sm:text-xs font-bold transition-colors px-1 whitespace-nowrap truncate ${
                  actionMode === 'dogma' && canActOnTurn
                    ? 'bg-[#F6C945] border-[#FAE078] text-[#1C1714] ring-1 ring-[#FAE078] hover:bg-[#fae078] cursor-pointer'
                    : canActOnTurn && dogmaReadyColors.length > 0
                    ? 'bg-[#C88A1E] border-[#C88A1E] text-[#1C1714] hover:bg-[#d89928] cursor-pointer'
                    : 'bg-[#27201B] border-[#D9C7A3]/15 text-[#7D7061] opacity-50 cursor-not-allowed'
                }`}
              >
                {actionMode === 'dogma' ? 'Cancel' : 'Dogma'}
              </button>

              <button
                type="button"
                disabled={!canActOnTurn || eligibleAchieveAges.length === 0}
                onClick={(e) => {
                  e.stopPropagation();
                  if (pendingMobileConfirm?.kind === 'achieve') {
                    setPendingMobileConfirm(null);
                    handleAchieveButtonPress();
                    return;
                  }
                  setActionMode('none');
                  setShowAchievePicker(false);
                  setPendingMobileConfirm({ kind: 'achieve' });
                }}
                className={`min-h-[40px] rounded-lg border text-[11px] sm:text-xs font-bold transition-colors px-1 whitespace-nowrap truncate ${
                  pendingMobileConfirm?.kind === 'achieve'
                    ? 'bg-[#F6C945] border-[#F5EFE2] text-[#1C1714] ring-2 ring-[#F5EFE2]/70 cursor-pointer'
                    : canActOnTurn && eligibleAchieveAges.length > 0
                    ? 'bg-[#E5B34B] border-[#F4CC75] text-[#1C1714] hover:bg-[#EFC364] cursor-pointer'
                    : 'bg-[#27201B] border-[#D9C7A3]/20 text-[#9E8F7E] opacity-60 cursor-not-allowed'
                }`}
              >
                {pendingMobileConfirm?.kind === 'achieve' ? 'Confirm' : 'Achieve'}
              </button>
            </div>

            {isAllAI && aiAutoMode ? (
              <button
                type="button"
                aria-label={isAiPaused ? 'Resume AI' : 'Pause AI'}
                title={isAiPaused ? 'Resume AI' : 'Pause AI'}
                onClick={() => onToggleAiPause?.()}
                className="min-h-[40px] min-w-[42px] rounded-lg border bg-[#C88A1E] border-[#C88A1E] text-[#1C1714] hover:bg-[#d89928] flex items-center justify-center shrink-0 transition-colors cursor-pointer"
              >
                {isAiPaused ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}
              </button>
            ) : (
              <button
                type="button"
                disabled={!canManualEndTurn}
                aria-label="End Turn"
                title="End Turn"
                onClick={() => {
                  setActionMode('none');
                  setShowAchievePicker(false);
                  onAction({ type: 'end_turn', playerId: view.currentPlayerId });
                }}
                className={`min-h-[40px] min-w-[42px] rounded-lg border flex items-center justify-center shrink-0 transition-colors ${
                  canManualEndTurn
                    ? 'bg-[#E5B34B] border-[#F4CC75] text-[#1C1714] hover:bg-[#EFC364] cursor-pointer'
                    : 'bg-[#27201B] border-[#D9C7A3]/20 text-[#9E8F7E] opacity-60 cursor-not-allowed'
                }`}
              >
                <ArrowRight className="w-4 h-4" />
              </button>
            )}
          </div>
        )
      )}
    </div>
  );

  return (
    <div
      onClick={() => {
        if (pendingMobileConfirm) {
          setPendingMobileConfirm(null);
        }
      }}
      className={`${
        isLandscapeLayout || isCompactCarousel ? 'h-[100dvh] overflow-hidden' : 'min-h-screen'
      } bg-archival-table text-[#F5EFE2] flex flex-col`}
    >
      {/* Compact Top HUD */}
      <header className="sticky top-0 z-30 bg-[#1C1714] border-b border-[#D9C7A3]/15 px-safe sm:px-5 h-10 sm:h-12 flex items-center justify-between gap-2 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <div className="min-w-0 flex flex-col sm:flex-row sm:items-baseline sm:gap-2.5">
            <div className="font-display text-sm sm:text-[15px] font-bold truncate leading-tight">
              {!isLandscapeLayout
                ? view.phase === 'setup'
                  ? `Setup - ${currentPlayerPublic?.name}`
                  : `T${view.turnNumber} - ${currentPlayerPublic?.name}`
                : view.phase === 'setup'
                ? `Setup · ${currentPlayerPublic?.name}`
                : `Turn ${view.turnNumber} · ${currentPlayerPublic?.name}`}
            </div>
            {isLandscapeLayout && (
              <div className="text-[11px] text-[#C8B9A6] font-mono-num truncate leading-tight">
                {view.phase === 'setup'
                  ? 'Setup Meld'
                  : view.waitingOnPlayerId && view.waitingOnPlayerId !== view.viewerId
                  ? `Resolving ${view.players.find((p) => p.id === view.waitingOnPlayerId)?.name ?? 'opponent'}…`
                  : `${view.actionsRemaining} act left · Goal ${view.achievementTarget}`}
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {!isLandscapeLayout && (
            <button
              type="button"
              onClick={handleCycleMobileViewMode}
              aria-label={`Switch mobile layout view (current: ${currentMobileViewMeta.label})`}
              title={currentMobileViewMeta.title}
              className="min-h-[30px] sm:min-h-[34px] w-[86px] sm:w-[92px] px-1.5 rounded-md border border-[#D9C7A3]/20 text-xs font-medium inline-flex items-center justify-center gap-1 hover:bg-[#F5EFE2]/10 cursor-pointer shrink-0"
            >
              <Eye className="w-3.5 h-3.5 text-[#F6C945] shrink-0" />
              <span className="font-mono-num text-[11px]">{currentMobileViewMeta.label}</span>
            </button>
          )}
          <button
            type="button"
            {...settingsLongPressHandlers}
            aria-label="Settings"
            title="Settings"
            className="min-h-[30px] min-w-[30px] sm:min-h-[34px] sm:min-w-[34px] px-1.5 sm:px-2 rounded-md border border-[#D9C7A3]/20 text-xs font-medium inline-flex items-center justify-center hover:bg-[#F5EFE2]/10 cursor-pointer select-none"
          >
            <SettingsIcon className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* Portrait Mode Tab Switcher */}
      {!isLandscapeLayout && settings.mobileNavBar && (
        <nav
          aria-label="Tabletop Sections"
          className={`sticky top-10 sm:top-12 z-30 bg-[#1C1714] border-b border-[#D9C7A3]/15 px-2 py-0.5 grid ${
            settings.mobileViewMode === 'large_swipe' ? 'grid-cols-4' : 'grid-cols-3'
          } gap-1 shrink-0`}
        >
          {(settings.mobileViewMode === 'large_swipe'
            ? ([
                { id: 'play', label: 'Play' },
                { id: 'opponents', label: `Rivals (${opponents.length})` },
                { id: 'supply', label: 'Decks' },
                { id: 'chronicle', label: 'Log' },
              ] as const)
            : isCompactCarousel
            ? ([
                { id: 'supply', label: 'Decks' },
                { id: 'play', label: 'Play' },
                { id: 'chronicle', label: 'Log' },
              ] as const)
            : ([
                { id: 'play', label: 'Play' },
                { id: 'supply', label: 'Decks' },
                { id: 'chronicle', label: 'Log' },
              ] as const)
          ).map((tab) => {
            const active =
              settings.mobileViewMode !== 'large_swipe' && mobileTab === 'opponents'
                ? tab.id === 'play'
                : mobileTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => navigateMobileTab(tab.id)}
                className={`min-h-[32px] rounded-md text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap truncate px-1.5 ${
                  active
                    ? 'bg-[#C88A1E] text-[#1C1714]'
                    : 'bg-[#27201B] text-[#D9C7A3] hover:text-[#F5EFE2]'
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </nav>
      )}

      {/* Main Arena (3-pane CSS Scroll-Snap Carousel in Compact mobile mode; standard layout otherwise) */}
      <div
        ref={isCompactCarousel ? compactCarouselRef : undefined}
        data-testid={isCompactCarousel ? 'compact-mobile-carousel' : undefined}
        onScroll={isCompactCarousel ? handleCompactCarouselScroll : undefined}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        className={
          isCompactCarousel
            ? 'flex-1 min-h-0 w-full flex flex-row overflow-x-auto snap-x snap-mandatory scroll-smooth'
            : `flex-1 min-h-0 max-w-[2360px] w-full mx-auto ${
                isLandscapeLayout
                  ? is2v2 || opponents.length > 1
                    ? 'px-2 lg:px-3 min-[1920px]:px-5 py-1.5 pb-2 flex flex-row gap-1.5'
                    : 'px-3 sm:px-4 min-[1920px]:px-6 py-2 pb-2 flex flex-row gap-2.5'
                  : mobileTab === 'supply' || mobileTab === 'chronicle'
                  ? 'px-1.5 sm:px-3 py-1 pb-2 flex flex-col gap-1.5'
                  : 'px-1.5 sm:px-3 py-1 pb-16 flex flex-col gap-1.5'
              }`
        }
      >
        {/* Compact Carousel Pane 0 (Left): Decks & Inline Special Achievements */}
        {isCompactCarousel && (
          <div
            data-testid="carousel-pane-supply"
            className="w-full shrink-0 snap-start snap-always h-full overflow-y-auto px-1.5 sm:px-3 py-1 pb-safe"
          >
            {renderMobileSupplyCard(true)}
          </div>
        )}

        {/* Left/Center Playfield Column (Pane 1 in Compact Carousel) */}
        <div
          data-testid={isCompactCarousel ? 'carousel-pane-play' : undefined}
          className={
            isCompactCarousel
              ? 'w-full shrink-0 snap-start snap-always h-full flex flex-col min-h-0'
              : 'flex-1 min-w-0 flex flex-col gap-1 min-h-0'
          }
        >
          <div
            className={
              isCompactCarousel
                ? 'flex-1 min-h-0 overflow-y-auto px-1.5 sm:px-3 py-1 space-y-1.5'
                : `flex-1 min-h-0 ${isLandscapeLayout ? 'overflow-y-auto' : ''} space-y-1.5`
            }
          >
            {/* Portrait Decks Tab (non-carousel mobile modes) */}
            {!isLandscapeLayout && !isCompactCarousel && mobileTab === 'supply' &&
              renderMobileSupplyCard(false)}

            {(() => {
              const isTwoLineHeader = !isLandscapeLayout || is2v2;
              const isMobileInSixthSlot = !isLandscapeLayout;

              const renderMobileSupplyLogPair = (heightClass: string) => (
                <div className="grid grid-cols-2 gap-1 min-w-0">
                  <button
                    type="button"
                    onClick={() => navigateMobileTab('supply')}
                    className={`${heightClass} w-full min-w-0 px-1 rounded border border-[#D9C7A3]/20 bg-[#1C1714] font-mono-num text-[10.5px] text-[#E5DAC5] hover:border-[#F6C945] cursor-pointer text-center truncate`}
                    title="View Decks & Achievements"
                  >
                    Decks
                  </button>
                  <button
                    type="button"
                    onClick={() => navigateMobileTab('chronicle')}
                    className={`${heightClass} w-full min-w-0 px-1 rounded border border-[#D9C7A3]/20 bg-[#1C1714] font-mono-num text-[10.5px] text-[#E5DAC5] hover:border-[#F6C945] cursor-pointer text-center truncate`}
                    title="View Match Log"
                  >
                    Log
                  </button>
                </div>
              );

              const renderOtherPlayerCard = (
                opp: PublicPlayerView,
                useUltraCompact: boolean,
                useBoardCompact = false
              ) => {
                const isOppTurn = opp.id === view.currentPlayerId && view.phase === 'playing';
                const oppHighlights = view.lastTurnActionsByPlayer[opp.id] ?? [];
                const drewLastTurn =
                  settings.highlightOpponentLastTurn &&
                  oppHighlights.some((h) => h.kind === 'draw');
                const achievedLastTurn =
                  settings.highlightOpponentLastTurn &&
                  oppHighlights.some((h) => h.kind === 'achieve');

                const useSixthSlotMobile = !isLandscapeLayout;
                const btnSizingClass = useSixthSlotMobile
                  ? 'h-[25px] min-h-[25px] py-0 leading-none w-full min-w-0 px-1 text-[10.5px] truncate'
                  : 'min-h-[26px] min-w-[66px] py-0.5 px-2 text-[11px]';

                const scoreBtn = (
                  <button
                    type="button"
                    onClick={() =>
                      setPileSummary({
                        title: `${opp.name}'s Score Pile`,
                        subtitle: opp.revealedScoreCards
                          ? `${opp.scoreCount} cards · ${opp.scoreTotal} points total (${isAllAI ? 'Revealed' : 'Debug Revealed'})`
                          : `${opp.scoreCount} cards · ${opp.scoreTotal} points total (only Age backs visible)`,
                        backs: opp.revealedScoreCards ? undefined : opp.scoreBacks,
                        cards: opp.revealedScoreCards,
                      })
                    }
                    className={`${btnSizingClass} rounded border border-[#D9C7A3]/20 bg-[#1C1714] font-mono-num text-[#E5DAC5] hover:border-[#F6C945] cursor-pointer text-center`}
                  >
                    Score {opp.scoreTotal}
                  </button>
                );

                const achBtn = (
                  <button
                    type="button"
                    onClick={() =>
                      setAchievementsWonTarget({
                        playerName: opp.name,
                        achievementTarget: view.achievementTarget,
                        achievements: opp.achievementBacks,
                      })
                    }
                    className={`${
                      useSixthSlotMobile
                        ? 'h-[25px] min-h-[25px] py-0 leading-none w-full min-w-0 px-1 text-[10.5px] truncate'
                        : 'min-h-[26px] min-w-[56px] py-0.5 px-2 text-[11px]'
                    } rounded border bg-[#1C1714] font-mono-num text-[#E5DAC5] hover:border-[#F6C945] cursor-pointer text-center ${
                      achievedLastTurn ? 'border-[#E5B842]/55' : 'border-[#D9C7A3]/20'
                    }`}
                  >
                    {isTwoLineHeader
                      ? `Ach ${opp.achievementCount}`
                      : `Ach ${opp.achievementCount}/${view.achievementTarget}`}
                  </button>
                );

                const handBtn = (
                  <button
                    type="button"
                    onClick={() =>
                      setPileSummary({
                        title: `${opp.name}'s Hand`,
                        subtitle: opp.revealedHandCards
                          ? `${opp.handCount} cards (${isAllAI ? 'Revealed' : 'Debug Revealed'})`
                          : `${opp.handCount} cards (only Age backs visible)`,
                        backs: opp.revealedHandCards ? undefined : opp.handBacks,
                        cards: opp.revealedHandCards,
                      })
                    }
                    className={`${
                      useSixthSlotMobile
                        ? 'h-[25px] min-h-[25px] py-0 leading-none w-full min-w-0 px-1.5 text-[10.5px] truncate text-center'
                        : 'min-h-[26px] py-0.5 px-2 text-[11px]'
                    } rounded border bg-[#1C1714] font-mono-num text-[#E5DAC5] hover:border-[#F6C945] cursor-pointer ${
                      drewLastTurn ? 'border-[#E5B842]/55' : 'border-[#D9C7A3]/20'
                    }`}
                  >
                    H {opp.handCount}
                    {opp.handCount > 0 ? `: ${formatAgeCountsCompact(opp.handBacks)}` : ''}
                  </button>
                );

                return (
                  <div
                    key={opp.id}
                    data-testid={`player-board-${opp.id}`}
                    data-team={opp.teamId}
                    className={`rounded-lg border ${
                      !isLandscapeLayout
                        ? 'px-1.5 py-1 space-y-1'
                        : useUltraCompact
                        ? 'px-1.5 py-1 space-y-1'
                        : 'px-2.5 py-1.5 space-y-1.5'
                    } ${getPlayerPanelSurfaceClass(opp.teamId, isOppTurn)}`}
                  >
                    {isTwoLineHeader ? (
                      <div className="flex flex-col gap-1">
                        <div className="flex items-center justify-between gap-2 min-w-0">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <h2 className="font-display text-sm font-bold text-[#F5EFE2] truncate">
                              {opp.name}
                            </h2>
                            {opp.isAI && (
                              <span className="text-[10.5px] font-mono-num text-[#C8B9A6] shrink-0">
                                AI
                              </span>
                            )}
                          </div>
                          {renderPlayerIconStrip(
                            opp.id,
                            opp.visibleIcons,
                            isLandscapeLayout && is2v2 ? 13 : 12
                          )}
                        </div>
                        {(isLandscapeLayout || !useBoardCompact) && (
                          <div
                            className={`${
                              !isLandscapeLayout ? 'hidden sm:flex' : 'flex'
                            } flex-wrap items-center gap-1.5 min-w-0`}
                          >
                            {scoreBtn}
                            {achBtn}
                            {handBtn}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
                          <div className="lg:w-[152px] shrink-0 flex items-center gap-1.5 min-w-0">
                            <h2 className="font-display text-sm font-bold text-[#F5EFE2] truncate">
                              {opp.name}
                            </h2>
                            {opp.isAI && (
                              <span className="text-[10.5px] font-mono-num text-[#C8B9A6] shrink-0">
                                AI
                              </span>
                            )}
                          </div>
                          {scoreBtn}
                          {achBtn}
                          {handBtn}
                        </div>
                        {renderPlayerIconStrip(opp.id, opp.visibleIcons, 13)}
                      </div>
                    )}

                    {/* Opponent 5 Color Stacks */}
                    <div
                      className={`grid ${
                        isLandscapeLayout
                          ? `grid-cols-5 ${useUltraCompact ? 'gap-0.5' : 'gap-1'}`
                          : useBoardCompact
                          ? 'grid-cols-2 gap-1'
                          : 'grid-cols-2 sm:grid-cols-5 gap-1'
                      }`}
                    >
                      {ALL_COLORS.map((color) => {
                        const stackHighlighted =
                          settings.highlightOpponentLastTurn &&
                          oppHighlights.some(
                            (h) => (h.kind === 'meld' || h.kind === 'dogma') && h.color === color
                          );
                        return (
                          <ColorStackView
                            key={color}
                            stack={opp.board[color]}
                            ultraCompact={useUltraCompact}
                            boardCompact={useBoardCompact}
                            colorBlindMode={settings.colorBlindMode}
                            cardSize={settings.cardSize}
                            highlightBorder={stackHighlighted}
                            onInspectStack={(st) => setInspectStack(st)}
                          />
                        );
                      })}
                      {useBoardCompact && (
                        <div className="h-[56px] flex flex-col justify-between gap-1 min-w-0">
                          <div className="grid grid-cols-2 gap-1 min-w-0">
                            {scoreBtn}
                            {achBtn}
                          </div>
                          {handBtn}
                        </div>
                      )}
                      {!isLandscapeLayout && !useBoardCompact && (
                        <div className="flex sm:hidden flex-col justify-center gap-1 min-w-0">
                          <div className="grid grid-cols-2 gap-1 min-w-0">
                            {scoreBtn}
                            {achBtn}
                          </div>
                          {handBtn}
                          {renderMobileSupplyLogPair('h-[25px] min-h-[25px]')}
                        </div>
                      )}
                    </div>
                  </div>
                );
              };

              // Clockwise 2v2 desktop seating from bottom-left:
              // BL = Viewer (i), TL = i+1, TR = i+2 (Ally), BR = i+3
              const nextClockwise1 =
                is2v2 && viewerIdx >= 0 ? view.players[(viewerIdx + 1) % 4] : null;
              const nextClockwise2 =
                is2v2 && viewerIdx >= 0 ? view.players[(viewerIdx + 2) % 4] : null;
              const nextClockwise3 =
                is2v2 && viewerIdx >= 0 ? view.players[(viewerIdx + 3) % 4] : null;

              const visibleTopOpponents = isLandscapeLayout
                ? is2v2
                  ? [nextClockwise1, nextClockwise2].filter(
                      (p): p is PublicPlayerView => Boolean(p)
                    )
                  : opponents
                : opponents;

              const isCombinedMobileView =
                isCompactCarousel ||
                (!isLandscapeLayout &&
                  settings.mobileViewMode !== 'large_swipe' &&
                  (mobileTab === 'play' || mobileTab === 'opponents'));

              const isMobilePlayView =
                isCompactCarousel ||
                (!isLandscapeLayout &&
                  (mobileTab === 'play' ||
                    (settings.mobileViewMode !== 'large_swipe' && mobileTab === 'opponents')));

              const isCompactViewerBoard =
                !isLandscapeLayout && settings.mobileViewMode === 'compact';

              const viewerScoreBtn = (
                <button
                  type="button"
                  onClick={() =>
                    setPileSummary({
                      title: `${view.viewer.name}'s Score Pile`,
                      subtitle: `${view.viewer.scorePile.length} cards · ${view.viewer.scoreTotal} points total`,
                      cards: view.viewer.scorePile,
                    })
                  }
                  className={`${
                    isMobileInSixthSlot
                      ? 'h-[25px] min-h-[25px] py-0 leading-none w-full min-w-0 px-1 text-[10.5px] truncate'
                      : 'min-h-[26px] min-w-[66px] py-0.5 px-2 text-[11px]'
                  } inline-flex items-center justify-center rounded border border-[#D9C7A3]/20 bg-[#1C1714] font-mono-num text-[#E5DAC5] hover:border-[#F6C945] cursor-pointer`}
                  title="Inspect your score pile"
                >
                  <span>Score {view.viewer.scoreTotal}</span>
                </button>
              );

              const viewerAchBtn = (
                <button
                  type="button"
                  onClick={() =>
                    setAchievementsWonTarget({
                      playerName: view.viewer.name,
                      achievementTarget: view.achievementTarget,
                      achievements: view.viewer.achievements,
                    })
                  }
                  className={`${
                    isMobileInSixthSlot
                      ? 'h-[25px] min-h-[25px] py-0 leading-none w-full min-w-0 px-1 text-[10.5px] truncate'
                      : 'min-h-[26px] min-w-[56px] py-0.5 px-2 text-[11px]'
                  } inline-flex items-center justify-center rounded border border-[#D9C7A3]/20 bg-[#1C1714] font-mono-num text-[#E5DAC5] hover:border-[#F6C945] cursor-pointer`}
                  title="Inspect claimed achievements"
                >
                  <span>
                    {isTwoLineHeader
                      ? `Ach ${view.viewer.achievements.length}`
                      : `Ach ${view.viewer.achievements.length}/${view.achievementTarget}`}
                  </span>
                </button>
              );

              const viewerHandBtn = isAllAI ? (
                <button
                  type="button"
                  onClick={() =>
                    setPileSummary({
                      title: `${view.viewer.name}'s Hand`,
                      subtitle: `${view.viewer.hand.length} cards (Revealed)`,
                      cards: view.viewer.hand,
                    })
                  }
                  className={`${
                    isMobileInSixthSlot
                      ? 'h-[25px] min-h-[25px] py-0 leading-none w-full min-w-0 px-1.5 text-[10.5px] truncate text-center'
                      : 'min-h-[26px] py-0.5 px-2 text-[11px]'
                  } rounded border border-[#D9C7A3]/20 bg-[#1C1714] font-mono-num text-[#E5DAC5] hover:border-[#F6C945] cursor-pointer`}
                  title={`Inspect ${view.viewer.name}'s hand`}
                >
                  H {view.viewer.hand.length}
                  {view.viewer.hand.length > 0
                    ? `: ${formatAgeCountsCompact(view.viewer.hand)}`
                    : ''}
                </button>
              ) : null;

              return (
                <>
                  {/* Desktop Top Opponents OR Mobile Large Swipe Rivals Tab */}
                  {(isLandscapeLayout ||
                    (settings.mobileViewMode === 'large_swipe' && mobileTab === 'opponents')) && (
                    <section
                      className={`grid grid-cols-1 ${
                        isLandscapeLayout && visibleTopOpponents.length > 1
                          ? 'grid-cols-2 gap-1.5'
                          : 'gap-1.5'
                      }`}
                      aria-label="Opponents"
                    >
                      {!isLandscapeLayout && (
                        <div className="flex items-center gap-1.5">
                          {!settings.mobileNavBar && (
                            <button
                              type="button"
                              onClick={() => setMobileTab('play')}
                              className="min-h-[32px] px-2 rounded-md border border-[#D9C7A3]/20 bg-[#27201B] text-xs font-medium text-[#E5DAC5] hover:border-[#F6C945] inline-flex items-center gap-1 cursor-pointer shrink-0"
                            >
                              <ChevronLeft className="w-3.5 h-3.5" />
                              <span>Board</span>
                            </button>
                          )}
                          {visibleTopOpponents.length > 1 &&
                            visibleTopOpponents.map((opp, idx) => (
                              <button
                                key={opp.id}
                                type="button"
                                onClick={() => setActiveOpponentIdx(idx)}
                                className={`flex-1 min-h-[32px] rounded-md px-2 text-xs font-semibold border transition-colors cursor-pointer truncate ${
                                  idx === safeOpponentIdx
                                    ? 'bg-[#C88A1E] text-[#1C1714] border-[#C88A1E]'
                                    : 'bg-[#27201B] text-[#D9C7A3] border-[#D9C7A3]/20'
                                }`}
                              >
                                {opp.name}
                              </button>
                            ))}
                        </div>
                      )}

                      {visibleTopOpponents.map((opp, idx) => {
                        if (!isLandscapeLayout && idx !== safeOpponentIdx) return null;
                        return renderOtherPlayerCard(
                          opp,
                          isLandscapeLayout && (is2v2 || visibleTopOpponents.length > 1 || isNarrowHorizontal),
                          false
                        );
                      })}
                    </section>
                  )}

                  {/* Mobile Compact or Large Vertical All-Opponents Section (above your board) */}
                  {isCombinedMobileView && opponents.length > 0 && (
                    <section className="space-y-1" aria-label="Opponents">
                      {opponents.map((opp) =>
                        renderOtherPlayerCard(
                          opp,
                          false,
                          settings.mobileViewMode === 'compact'
                        )
                      )}
                    </section>
                  )}

                  {/* Compact Opponent Summary Strip on Mobile Large Swipe Play Tab */}
                  {!isLandscapeLayout &&
                    settings.mobileViewMode === 'large_swipe' &&
                    mobileTab === 'play' &&
                    opponents.length > 0 && (
                      <section className="space-y-1">
                        {opponents.map((opp, idx) => (
                          <button
                            key={opp.id}
                            type="button"
                            onClick={() => {
                              setActiveOpponentIdx(idx);
                              setMobileTab('opponents');
                            }}
                            className={`w-full text-left rounded-lg border px-2 py-1 cursor-pointer space-y-0.5 ${getPlayerPanelSurfaceClass(
                              opp.teamId,
                              opp.id === view.currentPlayerId && view.phase === 'playing'
                            )}`}
                          >
                            <div className="flex items-center justify-between gap-2 min-w-0">
                              <strong className="font-sans text-xs text-[#F5EFE2] truncate">
                                {opp.name}
                              </strong>
                              {renderPlayerIconStrip(opp.id, opp.visibleIcons, 12)}
                            </div>
                            <div className="font-mono-num text-[10.5px] text-[#C8B9A6] leading-tight">
                              Score {opp.scoreTotal} ·{' '}
                              <span className="text-[#E5DAC5]">Ach {opp.achievementCount}</span> · H{' '}
                              {opp.handCount}
                            </div>
                          </button>
                        ))}
                      </section>
                    )}

                  {/* Active Viewer (and Ally side-by-side in Desktop 2v2) + Hand */}
                  {(isLandscapeLayout || isMobilePlayView) && (
                    <div className="space-y-1">
                      <div
                        className={
                          isLandscapeLayout && is2v2 && nextClockwise3
                            ? 'grid grid-cols-2 gap-1.5'
                            : 'space-y-1'
                        }
                      >
                        {/* Viewer Board Panel (Bottom-Left in 2v2 Desktop) */}
                        {(() => {
                          const isCompactMobile = isCompactViewerBoard;
                          const isViewerUltraCompact =
                            isLandscapeLayout && (is2v2 || isNarrowHorizontal);
                          return (
                            <section
                              data-testid={`player-board-${view.viewer.id}`}
                              data-team={viewerTeamId}
                              className={`rounded-lg border ${
                                !isLandscapeLayout
                                  ? 'px-1.5 py-1 space-y-1'
                                  : isViewerUltraCompact
                                  ? 'px-1.5 py-1 space-y-1'
                                  : 'px-2.5 py-1.5 space-y-1.5'
                              } ${getPlayerPanelSurfaceClass(
                                viewerTeamId,
                                view.currentPlayerId === view.viewer.id && view.phase === 'playing'
                              )}`}
                              aria-label="Your Civilization"
                            >
                              {isTwoLineHeader ? (
                                <div className="flex flex-col gap-1">
                                  <div className="flex items-center justify-between gap-2 min-w-0">
                                    <div className="flex items-center gap-1.5 min-w-0">
                                      <h2 className="font-display text-sm sm:text-[15px] font-bold text-[#F5EFE2] truncate">
                                        {view.viewer.name}
                                      </h2>
                                      {viewerPublic?.isAI && (
                                        <span className="text-[10.5px] font-mono-num text-[#C8B9A6] shrink-0">
                                          AI
                                        </span>
                                      )}
                                    </div>
                                    {renderPlayerIconStrip(
                                      view.viewer.id,
                                      view.viewer.visibleIcons,
                                      isLandscapeLayout && is2v2 ? 13 : 12
                                    )}
                                  </div>
                                  {(isLandscapeLayout || !isCompactMobile) && (
                                    <div
                                      className={`${
                                        !isLandscapeLayout ? 'hidden sm:flex' : 'flex'
                                      } flex-wrap items-center gap-1.5 min-w-0`}
                                    >
                                      {viewerScoreBtn}
                                      {viewerAchBtn}
                                      {viewerHandBtn}
                                    </div>
                                  )}
                                </div>
                              ) : (
                                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
                                    <div className="lg:w-[152px] shrink-0 flex items-center gap-1.5 min-w-0">
                                      <h2 className="font-display text-sm sm:text-[15px] font-bold text-[#F5EFE2] truncate">
                                        {view.viewer.name}
                                      </h2>
                                      {viewerPublic?.isAI && (
                                        <span className="text-[10.5px] font-mono-num text-[#C8B9A6] shrink-0">
                                          AI
                                        </span>
                                      )}
                                    </div>
                                    {viewerScoreBtn}
                                    {viewerAchBtn}
                                    {viewerHandBtn}
                                  </div>
                                  {renderPlayerIconStrip(
                                    view.viewer.id,
                                    view.viewer.visibleIcons,
                                    14
                                  )}
                                </div>
                              )}

                              {/* Viewer 5 Color Stacks */}
                              <div
                                className={`grid ${
                                  isLandscapeLayout
                                    ? `grid-cols-5 ${isViewerUltraCompact ? 'gap-0.5' : 'gap-1'}`
                                    : isCompactMobile
                                    ? 'grid-cols-2 gap-1'
                                    : 'grid-cols-2 sm:grid-cols-5 gap-1'
                                }`}
                              >
                                {ALL_COLORS.map((color) => {
                                  const top =
                                    view.viewer.board[color].cards[
                                      view.viewer.board[color].cards.length - 1
                                    ] ?? null;
                                  const canDogma =
                                    canActOnTurn && top !== null && top.abilities.length > 0;
                                  const isConfirmingDogma =
                                    !isLandscapeLayout &&
                                    actionMode === 'dogma' &&
                                    pendingMobileConfirm?.kind === 'dogma' &&
                                    pendingMobileConfirm.color === color;
                                  return (
                                    <ColorStackView
                                      key={color}
                                      stack={view.viewer.board[color]}
                                      ultraCompact={isViewerUltraCompact}
                                      boardCompact={isCompactMobile}
                                      canDogma={canDogma}
                                      dogmaSelectMode={actionMode === 'dogma'}
                                      confirmOverlay={isConfirmingDogma}
                                      colorBlindMode={settings.colorBlindMode}
                                      cardSize={settings.cardSize}
                                      onInspectStack={(st) => setInspectStack(st)}
                                      onDogmaHoverChange={(hovering) => {
                                        if (actionMode !== 'dogma' || !canActOnTurn) return;
                                        setHoveredDogmaColor((prev) =>
                                          hovering ? color : prev === color ? null : prev
                                        );
                                      }}
                                      onDogma={() => {
                                        if (!isLandscapeLayout) {
                                          setPendingMobileConfirm({ kind: 'dogma', color });
                                          return;
                                        }
                                        setHoveredDogmaColor(null);
                                        setActionMode('none');
                                        onAction({ type: 'dogma', playerId: view.viewerId, color });
                                      }}
                                      onConfirmAction={(e) => {
                                        e.stopPropagation();
                                        setPendingMobileConfirm(null);
                                        setHoveredDogmaColor(null);
                                        setActionMode('none');
                                        onAction({ type: 'dogma', playerId: view.viewerId, color });
                                      }}
                                    />
                                  );
                                })}
                                {isCompactMobile && (
                                  <div className="h-[56px] flex flex-col justify-between gap-1 min-w-0">
                                    <div className="grid grid-cols-2 gap-1 min-w-0">
                                      {viewerScoreBtn}
                                      {viewerAchBtn}
                                    </div>
                                    {viewerHandBtn ? (
                                      <div className="grid grid-cols-[1.25fr_1fr_1fr] gap-0.5 min-w-0">
                                        {viewerHandBtn}
                                        <button
                                          type="button"
                                          onClick={() => navigateMobileTab('supply')}
                                          className="h-[25px] min-h-[25px] py-0 leading-none w-full min-w-0 px-0.5 rounded border border-[#D9C7A3]/20 bg-[#1C1714] font-mono-num text-[10px] text-[#E5DAC5] hover:border-[#F6C945] cursor-pointer text-center truncate"
                                          title="View Decks & Achievements"
                                        >
                                          Decks
                                        </button>
                                        <button
                                          type="button"
                                          onClick={() => navigateMobileTab('chronicle')}
                                          className="h-[25px] min-h-[25px] py-0 leading-none w-full min-w-0 px-0.5 rounded border border-[#D9C7A3]/20 bg-[#1C1714] font-mono-num text-[10px] text-[#E5DAC5] hover:border-[#F6C945] cursor-pointer text-center truncate"
                                          title="View Match Log"
                                        >
                                          Log
                                        </button>
                                      </div>
                                    ) : (
                                      renderMobileSupplyLogPair('h-[25px] min-h-[25px]')
                                    )}
                                  </div>
                                )}
                                {!isLandscapeLayout && !isCompactMobile && (
                                  <div className="flex sm:hidden flex-col justify-center gap-1 min-w-0">
                                    <div className="grid grid-cols-2 gap-1 min-w-0">
                                      {viewerScoreBtn}
                                      {viewerAchBtn}
                                    </div>
                                    {viewerHandBtn}
                                    {renderMobileSupplyLogPair('h-[25px] min-h-[25px]')}
                                  </div>
                                )}
                              </div>
                            </section>
                          );
                        })()}

                        {/* Desktop 2v2 Bottom-Right Panel (Player 4 / (viewerIdx + 3) % 4) */}
                        {isLandscapeLayout && is2v2 && nextClockwise3 &&
                          renderOtherPlayerCard(nextClockwise3, true, false)}
                      </div>

                      {/* Hand Section (neutral brown; hidden in All-AI mode where H modal inspects hands) */}
                      {!isAllAI && (
                        <section
                          ref={handSectionRef}
                          className="rounded-lg border px-1.5 sm:px-2.5 py-1 sm:py-1.5 space-y-0.5 sm:space-y-1 bg-[#221B17]/95 border-[#D9C7A3]/25"
                          aria-label="Viewer Hand"
                        >
                          <div className="flex items-center justify-between gap-2 min-h-[24px]">
                            <span className="text-[11px] font-semibold uppercase tracking-wider text-[#C8B9A6] truncate min-w-0">
                              {viewerPublic?.isAI ? `${view.viewer.name}'s Hand` : 'Your Hand'}
                            </span>
                            <div className="flex items-center justify-end gap-1 sm:gap-1.5 shrink-0">
                              <button
                                type="button"
                                onClick={() => setMobileHandCompact((prev) => !prev)}
                                aria-pressed={mobileHandCompact}
                                className="h-6 w-[64px] inline-flex items-center justify-center rounded border border-[#D9C7A3]/15 bg-[#1C1714]/80 text-[11px] font-medium text-[#C8B9A6] hover:text-[#F5EFE2] hover:border-[#F6C945]/50 transition-colors cursor-pointer"
                              >
                                {mobileHandCompact ? 'Expand' : 'Compact'}
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  setHandSortMode((prev) =>
                                    prev === 'newest' ? 'sorted' : 'newest'
                                  )
                                }
                                aria-pressed={handSortMode === 'sorted'}
                                title={
                                  handSortMode === 'sorted'
                                    ? 'Sorted by age, color, name (click for newest first)'
                                    : 'Sort hand by highest age, color, then name'
                                }
                                className={`h-6 px-2 rounded border text-[11px] font-medium transition-colors cursor-pointer ${
                                  handSortMode === 'sorted'
                                    ? 'border-[#C88A1E] bg-[#3A2D19] text-[#F6C945]'
                                    : 'border-[#D9C7A3]/15 bg-[#1C1714]/80 text-[#C8B9A6] hover:text-[#F5EFE2] hover:border-[#F6C945]/50'
                                }`}
                              >
                                {handSortMode === 'sorted' ? 'Sorted' : 'Sort'}
                              </button>
                              {!settings.expandedHand && (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => scrollHandBy(-220)}
                                    aria-label="Scroll hand left"
                                    className="h-6 w-7 sm:w-8 rounded border border-[#D9C7A3]/15 bg-[#1C1714]/80 text-[#C8B9A6] hover:text-[#F5EFE2] hover:border-[#F6C945]/50 flex items-center justify-center cursor-pointer"
                                  >
                                    <ChevronLeft className="w-3.5 h-3.5" />
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => scrollHandBy(220)}
                                    aria-label="Scroll hand right"
                                    className="h-6 w-7 sm:w-8 rounded border border-[#D9C7A3]/15 bg-[#1C1714]/80 text-[#C8B9A6] hover:text-[#F5EFE2] hover:border-[#F6C945]/50 flex items-center justify-center cursor-pointer"
                                  >
                                    <ChevronRight className="w-3.5 h-3.5" />
                                  </button>
                                </>
                              )}
                            </div>
                          </div>

                          <div className={`${handContainerHeightClass} relative`}>
                            {displayedHand.length === 0 ? (
                              <div className="h-full rounded-md border border-dashed border-[#D9C7A3]/20 flex items-center justify-center text-xs text-[#8D7F70]">
                                Hand is empty — take a Draw action to add cards.
                              </div>
                            ) : (
                              <div
                                ref={handScrollRef}
                                onPointerDown={onHandPointerDown}
                                onPointerMove={onHandPointerMove}
                                onPointerUp={onHandPointerUp}
                                onPointerLeave={onHandPointerUp}
                                className={`${
                                  isCompactHand && settings.expandedHand
                                    ? 'max-h-[180px]'
                                    : 'h-full'
                                } ${
                                  settings.expandedHand
                                    ? 'flex flex-wrap content-start gap-1.5 sm:gap-2 overflow-y-auto pr-1'
                                    : 'flex flex-nowrap items-start gap-1.5 sm:gap-2 overflow-x-auto overscroll-x-contain no-scrollbar cursor-grab active:cursor-grabbing'
                                }`}
                              >
                                {displayedHand.map((card) => {
                                  const isConfirmingMeld =
                                    !isLandscapeLayout &&
                                    ((pendingMobileConfirm?.kind === 'meld' &&
                                      actionMode === 'meld') ||
                                      (pendingMobileConfirm?.kind === 'setup_meld' &&
                                        setupMeldMode)) &&
                                    pendingMobileConfirm.cardInstanceId === card.instanceId;

                                  return (
                                    <CardTile
                                      key={card.instanceId}
                                      card={card}
                                      compact
                                      handCompact={isCompactHand}
                                      hideHexagonInHandCompact={!isLandscapeLayout}
                                      confirmOverlay={isConfirmingMeld}
                                      colorBlindMode={settings.colorBlindMode}
                                      cardSize={settings.cardSize}
                                      selectable={
                                        (actionMode === 'meld' && canActOnTurn) ||
                                        (isSetupMeldReady && setupMeldMode)
                                      }
                                      onClick={(e) => {
                                        if (handDragRef.current.moved) {
                                          handDragRef.current.moved = false;
                                          return;
                                        }
                                        if (isSetupMeldReady && setupMeldMode) {
                                          if (!isLandscapeLayout) {
                                            e?.stopPropagation();
                                            setPendingMobileConfirm({
                                              kind: 'setup_meld',
                                              cardInstanceId: card.instanceId,
                                            });
                                            return;
                                          }
                                          onAction({
                                            type: 'setup_meld',
                                            playerId: view.viewerId,
                                            cardInstanceId: card.instanceId,
                                          });
                                          return;
                                        }
                                        if (actionMode === 'meld' && canActOnTurn) {
                                          if (!isLandscapeLayout) {
                                            e?.stopPropagation();
                                            setPendingMobileConfirm({
                                              kind: 'meld',
                                              cardInstanceId: card.instanceId,
                                            });
                                            return;
                                          }
                                          setActionMode('none');
                                          onAction({
                                            type: 'meld',
                                            playerId: view.viewerId,
                                            cardInstanceId: card.instanceId,
                                          });
                                        } else {
                                          setInspectCard(card);
                                        }
                                      }}
                                      onConfirmAction={(e) => {
                                        e.stopPropagation();
                                        setPendingMobileConfirm(null);
                                        if (isSetupMeldReady && setupMeldMode) {
                                          setSetupMeldMode(false);
                                          onAction({
                                            type: 'setup_meld',
                                            playerId: view.viewerId,
                                            cardInstanceId: card.instanceId,
                                          });
                                        } else if (actionMode === 'meld' && canActOnTurn) {
                                          setActionMode('none');
                                          onAction({
                                            type: 'meld',
                                            playerId: view.viewerId,
                                            cardInstanceId: card.instanceId,
                                          });
                                        }
                                      }}
                                    />
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        </section>
                      )}
                    </div>
                  )}
                </>
              );
            })()}

            {/* Portrait Chronicle Tab Content (non-carousel mobile modes) */}
            {!isLandscapeLayout && !isCompactCarousel && mobileTab === 'chronicle' &&
              renderMobileChronicleCard(false)}
          </div>

          {/* Compact Carousel Pane 1 Footer: Portrait Thumb-Zone Action Dock */}
          {isCompactCarousel && renderPortraitActionDock(false)}

          {/* Desktop Action Bar (Gameover / Prompt Inspect Return / Setup / Playing) */}
          {isLandscapeLayout && (
            <div className="shrink-0 pt-0.5">
              {view.phase === 'gameover' ? (
                <button
                  type="button"
                  onClick={() => onReopenVictory?.()}
                  className="w-full min-h-[40px] rounded-lg border bg-[#C88A1E] border-[#C88A1E] text-[#1C1714] text-sm font-bold flex items-center justify-center px-4 hover:bg-[#d89928] transition-colors cursor-pointer"
                >
                  End Game
                </button>
              ) : isPromptMinimized ? (
                <button
                  type="button"
                  onClick={() => setMinimizedPromptId(null)}
                  className="w-full min-h-[40px] rounded-lg border bg-[#C88A1E] border-[#C88A1E] text-[#1C1714] text-sm font-bold flex items-center justify-center px-4 hover:bg-[#d89928] transition-colors cursor-pointer"
                >
                  Return
                </button>
              ) : view.phase === 'setup' ? (
                <button
                  type="button"
                  disabled={!isSetupMeldReady}
                  onClick={() => {
                    if (isSetupMeldReady) setSetupMeldMode((prev) => !prev);
                  }}
                  aria-pressed={setupMeldMode}
                  className={`w-full min-h-[40px] rounded-lg border text-sm font-bold flex items-center justify-center px-4 transition-colors cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed ${
                    setupMeldMode
                      ? 'bg-[#F6C945] border-[#FAE078] text-[#1C1714] ring-1 ring-[#FAE078] hover:bg-[#fae078]'
                      : 'bg-[#27201B] border-[#D9C7A3]/35 text-[#F5EFE2] hover:border-[#F6C945]'
                  }`}
                >
                  {isSetupMeldReady
                    ? 'Meld Starting Card'
                    : isAllAI
                    ? 'AI selecting starting melds...'
                    : 'Waiting for opponent starting meld...'}
                </button>
              ) : (
                view.phase === 'playing' && (
                  <div className="flex items-center gap-1.5 lg:gap-2">
                    <div
                      title="Actions remaining this turn"
                      className="min-h-[40px] min-w-[52px] lg:min-w-[68px] rounded-lg border border-[#D9C7A3]/25 bg-[#1C1714] px-2 flex flex-col items-center justify-center shrink-0"
                    >
                      <span className="text-[9px] uppercase tracking-wider text-[#C8B9A6] leading-none">
                        Actions
                      </span>
                      <span className="font-mono-num text-sm font-bold text-[#F6C945] leading-tight">
                        {view.actionsRemaining}
                      </span>
                    </div>

                    <div className="flex-1 grid grid-cols-4 gap-1.5 lg:gap-2">
                      <button
                        type="button"
                        disabled={!canActOnTurn}
                        onClick={() => {
                          setActionMode('none');
                          setShowAchievePicker(false);
                          onAction({ type: 'draw', playerId: view.viewerId });
                        }}
                        className={`min-h-[40px] rounded-lg border text-xs lg:text-sm font-bold transition-colors px-1.5 lg:px-3 whitespace-nowrap truncate ${
                          canActOnTurn
                            ? 'bg-[#C88A1E] border-[#C88A1E] text-[#1C1714] hover:bg-[#d89928] cursor-pointer'
                            : 'bg-[#27201B] border-[#D9C7A3]/15 text-[#7D7061] opacity-50 cursor-not-allowed'
                        }`}
                      >
                        {drawAgeTarget ? `Draw [${drawAgeTarget}]` : 'Draw [12+]'}
                      </button>

                      <button
                        type="button"
                        disabled={!canActOnTurn || view.viewer.hand.length === 0}
                        onClick={handleMeldButtonPress}
                        className={`min-h-[40px] rounded-lg border text-xs lg:text-sm font-bold transition-colors px-1.5 lg:px-3 whitespace-nowrap truncate ${
                          actionMode === 'meld' && canActOnTurn
                            ? 'bg-[#F6C945] border-[#FAE078] text-[#1C1714] ring-1 ring-[#FAE078] hover:bg-[#fae078] cursor-pointer'
                            : canActOnTurn && view.viewer.hand.length > 0
                            ? 'bg-[#C88A1E] border-[#C88A1E] text-[#1C1714] hover:bg-[#d89928] cursor-pointer'
                            : 'bg-[#27201B] border-[#D9C7A3]/15 text-[#7D7061] opacity-50 cursor-not-allowed'
                        }`}
                      >
                        {actionMode === 'meld' ? 'Cancel Meld' : 'Meld'}
                      </button>

                      <button
                        type="button"
                        disabled={!canActOnTurn || dogmaReadyColors.length === 0}
                        title={
                          dogmaReadyColors.length === 0
                            ? 'No top cards with dogma abilities'
                            : 'Activate a top card dogma'
                        }
                        onClick={handleDogmaButtonPress}
                        className={`min-h-[40px] rounded-lg border text-xs lg:text-sm font-bold transition-colors px-1.5 lg:px-3 whitespace-nowrap truncate ${
                          actionMode === 'dogma' && canActOnTurn
                            ? 'bg-[#F6C945] border-[#FAE078] text-[#1C1714] ring-1 ring-[#FAE078] hover:bg-[#fae078] cursor-pointer'
                            : canActOnTurn && dogmaReadyColors.length > 0
                            ? 'bg-[#C88A1E] border-[#C88A1E] text-[#1C1714] hover:bg-[#d89928] cursor-pointer'
                            : 'bg-[#27201B] border-[#D9C7A3]/15 text-[#7D7061] opacity-50 cursor-not-allowed'
                        }`}
                      >
                        {actionMode === 'dogma' ? 'Cancel Dogma' : 'Dogma'}
                      </button>

                      <button
                        type="button"
                        disabled={!canActOnTurn || eligibleAchieveAges.length === 0}
                        onClick={handleAchieveButtonPress}
                        className={`min-h-[40px] rounded-lg border text-xs lg:text-sm font-bold transition-colors px-1.5 lg:px-3 whitespace-nowrap truncate ${
                          canActOnTurn && eligibleAchieveAges.length > 0
                            ? 'bg-[#E5B34B] border-[#F4CC75] text-[#1C1714] hover:bg-[#EFC364] cursor-pointer'
                            : 'bg-[#27201B] border-[#D9C7A3]/20 text-[#9E8F7E] opacity-60 cursor-not-allowed'
                        }`}
                      >
                        Achieve
                      </button>
                    </div>

                    {isAllAI && aiAutoMode ? (
                      <button
                        type="button"
                        aria-label={isAiPaused ? 'Resume AI' : 'Pause AI'}
                        title={isAiPaused ? 'Resume AI' : 'Pause AI'}
                        onClick={() => onToggleAiPause?.()}
                        className="min-h-[40px] min-w-[52px] lg:min-w-[68px] rounded-lg border bg-[#C88A1E] border-[#C88A1E] text-[#1C1714] hover:bg-[#d89928] flex items-center justify-center shrink-0 transition-colors cursor-pointer"
                      >
                        {isAiPaused ? (
                          <Play className="w-4 h-4" />
                        ) : (
                          <Pause className="w-4 h-4" />
                        )}
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={!canManualEndTurn}
                        aria-label="End Turn"
                        title="End Turn"
                        onClick={() => {
                          setActionMode('none');
                          setShowAchievePicker(false);
                          onAction({ type: 'end_turn', playerId: view.currentPlayerId });
                        }}
                        className={`min-h-[40px] min-w-[52px] lg:min-w-[68px] rounded-lg border flex items-center justify-center shrink-0 transition-colors ${
                          canManualEndTurn
                            ? 'bg-[#E5B34B] border-[#F4CC75] text-[#1C1714] hover:bg-[#EFC364] cursor-pointer'
                            : 'bg-[#27201B] border-[#D9C7A3]/20 text-[#9E8F7E] opacity-60 cursor-not-allowed'
                        }`}
                      >
                        <ArrowRight className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                )
              )}
            </div>
          )}
        </div>

        {/* Compact Carousel Pane 2 (Right): Chronicles / AI Log */}
        {isCompactCarousel && (
          <div
            data-testid="carousel-pane-chronicle"
            className="w-full shrink-0 snap-start snap-always h-full overflow-y-auto px-1.5 sm:px-3 py-1 pb-safe"
          >
            {renderMobileChronicleCard(true)}
          </div>
        )}

        {/* Landscape Right Command Sidebar: Decks + Achievements + Chronicles */}
        {isLandscapeLayout && (
          <aside
            className={`flex flex-col ${
              is2v2 || opponents.length > 1
                ? 'w-[196px] md:w-[228px] lg:w-[252px] xl:w-[292px] min-[1920px]:w-[360px]'
                : 'w-[200px] md:w-[236px] lg:w-[280px] xl:w-[320px] min-[1920px]:w-[376px]'
            } shrink-0 gap-2 min-h-0 overflow-y-auto`}
          >
            <section className="shrink-0 rounded-lg bg-[#221B17]/95 border border-[#D9C7A3]/18 p-2.5">
              {renderSupplySectionContent(false)}
            </section>

            <section className="flex-1 min-h-[120px] flex flex-col rounded-lg bg-[#221B17]/95 border border-[#D9C7A3]/18 p-2.5">
              <div className="flex items-center justify-between gap-2 pb-1.5 mb-1.5 border-b border-[#D9C7A3]/15 shrink-0">
                <h2 className="font-display text-xs font-bold uppercase tracking-wider text-[#F5EFE2]">
                  {sidebarTab === 'ai' ? 'AI Decisions' : 'Chronicles'}
                </h2>
                {showAiTab && (
                  <button
                    type="button"
                    onClick={() =>
                      setSidebarTab((prev) => (prev === 'chronicle' ? 'ai' : 'chronicle'))
                    }
                    className="min-h-[26px] w-[88px] rounded border border-[#D9C7A3]/20 bg-[#1C1714] px-2 py-0.5 font-mono-num text-[11px] text-[#E5DAC5] hover:border-[#F6C945] cursor-pointer text-center shrink-0"
                  >
                    {sidebarTab === 'ai' ? 'Chronicles' : 'AI'}
                  </button>
                )}
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto pr-0.5">
                {sidebarTab === 'ai' && showAiTab ? (
                  <AIDecisionTraceList
                    traces={aiTraces}
                    hasHeuristicAI={view.players.some(
                      (p) => p.isAI && normalizeAIBackend(p.aiBackend) === 'heuristic'
                    )}
                  />
                ) : (
                  <GroupedChronicle log={view.log} />
                )}
              </div>
            </section>
          </aside>
        )}
      </div>

      {/* Portrait Thumb-Zone Action Dock (fixed for non-carousel mobile modes; hidden on Decks & Log) */}
      {!isLandscapeLayout &&
        !isCompactCarousel &&
        mobileTab !== 'supply' &&
        mobileTab !== 'chronicle' &&
        renderPortraitActionDock(true)}

      {/* Dogma Choice Prompt Modal */}
      <DogmaPromptModal
        prompt={isPromptMinimized ? null : view.pendingPromptForViewer}
        viewerId={view.viewerId}
        board={view.viewer.board}
        onInspectBoard={() => {
          if (view.pendingPromptForViewer) {
            setMinimizedPromptId(view.pendingPromptForViewer.id);
          }
        }}
        onAnswer={onAction}
      />

      {/* Age Breakdown & Score Pile Inspector Modal */}
      <PileSummaryModal
        target={pileSummary}
        onInspectCard={(card) => setInspectCard(card)}
        onClose={() => setPileSummary(null)}
      />

      {/* Claimed Achievements List Modal */}
      <AchievementsWonModal
        target={achievementsWonTarget}
        onClose={() => setAchievementsWonTarget(null)}
      />

      {/* Junk Pile & Junked Achievements Modal */}
      <JunkPileModal
        open={showJunkModal}
        view={view}
        onClose={() => setShowJunkModal(false)}
      />

      {/* Special Achievements Info Modal */}
      <SpecialAchievementsModal
        open={showSpecialModal}
        view={view}
        onClose={() => setShowSpecialModal(false)}
      />

      {/* Available Achievements Picker Modal */}
      <AchieveModal
        open={showAchievePicker && canActOnTurn && eligibleAchieveAges.length > 0}
        scoreTotal={view.viewer.scoreTotal}
        highestTopAge={view.viewer.highestTopAge}
        standardAchievementBacks={view.standardAchievementBacks}
        onClaim={(age) => {
          setShowAchievePicker(false);
          onAction({ type: 'achieve', playerId: view.viewerId, age });
        }}
        onClose={() => setShowAchievePicker(false)}
      />

      {/* Full Card / Stack Inspector Modal */}
      <CardInspectorModal
        card={inspectCard}
        stack={inspectStack}
        onClose={() => {
          setInspectCard(null);
          setInspectStack(null);
        }}
      />
    </div>
  );
};
