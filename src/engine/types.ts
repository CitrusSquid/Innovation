export type Age = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11;

export type CardColor = 'red' | 'yellow' | 'green' | 'blue' | 'purple';

export type FunctionalIcon =
  | 'tower'
  | 'coin'
  | 'leaf'
  | 'lightbulb'
  | 'factory'
  | 'clock'
  | 'persona';

export type IconSlot = FunctionalIcon | 'hexagon';

export type SlotPosition = 'tl' | 'bl' | 'bc' | 'br';

export type SplayDirection = 'none' | 'left' | 'right' | 'up' | 'aslant';

export type SpecialAchievementId =
  | 'monument'
  | 'empire'
  | 'world'
  | 'wonder'
  | 'universe';

export type GameVariant = '1v1' | '1v1v1' | '2v2';

export type ControlMode = 'vs_ai' | 'pass_and_play';

export type AIBackend =
  | 'heuristic'
  | 'td'
  | 'td_easy'
  | 'td_medium'
  | 'td_hard'
  | 'td_full';

export type GamePhase = 'setup' | 'playing' | 'gameover';

export type WinReason =
  | 'achievements'
  | 'score_age12'
  | 'card_effect'
  | 'elimination';

export interface CardIcons {
  tl: IconSlot;
  bl: IconSlot;
  bc: IconSlot;
  br: IconSlot;
}

export interface CardAbility {
  index: number;
  icon: FunctionalIcon;
  isDemand: boolean;
  text: string;
}

export interface CardDefinition {
  id: string;
  rawId: string;
  age: Age;
  set: 'base';
  name: string;
  color: CardColor;
  icons: CardIcons;
  featuredIcon: FunctionalIcon;
  abilities: CardAbility[];
  isPlaceholder: boolean;
}

export interface CardInstance {
  instanceId: string;
  defId: string;
  age: Age;
  set: 'base';
  name: string;
  color: CardColor;
  icons: CardIcons;
  featuredIcon: FunctionalIcon;
  abilities: CardAbility[];
  isPlaceholder: boolean;
}

export interface CardBack {
  instanceId: string;
  age: Age;
  set: 'base';
  source?: 'standard' | 'chain';
}

export interface ColorStack {
  color: CardColor;
  /** Index 0 is bottom card; last element is top card */
  cards: CardInstance[];
  splay: SplayDirection;
}

export type PlayerBoard = Record<CardColor, ColorStack>;

export interface ClaimedAchievement {
  id: string;
  kind: 'standard' | 'special' | 'chain';
  age?: Age;
  specialId?: SpecialAchievementId;
  card?: CardInstance;
}

export interface PlayerState {
  id: string;
  name: string;
  isAI: boolean;
  aiBackend?: AIBackend;
  teamId: string;
  eliminated: boolean;
  hand: CardInstance[];
  board: PlayerBoard;
  scorePile: CardInstance[];
  achievements: ClaimedAchievement[];
}

export interface SpecialAchievementDef {
  id: SpecialAchievementId;
  name: string;
  description: string;
  altCardName: string;
  altCardAge: Age;
}

export type ZoneRef =
  | { kind: 'hand'; playerId: string }
  | { kind: 'score'; playerId: string }
  | { kind: 'board_top'; playerId: string; color: CardColor }
  | { kind: 'board_bottom'; playerId: string; color: CardColor }
  | { kind: 'deck'; age: Age }
  | { kind: 'standard_achievements' }
  | { kind: 'junk' };

export type PendingPrompt =
  | {
      id: string;
      kind: 'setup_meld';
      playerId: string;
      title: string;
      options: CardInstance[];
    }
  | {
      id: string;
      kind: 'choose_cards';
      playerId: string;
      title: string;
      subtitle?: string;
      min: number;
      max: number;
      candidates: CardInstance[];
      sourceLabel: string;
      allowSkip?: boolean;
      skipLabel?: string;
    }
  | {
      id: string;
      kind: 'choose_color';
      playerId: string;
      title: string;
      subtitle?: string;
      options: CardColor[];
      allowSkip?: boolean;
      skipLabel?: string;
      splayDirection?: SplayDirection;
    }
  | {
      id: string;
      kind: 'choose_yes_no';
      playerId: string;
      title: string;
      subtitle?: string;
      confirmLabel: string;
      declineLabel: string;
    }
  | {
      id: string;
      kind: 'choose_value';
      playerId: string;
      title: string;
      subtitle?: string;
      options: Age[];
    }
  | {
      id: string;
      kind: 'choose_option';
      playerId: string;
      title: string;
      subtitle?: string;
      options: Array<{ id: string; label: string; description?: string }>;
    }
  | {
      id: string;
      kind: 'choose_order';
      playerId: string;
      title: string;
      cards: CardInstance[];
    };

