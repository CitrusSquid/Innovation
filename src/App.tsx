import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AGE_NAMES, SPECIAL_ACHIEVEMENTS } from './engine/constants';
import { debugTakeAnyCard, debugTriggerEndGame } from './engine/debug';
import { applyAction, createGame, setManualEndTurn } from './engine/engine';
import { projectPlayerView } from './engine/playerView';
import { loadSettings, saveSettings, type AppSettings } from './engine/settings';
import { getHighestTopCardAge, getVisibleIconCounts } from './engine/splay';
import { clearAutoMatch, loadAutoMatch, saveAutoMatch } from './engine/storage';
import { chooseActionForBackend } from './engine/tdWeights';
import type {
  AIDecisionTrace,
  Age,
  GameConfig,
  GameState,
  RepeatDrawStepEvent,
  TurnAction,
} from './engine/types';
import { useDragScroll } from './hooks/useDragScroll';
import { BenchmarkModal } from './components/BenchmarkModal';
import {
  AboutModal,
  AchievementPopupModal,
  AllAISetupModal,
  CardBrowserModal,
  OpponentMoveModal,
  RepeatDrawModal,
  RulesModal,
  SaveLoadModal,
  type AchievementPopupNotice,
  type DogmaParticipantStatus,
  type OpponentMoveNotice,
} from './components/Modals';
import { PrivacyCurtain, VictoryModal } from './components/PrivacyCurtain';
import { SettingsModal } from './components/SettingsModal';
import { TabletopView } from './components/TabletopView';
import { TitleScreen } from './components/TitleScreen';
import { UIGuideModal } from './components/UIGuideModal';

function collectAchievementNotices(
  prevState: GameState,
  nextState: GameState
): AchievementPopupNotice[] {
  if (nextState.phase === 'gameover') return [];
  const prevIds = new Set<string>();
  for (const p of prevState.players) {
    for (const a of p.achievements) prevIds.add(a.id);
  }
  const notices: AchievementPopupNotice[] = [];
  for (const p of nextState.players) {
    for (const a of p.achievements) {
      if (prevIds.has(a.id)) continue;
      if (a.kind === 'special' && a.specialId) {
        const meta = SPECIAL_ACHIEVEMENTS[a.specialId];
        notices.push({
          id: a.id,
          playerName: p.name,
          kind: 'special',
          title: `Special Achievement: ${meta.name}`,
          subtitle: meta.description,
        });
      } else if (a.kind === 'chain' && a.age !== undefined) {
        notices.push({
          id: a.id,
          playerName: p.name,
          kind: 'chain',
          title: `Chain Achievement · Age ${a.age}`,
          subtitle: AGE_NAMES[a.age],
        });
      } else if (a.age !== undefined) {
        notices.push({
          id: a.id,
          playerName: p.name,
          kind: 'standard',
          title: `Standard Achievement · Age ${a.age}`,
          subtitle: AGE_NAMES[a.age],
        });
      }
    }
  }
  return notices;
}

function collectRepeatDrawEvents(
  prevState: GameState,
  nextState: GameState
): RepeatDrawStepEvent[] {
  const prevLen = prevState.repeatDrawEvents?.length ?? 0;
  const nextList = nextState.repeatDrawEvents ?? [];
  return nextList.slice(prevLen);
}

