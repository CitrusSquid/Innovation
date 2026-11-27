export type ShowOpponentMovesMode = 'off' | 'dogma' | 'full';
export type LayoutMode = 'auto' | 'landscape' | 'portrait';
export type CardSizeMode = 'small' | 'medium' | 'large';
export type MobileViewMode = 'large_swipe' | 'compact' | 'large_vertical';

export interface AppSettings {
  autoEndTurn: boolean;
  showOpponentMoves: ShowOpponentMovesMode;
  highlightOpponentLastTurn: boolean;
  achievementPopups: boolean;
  cardSize: CardSizeMode;
  expandedHand: boolean;
  layoutMode: LayoutMode;
  mobileViewMode: MobileViewMode;
  mobileNavBar: boolean;
  colorBlindMode: boolean;
  debugUnlocked: boolean;
  debugRevealHidden: boolean;
  debugShowAiDecisions: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  autoEndTurn: true,
  showOpponentMoves: 'dogma',
  highlightOpponentLastTurn: true,
  achievementPopups: true,
  cardSize: 'small',
  expandedHand: false,
  layoutMode: 'auto',
  mobileViewMode: 'compact',
  mobileNavBar: false,
  colorBlindMode: false,
  debugUnlocked: false,
  debugRevealHidden: false,
  debugShowAiDecisions: false,
};

const SETTINGS_STORAGE_KEY = 'innovation_4e_settings_v1';

export function loadSettings(): AppSettings {
  try {
    if (typeof window === 'undefined' || !window.localStorage) {
      return { ...DEFAULT_SETTINGS };
    }
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return {
      autoEndTurn: typeof parsed.autoEndTurn === 'boolean' ? parsed.autoEndTurn : DEFAULT_SETTINGS.autoEndTurn,
      showOpponentMoves:
        parsed.showOpponentMoves === 'off' ||
        parsed.showOpponentMoves === 'dogma' ||
        parsed.showOpponentMoves === 'full'
          ? parsed.showOpponentMoves
          : DEFAULT_SETTINGS.showOpponentMoves,
      highlightOpponentLastTurn:
        typeof parsed.highlightOpponentLastTurn === 'boolean'
          ? parsed.highlightOpponentLastTurn
          : DEFAULT_SETTINGS.highlightOpponentLastTurn,
      achievementPopups:
        typeof parsed.achievementPopups === 'boolean'
          ? parsed.achievementPopups
          : DEFAULT_SETTINGS.achievementPopups,
      cardSize:
        parsed.cardSize === 'small' || parsed.cardSize === 'medium' || parsed.cardSize === 'large'
          ? parsed.cardSize
          : DEFAULT_SETTINGS.cardSize,
      expandedHand: typeof parsed.expandedHand === 'boolean' ? parsed.expandedHand : DEFAULT_SETTINGS.expandedHand,
      layoutMode:
        parsed.layoutMode === 'auto' || parsed.layoutMode === 'landscape' || parsed.layoutMode === 'portrait'
          ? parsed.layoutMode
          : DEFAULT_SETTINGS.layoutMode,
      mobileViewMode:
        parsed.mobileViewMode === 'large_swipe' ||
        parsed.mobileViewMode === 'compact' ||
        parsed.mobileViewMode === 'large_vertical'
          ? parsed.mobileViewMode
          : DEFAULT_SETTINGS.mobileViewMode,
      mobileNavBar:
        typeof parsed.mobileNavBar === 'boolean' ? parsed.mobileNavBar : DEFAULT_SETTINGS.mobileNavBar,
      colorBlindMode:
        typeof parsed.colorBlindMode === 'boolean' ? parsed.colorBlindMode : DEFAULT_SETTINGS.colorBlindMode,
      debugUnlocked:
        typeof parsed.debugUnlocked === 'boolean'
          ? parsed.debugUnlocked
          : DEFAULT_SETTINGS.debugUnlocked,
      debugRevealHidden:
        typeof parsed.debugRevealHidden === 'boolean'
          ? parsed.debugRevealHidden
          : DEFAULT_SETTINGS.debugRevealHidden,
      debugShowAiDecisions:
        typeof parsed.debugShowAiDecisions === 'boolean'
          ? parsed.debugShowAiDecisions
          : DEFAULT_SETTINGS.debugShowAiDecisions,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: AppSettings): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Ignore storage quota / sandbox restrictions
  }
}

export const AUTO_HORIZONTAL_MIN_WIDTH = 900;
export const AUTO_HORIZONTAL_MIN_ASPECT_RATIO = 1.25;

export function computeIsHorizontalView(
  layoutMode: LayoutMode,
  viewportWidth: number,
  viewportHeight: number
): boolean {
  if (layoutMode === 'landscape') return true;
  if (layoutMode === 'portrait') return false;
  const safeHeight = Math.max(1, viewportHeight);
  const aspectRatio = viewportWidth / safeHeight;
  return (
    viewportWidth >= AUTO_HORIZONTAL_MIN_WIDTH &&
    aspectRatio >= AUTO_HORIZONTAL_MIN_ASPECT_RATIO
  );
}