export interface DogmaStep {
  abilityIndex: number;
  executingPlayerId: string;
  isDemand: boolean;
  /** Optional overrides when self-executing a target card */
  sourceCardDefId?: string;
  sourceCardName?: string;
  sourceAbility?: CardAbility;
  selfExecuteDepth?: number;
}

export interface DogmaSubState {
  phase: string;
  meldedCount?: number;
  tuckedColor?: CardColor;
  transferredCount?: number;
  chosenValue?: Age;
  chosenColor?: CardColor;
  chosenColors?: CardColor[];
  chosenIcon?: FunctionalIcon;
  remainingCount?: number;
  tempCards?: CardInstance[];
  targetAge?: Age;
}

export interface DogmaExecutionContext {
  activatingPlayerId: string;
  sourceCardDefId: string;
  sourceCardName: string;
  featuredIcon: FunctionalIcon;
  lockedAbilities: CardAbility[];
  /** Locked in at start of Dogma action */
  eligibleToShareIds: string[];
  vulnerableToDemandIds: string[];
  /** Non-activating teammate IDs (used in 2v2 so sharing with an ally grants no free draw) */
  teammateIds?: string[];
  /** Ordered execution queue locked in at Dogma start */
  steps: DogmaStep[];
  currentStepIndex: number;
  /** Tracks whether any sharing opponent caused something to happen to a card */
  anyOpponentSharedCardChange: boolean;
  /** Tracks whether any card was transferred during each ability's demand phase */
  demandTransferredByAbility?: Record<number, boolean>;
  /** Tracks whether any card was returned during each ability's demand phase (e.g. Vaccination) */
  demandReturnedByAbility?: Record<number, boolean>;
  /** Tracks cards returned per player during the current Dogma action (e.g. Democracy) */
  returnedByPlayer?: Record<string, number>;
  /** Mid-step interactive state for multi-prompt abilities */
  subState?: DogmaSubState | null;
  /** Tracks current self-execute nesting depth for the Chain Rule */
  selfExecuteDepth: number;
  /** Parent log entry ID for nesting Dogma sub-results under Action 1 / Action 2 */
  parentLogId?: string;
}

export interface ActionLogEntry {
  id: string;
  turn: number;
  actorId: string;
  actorName: string;
  actionTag?: string;
  message: string;
  parentLogId?: string;
}

export interface VictoryResult {
  winnerPlayerIds: string[];
  winnerTeamId: string | null;
  reason: WinReason;
  summary: string;
  finalScores: Record<string, number>;
  finalAchievements: Record<string, number>;
}

export interface OpponentMoveHighlight {
  kind: 'draw' | 'meld' | 'dogma' | 'achieve';
  color?: CardColor;
}

export interface AIDecisionFactorScore {
  factor: string;
  delta: number;
}

export interface AIDecisionCandidateTrace {
  label: string;
  actionType: TurnAction['type'];
  score: number;
  selected: boolean;
  breakdown?: AIDecisionFactorScore[];
}

export interface MatchChronologyEvent {
  id: string;
  turn: number;
  kind: 'achievement' | 'age_milestone';
  playerId: string;
  playerName: string;
  label: string;
  age?: Age;
  scoresByPlayer: Record<string, number>;
  achievementsByPlayer: Record<string, number>;
}

export interface RepeatDrawStepEvent {
  id: string;
  turn: number;
  actorId: string;
  actorName: string;
  sourceCardDefId: string;
  sourceCardName: string;
  stepNumber: number;
  card: CardInstance;
  repeats: boolean;
  badge: string;
  outcomeText: string;
}

export interface AIDecisionTrace {
  id: string;
  turn: number;
  actorId: string;
  actorName: string;
  actionLabel: string;
  situationSummary: string;
  chosenLabel: string;
  candidates: AIDecisionCandidateTrace[];
}

export interface GameConfig {
  variant: GameVariant;
  controlMode?: ControlMode;
  playerNames: string[];
  playerIsAI?: boolean[];
  playerAIBackends?: AIBackend[];
  seed?: number;
  manualEndTurn?: boolean;
  manualEndTurnForAI?: boolean;
  fastSimulation?: boolean;
}