function buildOpponentMoveNotice(
  prevState: GameState,
  nextState: GameState,
  actorId: string,
  action: TurnAction,
  mode: AppSettings['showOpponentMoves'],
  suppressPopups: boolean
): OpponentMoveNotice | null {
  const actorBefore = prevState.players.find((p) => p.id === actorId);
  const actorAfter = nextState.players.find((p) => p.id === actorId);
  if (mode === 'off' || suppressPopups || !actorBefore || !actorAfter || !actorBefore.isAI) {
    return null;
  }

  const newLogs = nextState.log.slice(prevState.log.length).map((e) => e.message);

  if (action.type === 'dogma') {
    const stack = actorBefore.board[action.color];
    const topCard = stack.cards[stack.cards.length - 1];
    if (!topCard) return null;

    const featuredIcon = topCard.featuredIcon;
    const actorCount = getVisibleIconCounts(actorBefore.board)[featuredIcon];
    const hasNonDemand = topCard.abilities.some((ab) => !ab.isDemand);
    const hasDemand = topCard.abilities.some((ab) => ab.isDemand);
    const is2v2 = prevState.variant === '2v2';
    const actorIdx = prevState.players.findIndex((p) => p.id === actorId);
    const orderedPlayers =
      actorIdx >= 0
        ? [
            ...prevState.players.slice(actorIdx),
            ...prevState.players.slice(0, actorIdx),
          ]
        : prevState.players;

    const dogmaParticipants: DogmaParticipantStatus[] = orderedPlayers.map((p) => {
      const iconCount = getVisibleIconCounts(p.board)[featuredIcon];
      const highlight: DogmaParticipantStatus['highlight'] =
        p.id === actorBefore.id || iconCount === actorCount
          ? 'yellow'
          : iconCount > actorCount
          ? 'blue'
          : 'red';

      if (p.id === actorBefore.id) {
        return {
          playerId: p.id,
          playerName: p.name,
          iconCount,
          highlight,
          shortStatus: 'Active',
          statusLabel: 'Active',
        };
      }
      if (p.eliminated) {
        return {
          playerId: p.id,
          playerName: p.name,
          iconCount,
          highlight,
          shortStatus: 'Out',
          statusLabel: 'Eliminated',
        };
      }
      const isTeammate = is2v2 && p.teamId === actorBefore.teamId;
      const willShare = hasNonDemand && iconCount >= actorCount;
      const isVulnerable = hasDemand && !isTeammate && iconCount < actorCount;
      if (willShare) {
        return {
          playerId: p.id,
          playerName: p.name,
          iconCount,
          highlight,
          shortStatus: 'Share',
          statusLabel: 'Shares effect',
        };
      }
      if (isVulnerable) {
        return {
          playerId: p.id,
          playerName: p.name,
          iconCount,
          highlight,
          shortStatus: 'Vuln',
          statusLabel: 'Vulnerable',
        };
      }
      if (hasDemand && isTeammate) {
        return {
          playerId: p.id,
          playerName: p.name,
          iconCount,
          highlight,
          shortStatus: 'Ally',
          statusLabel: 'Teammate (immune)',
        };
      }
      if (hasDemand && !hasNonDemand) {
        return {
          playerId: p.id,
          playerName: p.name,
          iconCount,
          highlight,
          shortStatus: 'Safe',
          statusLabel: 'Not vulnerable',
        };
      }
      return {
        playerId: p.id,
        playerName: p.name,
        iconCount,
        highlight,
        shortStatus: 'No share',
        statusLabel: 'Does not share',
      };
    });

    return {
      id: `opp_move_${nextState.turnNumber}_${nextState.log.length}`,
      actorName: actorBefore.name,
      kind: 'dogma',
      title: `Dogma - ${topCard.name}`,
      card: topCard,
      featuredIcon,
      dogmaParticipants,
      details: newLogs.slice(1),
    };
  }

  if (mode !== 'full') return null;

  if (action.type === 'meld') {
    const card = actorBefore.hand.find((c) => c.instanceId === action.cardInstanceId);
    if (!card) return null;
    return {
      id: `opp_move_${nextState.turnNumber}_${nextState.log.length}`,
      actorName: actorBefore.name,
      kind: 'meld',
      title: `Meld - ${card.name}`,
      card,
      details: newLogs,
    };
  }

  if (action.type === 'draw') {
    const beforeIds = new Set(actorBefore.hand.map((c) => c.instanceId));
    const drawnAges: Age[] = actorAfter.hand
      .filter((c) => !beforeIds.has(c.instanceId))
      .map((c) => c.age);
    return {
      id: `opp_move_${nextState.turnNumber}_${nextState.log.length}`,
      actorName: actorBefore.name,
      kind: 'draw',
      title: `${actorBefore.name} Drew Card`,
      drawnAges: drawnAges.length > 0 ? drawnAges : undefined,
      details: newLogs,
    };
  }

  if (action.type === 'achieve') {
    return {
      id: `opp_move_${nextState.turnNumber}_${nextState.log.length}`,
      actorName: actorBefore.name,
      kind: 'achieve',
      title: `${actorBefore.name} Achieved`,
      achievedAge: action.age,
      details: newLogs,
    };
  }

  return null;
}