export interface GameState {
  version: number;
  seed: number;
  rngState: number;
  variant: GameVariant;
  controlMode: ControlMode;
  fastSimulation?: boolean;
  phase: GamePhase;
  turnNumber: number;
  currentPlayerIndex: number;
  actionsRemaining: number;
  actionsTotalThisTurn?: 1 | 2;
  manualEndTurn?: boolean;
  manualEndTurnForAI?: boolean;
  /** Number of initial 1-action opening turns left (1 for 1v1/1v1v1, 2 for 2v2) */
  openingSingleActionTurnsRemaining: number;
  achievementTarget: number;
  players: PlayerState[];
  decks: Record<Age, CardInstance[]>;
  standardAchievements: CardInstance[];
  availableSpecialAchievements: SpecialAchievementId[];
  junk: CardInstance[];
  /** Cards legally revealed to all players during the current action/turn */
  revealedCardIds: string[];
  /** Setup choices collected before simultaneous reveal */
  setupSelections: Record<string, string>;
  pendingPrompts: PendingPrompt[];
  activeDogma: DogmaExecutionContext | null;
  /** Used for "this action" / "this effect" special checks */
  actionStats: {
    tuckedOrScoredCount: number;
  };
  lastTurnActionsByPlayer?: Record<string, OpponentMoveHighlight[]>;
  junkedStandardAges?: Age[];
  highestAgeReachedByPlayer?: Record<string, number>;
  chronologyEvents?: MatchChronologyEvent[];
  repeatDrawEvents?: RepeatDrawStepEvent[];
  log: ActionLogEntry[];
  victory: VictoryResult | null;
}

/**
 * Strictly sanitized observation passed to AI (and pass-and-play UI)
 * so hidden fronts (other hands, score piles, decks, standard achievements, junk)
 * are never accessible.
 */
export interface PublicPlayerView {
  id: string;
  name: string;
  isAI: boolean;
  aiBackend?: AIBackend;
  teamId: string;
  eliminated: boolean;
  handCount: number;
  handBacks: CardBack[];
  board: PlayerBoard;
  visibleIcons: Record<FunctionalIcon, number>;
  highestTopAge: number;
  scoreCount: number;
  scoreTotal: number;
  scoreBacks: CardBack[];
  achievementCount: number;
  achievementBacks: Array<{
    id: string;
    kind: 'standard' | 'special' | 'chain';
    age?: Age;
    specialId?: SpecialAchievementId;
  }>;
  revealedHandCards?: CardInstance[];
  revealedScoreCards?: CardInstance[];
}

export interface PlayerView {
  viewerId: string;
  variant: GameVariant;
  controlMode: ControlMode;
  phase: GamePhase;
  turnNumber: number;
  currentPlayerId: string;
  actionsRemaining: number;
  manualEndTurn: boolean;
  achievementTarget: number;
  viewer: {
    id: string;
    name: string;
    teamId: string;
    hand: CardInstance[];
    board: PlayerBoard;
    visibleIcons: Record<FunctionalIcon, number>;
    highestTopAge: number;
    scorePile: CardInstance[];
    scoreTotal: number;
    achievements: ClaimedAchievement[];
  };
  players: PublicPlayerView[];
  deckCounts: Record<Age, number>;
  standardAchievementBacks: CardBack[];
  availableSpecialAchievements: SpecialAchievementId[];
  junkCount: number;
  junkBacks: CardBack[];
  junkedStandardAges: Age[];
  pendingPromptForViewer: PendingPrompt | null;
  waitingOnPlayerId: string | null;
  lastTurnActionsByPlayer: Record<string, OpponentMoveHighlight[]>;
  log: ActionLogEntry[];
  victory: VictoryResult | null;
}

export type TurnAction =
  | { type: 'setup_meld'; playerId: string; cardInstanceId: string }
  | { type: 'draw'; playerId: string }
  | { type: 'meld'; playerId: string; cardInstanceId: string }
  | { type: 'dogma'; playerId: string; color: CardColor }
  | { type: 'achieve'; playerId: string; age: Age }
  | { type: 'end_turn'; playerId: string }
  | {
      type: 'answer_prompt';
      playerId: string;
      promptId: string;
      selectedCardIds?: string[];
      selectedColor?: CardColor;
      confirmed?: boolean;
      selectedValue?: Age;
      selectedOptionId?: string;
      orderedCardIds?: string[];
    };