export function App() {
  useDragScroll();

  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());

  const [gameState, setGameState] = useState<GameState | null>(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      if (params.get('autostart') === '1') {
        const s = loadSettings();
        return createGame({
          variant: '1v1',
          controlMode: 'vs_ai',
          playerNames: ['Player 1', 'AI Archivist'],
          manualEndTurn: !s.autoEndTurn,
        });
      }
    }
    return null;
  });

  const [autoSavedGame, setAutoSavedGame] = useState<GameState | null>(() => loadAutoMatch());
  const [lastConfig, setLastConfig] = useState<GameConfig>({
    variant: '1v1',
    controlMode: 'vs_ai',
    playerNames: ['Player 1', 'AI Archivist'],
  });

  // Modals & Popups
  const [handoffRevealedForKey, setHandoffRevealedForKey] = useState<string>('');
  const [lastHumanViewerId, setLastHumanViewerId] = useState<string | null>(null);
  const [showRulesModal, setShowRulesModal] = useState(false);
  const [showUIGuideModal, setShowUIGuideModal] = useState(false);
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [showCardBrowser, setShowCardBrowser] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [showAboutModal, setShowAboutModal] = useState(false);
  const [aboutInitialSubView, setAboutInitialSubView] = useState<'main' | 'changelog' | 'ai'>('main');
  const [showBenchmarkModal, setShowBenchmarkModal] = useState(false);
  const [weightsVersion, setWeightsVersion] = useState(0);
  const [pendingAllAIConfig, setPendingAllAIConfig] = useState<GameConfig | null>(null);
  const [aiAutoMode, setAiAutoMode] = useState<boolean>(true);
  const [aiPaused, setAiPaused] = useState<boolean>(false);
  const [victoryHiddenForInspect, setVictoryHiddenForInspect] = useState<boolean>(false);
  const [pendingOpponentNotice, setPendingOpponentNotice] =
    useState<OpponentMoveNotice | null>(null);
  const [repeatDrawQueue, setRepeatDrawQueue] = useState<RepeatDrawStepEvent[]>([]);
  const [achievementQueue, setAchievementQueue] = useState<AchievementPopupNotice[]>([]);
  const [aiTraces, setAiTraces] = useState<AIDecisionTrace[]>([]);
  const [debugToast, setDebugToast] = useState<string | null>(null);
  const debugToastTimerRef = useRef<number | null>(null);
  const gameStateRef = useRef<GameState | null>(gameState);
  gameStateRef.current = gameState;

  useEffect(() => {
    return () => {
      if (debugToastTimerRef.current !== null) {
        window.clearTimeout(debugToastTimerRef.current);
      }
    };
  }, []);

  const enqueueRepeatDraws = useCallback((events: RepeatDrawStepEvent[]) => {
    if (events.length === 0) return;
    setRepeatDrawQueue((prev) => {
      const seen = new Set(prev.map((e) => e.id));
      const fresh = events.filter((e) => !seen.has(e.id));
      return fresh.length > 0 ? [...prev, ...fresh] : prev;
    });
  }, []);

  const enqueueAchievements = useCallback((notices: AchievementPopupNotice[]) => {
    if (notices.length === 0) return;
    setAchievementQueue((prev) => {
      const seen = new Set(prev.map((n) => n.id));
      const fresh = notices.filter((n) => !seen.has(n.id));
      return fresh.length > 0 ? [...prev, ...fresh] : prev;
    });
  }, []);

  const handleUpdateSettings = useCallback(
    (patch: Partial<AppSettings>) => {
      setSettings((prev) => {
        const next = { ...prev, ...patch };
        saveSettings(next);
        return next;
      });
      if (patch.autoEndTurn !== undefined) {
        const manual = !patch.autoEndTurn;
        setGameState((prev) => {
          if (!prev) return prev;
          const next = setManualEndTurn(prev, manual, !aiAutoMode && manual);
          saveAutoMatch(next);
          return next;
        });
      }
    },
    [aiAutoMode]
  );

  const handleToggleDebugUnlock = useCallback(() => {
    const nextUnlocked = !settings.debugUnlocked;
    handleUpdateSettings(
      nextUnlocked
        ? { debugUnlocked: true }
        : {
            debugUnlocked: false,
            debugRevealHidden: false,
            debugShowAiDecisions: false,
          }
    );
    setDebugToast(nextUnlocked ? 'Debug options unlocked' : 'Debug options hidden');
    if (debugToastTimerRef.current !== null) {
      window.clearTimeout(debugToastTimerRef.current);
    }
    debugToastTimerRef.current = window.setTimeout(() => {
      debugToastTimerRef.current = null;
      setDebugToast(null);
    }, 3200);
  }, [settings.debugUnlocked, handleUpdateSettings]);

  // Sync document.body.dataset.state for shell parity & verification
  useEffect(() => {
    if (!gameState) {
      document.body.dataset.state = 'title';
    } else if (gameState.phase === 'gameover') {
      document.body.dataset.state = 'gameover';
    } else {
      document.body.dataset.state = 'playing';
    }
  }, [gameState]);

  // Auto-save whenever gameState updates
  useEffect(() => {
    if (gameState) {
      saveAutoMatch(gameState);
      setAutoSavedGame(gameState);
    }
  }, [gameState]);

  // Determine whose turn / prompt needs resolution
  const activeActorId = useMemo(() => {
    if (!gameState || gameState.phase === 'gameover') return null;
    if (gameState.pendingPrompts.length > 0) {
      return gameState.pendingPrompts[0].playerId;
    }
    return gameState.players[gameState.currentPlayerIndex]?.id ?? null;
  }, [gameState]);

  const activeActor = useMemo(
    () => gameState?.players.find((p) => p.id === activeActorId) ?? null,
    [gameState, activeActorId]
  );

  const humanPlayers = useMemo(
    () => (gameState ? gameState.players.filter((p) => !p.isAI) : []),
    [gameState]
  );
  const isAllAI = gameState !== null && humanPlayers.length === 0;
  const isMultiHuman = humanPlayers.length > 1;

  // Fair AI turn loop (strictly reads ONLY sanitized PlayerView, pauses while popups or Pause active)
  useEffect(() => {
    if (
      !gameState ||
      !activeActor ||
      !activeActor.isAI ||
      gameState.phase === 'gameover' ||
      (isAllAI && aiAutoMode && aiPaused) ||
      (gameState.phase === 'playing' &&
        gameState.actionsRemaining <= 0 &&
        gameState.pendingPrompts.length === 0) ||
      pendingOpponentNotice !== null ||
      repeatDrawQueue.length > 0 ||
      achievementQueue.length > 0 ||
      showSettingsModal ||
      showSaveModal
    ) {
      return;
    }

    const timer = window.setTimeout(() => {
      const promptPlayerId = gameState.pendingPrompts[0]?.playerId;
      const actorId = promptPlayerId ?? gameState.players[gameState.currentPlayerIndex]?.id;
      const actor = gameState.players.find((p) => p.id === actorId);
      if (!actor || !actor.isAI) return;

      const safeView = projectPlayerView(gameState, actor.id);
      const trace: AIDecisionTrace | undefined =
        settings.debugUnlocked && settings.debugShowAiDecisions
          ? {
              id: '',
              turn: gameState.turnNumber,
              actorId: actor.id,
              actorName: actor.name,
              actionLabel: '',
              situationSummary: '',
              chosenLabel: '',
              candidates: [],
            }
          : undefined;

      const aiAction = chooseActionForBackend(safeView, actor.aiBackend, trace);
      const nextState = applyAction(gameState, aiAction);

      if (trace) {
        setAiTraces((prev) => [...prev.slice(-49), trace]);
      }

      const suppressPopups = isAllAI && aiAutoMode;
      const newRepeatDraws = !suppressPopups
        ? collectRepeatDrawEvents(gameState, nextState)
        : [];
      const achNotices =
        settings.achievementPopups && !suppressPopups
          ? collectAchievementNotices(gameState, nextState)
          : [];
      const rawNotice = buildOpponentMoveNotice(
        gameState,
        nextState,
        actor.id,
        aiAction,
        settings.showOpponentMoves,
        suppressPopups
      );
      const notice =
        rawNotice && rawNotice.kind === 'achieve' && achNotices.length > 0 ? null : rawNotice;

      saveAutoMatch(nextState);
      setAutoSavedGame(nextState);
      setGameState(nextState);
      if (notice) {
        setPendingOpponentNotice(notice);
      }
      if (newRepeatDraws.length > 0) {
        enqueueRepeatDraws(newRepeatDraws);
      }
      if (achNotices.length > 0) {
        enqueueAchievements(achNotices);
      }
    }, 420);

    return () => window.clearTimeout(timer);
  }, [
    gameState,
    activeActor,
    isAllAI,
    aiAutoMode,
    aiPaused,
    pendingOpponentNotice,
    repeatDrawQueue.length,
    achievementQueue.length,
    enqueueRepeatDraws,
    enqueueAchievements,
    showSettingsModal,
    showSaveModal,
    settings.debugUnlocked,
    settings.debugShowAiDecisions,
    settings.showOpponentMoves,
    settings.achievementPopups,
  ]);

  const launchGame = useCallback(
    (config: GameConfig, useAutoMode: boolean) => {
      setLastConfig(config);
      const allAI = Boolean(config.playerIsAI?.length && config.playerIsAI.every(Boolean));
      const manual = !settings.autoEndTurn;
      const fresh = createGame({
        ...config,
        manualEndTurn: manual,
        manualEndTurnForAI: allAI && !useAutoMode && manual,
      });
      setHandoffRevealedForKey('');
      setPendingOpponentNotice(null);
      setRepeatDrawQueue([]);
      setAchievementQueue([]);
      setAiTraces([]);
      setAiPaused(false);
      setVictoryHiddenForInspect(false);
      saveAutoMatch(fresh);
      setAutoSavedGame(fresh);
      setGameState(fresh);
    },
    [settings.autoEndTurn]
  );

  const handleStartGame = useCallback(
    (config: GameConfig) => {
      const allAI = Boolean(config.playerIsAI?.length && config.playerIsAI.every(Boolean));
      if (allAI) {
        setLastConfig(config);
        setPendingAllAIConfig(config);
        return;
      }
      launchGame(config, aiAutoMode);
    },
    [aiAutoMode, launchGame]
  );

  const handleConfirmAllAIStart = useCallback(() => {
    if (!pendingAllAIConfig) return;
    const cfg = pendingAllAIConfig;
    setPendingAllAIConfig(null);
    launchGame(cfg, aiAutoMode);
  }, [pendingAllAIConfig, aiAutoMode, launchGame]);

  const handleResumeAutoSave = useCallback(() => {
    const saved = loadAutoMatch();
    if (saved) {
      setHandoffRevealedForKey('');
      setPendingOpponentNotice(null);
      setRepeatDrawQueue([]);
      setAchievementQueue([]);
      setVictoryHiddenForInspect(false);
      setAiPaused(false);
      const manual = !settings.autoEndTurn;
      const savedAllAI = saved.players.every((p) => p.isAI);
      const next = setManualEndTurn(saved, manual, savedAllAI && !aiAutoMode && manual);
      saveAutoMatch(next);
      setAutoSavedGame(next);
      setGameState(next);
    }
  }, [settings.autoEndTurn, aiAutoMode]);

  const handleAction = useCallback(
    (action: TurnAction) => {
      const prev = gameStateRef.current;
      if (!prev) return;
      try {
        const next = applyAction(prev, action);
        saveAutoMatch(next);
        setAutoSavedGame(next);
        setGameState(next);
        const newRepeatDraws = collectRepeatDrawEvents(prev, next);
        if (newRepeatDraws.length > 0) {
          enqueueRepeatDraws(newRepeatDraws);
        }
        if (settings.achievementPopups) {
          const achNotices = collectAchievementNotices(prev, next);
          if (achNotices.length > 0) {
            enqueueAchievements(achNotices);
          }
        }
      } catch (err) {
        console.error('Action rejected:', err);
      }
    },
    [settings.achievementPopups, enqueueRepeatDraws, enqueueAchievements]
  );

  // Track active human viewer across pass-and-play turns

  useEffect(() => {
    if (activeActor && !activeActor.isAI) {
      setLastHumanViewerId(activeActor.id);
    }
  }, [activeActor]);

  // Determine which player's PlayerView to render
  const viewerId = useMemo(() => {
    if (!gameState) return null;
    if (isAllAI) return gameState.players[0].id;
    if (isMultiHuman) {
      if (activeActor && !activeActor.isAI) return activeActor.id;
      if (lastHumanViewerId && humanPlayers.some((p) => p.id === lastHumanViewerId)) {
        return lastHumanViewerId;
      }
      return humanPlayers[0].id;
    }
    return humanPlayers[0]?.id ?? gameState.players[0].id;
  }, [gameState, isAllAI, isMultiHuman, activeActor, lastHumanViewerId, humanPlayers]);

  const handoffKey = useMemo(() => {
    if (!gameState || !isMultiHuman || !activeActorId) return '';
    return `${gameState.phase}_${gameState.turnNumber}_${activeActorId}`;
  }, [gameState, isMultiHuman, activeActorId]);

  const needsPrivacyCurtain =
    gameState !== null &&
    isMultiHuman &&
    gameState.phase !== 'gameover' &&
    activeActor !== null &&
    !activeActor.isAI &&
    handoffRevealedForKey !== handoffKey;

  const playerView = useMemo(() => {
    if (!gameState || !viewerId) return null;
    return projectPlayerView(gameState, viewerId, {
      revealHidden:
        isAllAI ||
        gameState.phase === 'gameover' ||
        (settings.debugUnlocked && settings.debugRevealHidden),
    });
  }, [gameState, viewerId, isAllAI, settings.debugUnlocked, settings.debugRevealHidden]);

  const handleDebugEndGame = useCallback(
    (outcome: 'win' | 'lose') => {
      if (!viewerId) return;
      setGameState((prev) => {
        if (!prev) return prev;
        const next = debugTriggerEndGame(prev, viewerId, outcome);
        saveAutoMatch(next);
        return next;
      });
    },
    [viewerId]
  );

  const handleDebugTakeCard = useCallback(
    (defId: string) => {
      if (!viewerId) return;
      setGameState((prev) => {
        if (!prev) return prev;
        const next = debugTakeAnyCard(prev, viewerId, defId).nextState;
        saveAutoMatch(next);
        return next;
      });
    },
    [viewerId]
  );

  return (
    <>
      {!gameState || !playerView ? (
        <TitleScreen
          autoSavedGame={autoSavedGame}
          weightsVersion={weightsVersion}
          onStartGame={handleStartGame}
          onResumeAutoSave={handleResumeAutoSave}
          onDeleteAutoSave={() => {
            clearAutoMatch();
            setAutoSavedGame(null);
          }}
          onOpenSettings={() => setShowSettingsModal(true)}
          onToggleDebugUnlock={handleToggleDebugUnlock}
          onOpenRules={() => setShowRulesModal(true)}
          onOpenUIGuide={() => setShowUIGuideModal(true)}
          onOpenCardBrowser={() => setShowCardBrowser(true)}
          onOpenAbout={() => {
            setAboutInitialSubView('main');
            setShowAboutModal(true);
          }}
        />
      ) : (
        <>
          <TabletopView
            view={playerView}
            settings={settings}
            aiTraces={aiTraces}
            aiAutoMode={aiAutoMode}
            isAiPaused={aiPaused}
            onToggleAiPause={() => setAiPaused((p) => !p)}
            onReopenVictory={() => setVictoryHiddenForInspect(false)}
            onAction={handleAction}
            onUpdateSettings={handleUpdateSettings}
            onOpenSettings={() => setShowSettingsModal(true)}
            onToggleDebugUnlock={handleToggleDebugUnlock}
          />

          {needsPrivacyCurtain && activeActor && (
            <PrivacyCurtain
              playerName={activeActor.name}
              phaseLabel={
                gameState.phase === 'setup' ? 'Starting Card Selection' : `Turn ${gameState.turnNumber}`
              }
              onReveal={() => setHandoffRevealedForKey(handoffKey)}
            />
          )}

          {gameState.phase === 'gameover' && gameState.victory && !victoryHiddenForInspect && (
            <VictoryModal
              summary={gameState.victory.summary}
              reason={gameState.victory.reason}
              totalTurns={gameState.turnNumber}
              is2v2={gameState.variant === '2v2'}
              players={gameState.players.map((p) => ({
                id: p.id,
                name: p.name,
                teamId: p.teamId,
                score: gameState.victory!.finalScores[p.id] ?? 0,
                achievements: gameState.victory!.finalAchievements[p.id] ?? 0,
                highestTopAge: Math.max(
                  gameState.highestAgeReachedByPlayer?.[p.id] ?? 1,
                  getHighestTopCardAge(p.board)
                ),
                isWinner: gameState.victory!.winnerPlayerIds.includes(p.id),
              }))}
              chronology={gameState.chronologyEvents ?? []}
              onInspectBoard={() => setVictoryHiddenForInspect(true)}
              onPlayAgain={() => {
                clearAutoMatch();
                handleStartGame({ ...lastConfig, seed: undefined });
              }}
              onReturnTitle={() => {
                clearAutoMatch();
                setAutoSavedGame(null);
                setPendingOpponentNotice(null);
                setRepeatDrawQueue([]);
                setAchievementQueue([]);
                setVictoryHiddenForInspect(false);
                setGameState(null);
              }}
            />
          )}
        </>
      )}

      {showRulesModal && <RulesModal onClose={() => setShowRulesModal(false)} />}

      {showUIGuideModal && <UIGuideModal onClose={() => setShowUIGuideModal(false)} />}

      {showCardBrowser && <CardBrowserModal onClose={() => setShowCardBrowser(false)} />}

      {showAboutModal && (
        <AboutModal
          initialSubView={aboutInitialSubView}
          onClose={() => setShowAboutModal(false)}
          onOpenBenchmark={() => {
            setShowAboutModal(false);
            setShowBenchmarkModal(true);
          }}
          onWeightsChanged={() => setWeightsVersion((v) => v + 1)}
        />
      )}

      <BenchmarkModal
        open={showBenchmarkModal}
        weightsVersion={weightsVersion}
        onClose={() => {
          setShowBenchmarkModal(false);
          setAboutInitialSubView('ai');
          setShowAboutModal(true);
        }}
      />

      <AllAISetupModal
        open={pendingAllAIConfig !== null}
        autoMode={aiAutoMode}
        onChangeAutoMode={setAiAutoMode}
        settings={settings}
        onUpdateSettings={handleUpdateSettings}
        onConfirmStart={handleConfirmAllAIStart}
        onCancel={() => setPendingAllAIConfig(null)}
      />

      <SettingsModal
        open={showSettingsModal}
        settings={settings}
        onUpdateSettings={handleUpdateSettings}
        onOpenSaves={() => setShowSaveModal(true)}
        onSaveAndExitToMenu={() => {
          if (gameState) {
            saveAutoMatch(gameState);
            setAutoSavedGame(gameState);
          }
          setPendingOpponentNotice(null);
          setRepeatDrawQueue([]);
          setAchievementQueue([]);
          setVictoryHiddenForInspect(false);
          setAiPaused(false);
          setGameState(null);
        }}
        currentState={gameState}
        viewerId={viewerId}
        onDebugEndGame={handleDebugEndGame}
        onDebugTakeCard={handleDebugTakeCard}
        onClose={() => setShowSettingsModal(false)}
      />

      <OpponentMoveModal
        notice={pendingOpponentNotice}
        onDismiss={() => setPendingOpponentNotice(null)}
      />

      <RepeatDrawModal
        event={pendingOpponentNotice === null ? (repeatDrawQueue[0] ?? null) : null}
        remainingCount={Math.max(0, repeatDrawQueue.length - 1)}
        onDismiss={() => setRepeatDrawQueue((prev) => prev.slice(1))}
      />

      <AchievementPopupModal
        notice={
          pendingOpponentNotice === null && repeatDrawQueue.length === 0
            ? (achievementQueue[0] ?? null)
            : null
        }
        onDismiss={() => setAchievementQueue((prev) => prev.slice(1))}
      />

      {showSaveModal && (
        <SaveLoadModal
          currentState={gameState}
          onLoadState={(loaded) => {
            setHandoffRevealedForKey('');
            setPendingOpponentNotice(null);
            setRepeatDrawQueue([]);
            setAchievementQueue([]);
            setAiTraces([]);
            setVictoryHiddenForInspect(false);
            setAiPaused(false);
            const manual = !settings.autoEndTurn;
            const loadedAllAI = loaded.players.every((p) => p.isAI);
            const next = setManualEndTurn(loaded, manual, loadedAllAI && !aiAutoMode && manual);
            saveAutoMatch(next);
            setAutoSavedGame(next);
            setGameState(next);
          }}
          onClose={() => setShowSaveModal(false)}
        />
      )}

      {debugToast && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-5 left-1/2 -translate-x-1/2 z-[80] pointer-events-none px-4 py-2 rounded-full border border-[#C88A1E]/60 bg-[#1C1714]/95 text-xs sm:text-sm font-medium text-[#F5EFE2] shadow-2xl"
        >
          {debugToast}
        </div>
      )}
    </>
  );
}

export default App;
