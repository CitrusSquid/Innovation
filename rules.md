# Innovation (4th Edition) — Rules Specification

> **Scope**: Base game (*Innovation* 4th Edition, Ages 1–11). Covers **1v1**, **1v1v1**, and **2v2 (Team)** variants. **1v1v1v1 (4-player free-for-all) and Parley rules are excluded.**

---

## 1. Components & Card Anatomy

- **11 Age Decks (Ages 1–11)**:
  1. Prehistory · 2. Classical · 3. Medieval · 4. Discovery · 5. Exploration · 6. Enlightenment · 7. Romance · 8. Modern · 9. Postmodern · 10. Information · 11. **Prudence** *(new in 4th Edition)*.
- **5 Colors**: `red`, `yellow`, `green`, `blue`, `purple`.
- **Card Anatomy**:
  - **Title**: Unique per card.
  - **Value**: Age number (`1`–`11`), printed on both front and back.
  - **Card Number**: Set prefix + number (e.g. `B 001` for Base).
  - **Four Icon Slots**: Top-Left (`TL`), Bottom-Left (`BL`), Bottom-Center (`BC`), Bottom-Right (`BR`).
  - **Seven Functional Icon Types**: `tower` *(castle)*, `coin` *(crown)*, `leaf`, `lightbulb`, `factory`, `clock`, and **`persona`** *(new in 4th Edition — man with blue background)*.
  - **Card Image (`hexagon`)**: Occupies one of the four slots on every card; provides no icon benefit and blocks that slot.
  - **Dogma Effects**: 1 or more effects, each preceded by the card's **Featured Icon** (the icon occurring most frequently on that card).
    - **Demand Effects** (dark box, always begin with `"I DEMAND"`): Attack vulnerable opponents.
    - **Non-Demand Effects** (light box): Shared by eligible opponents, then executed by the active player.
- **Info & Reference Cards**:
  - **Standard Achievements Info Card**: Holds face-down Standard Achievements (1 random card from each of Ages 1–10; **not Age 11**).
  - **5 Special Achievements**: `Monument`, `Empire`, `World`, `Wonder`, `Universe`.
  - **Junk Info Card**: Holds face-down **Junked** cards out of play.
  - **Player Reference Card**: Houses each player's **Score Pile** (tucked left, face-down) and **Achievements Pile** (tucked right, face-down).

---

## 2. Setup

1. Split cards into the 11 Age decks and shuffle each deck.
2. Draw 1 random face-down card from each of Ages **1 through 10** (not Age 11) and tuck them under the **Achievements** info card as **Standard Achievements**. (Never look at their fronts during setup or play.)
3. Place the **5 Special Achievements** and the **Junk** info card in the Supply Area.
4. Each player draws **2 cards from Age 1**, simultaneously chooses **1 to meld** face-up onto their board, and keeps the other in hand.
5. **First Player**: Determined by whose starting melded card title comes **first alphabetically**.
6. **Opening Turn Restriction**:
   - In **1v1** and **1v1v1**, the first player takes only **1 action** on their opening turn (all subsequent turns have 2 actions).
   - *(In **2v2**, the first two players each take only 1 action on their opening turns.)*

---

## 3. Hidden Information & Partial Observability

Card **backs** legally reveal a card's **Age value (1–11)** and **Set**.

| Zone | Owner Sees | Others (incl. Teammates) See |
| :--- | :--- | :--- |
| **Hand** | Front & Back | Back only (count + ages) |
| **Board** | Front & Back | Front & Back (visible stacks/splays) |
| **Score Pile** | Front & Back | Back only (count + ages) |
| **Claimed Achievements** | Back only | Back only (count + ages/source) |
| **Decks** | Back only | Back only |
| **Standard Achievements** | Back only | Back only |
| **Special Achievements** | Front & Back | Front & Back |
| **Junk Pile** | Back only | Back only |

---

## 4. Turn Structure & Actions

On your turn, take **2 actions** (First Action, Second Action) from the 4 action types; you may repeat the same action twice.

### A. Draw Action
- Draw 1 card into your hand from the deck matching the value of your **highest top card** on your board. If you have no cards on your board (or any missing card reference), its value is treated as **`0`**, so you skip to the next higher non-empty age (`1`, or higher if `1` is empty).
- **Empty Deck Skipping**: Whenever you would draw from an empty age for any reason, draw from the **next higher non-empty age** instead.
- **Age 12+ Game End**: Attempting to draw a card of value **12 or higher** (including skipping past an empty Age 11) **ends the game immediately**.
- *(Note: The free Draw Action earned from Dogma sharing does not count toward your 2 turn actions.)*

### B. Meld Action
- Place a card from your hand face-up onto your board on top of the matching color stack (or start a new stack).
- If that color stack is already splayed, **continue the splay** in the same direction.

### C. Achieve Action
- Claim any **1 available Standard Achievement** if you satisfy **both** conditions:
  1. Your Score Pile total is at least **`5 × achievement age`**. *(Points are a threshold and are NOT spent.)*
  2. You have a **top card** on your board of value **`>= achievement age`**.
- Place the claimed achievement face-down under the right side of your Reference Card. Once claimed (or junked), it is no longer available.

### D. Dogma Action
Executed in 4 sequential phases:

1. **Choose a Card**: Select any **top card** on your board.
2. **Lock In Effects & Eligibility**:
   - **Only two things lock in** at the start of the Dogma action: (a) the list of effects on the chosen card, and (b) each opponent's eligibility/vulnerability based on visible counts of the card's **Featured Icon** at that exact moment.
   - Even if the chosen card is moved or covered mid-action, all its effects still execute. All other board/hand/icon checks evaluate dynamically at the moment each effect runs.
   - **Eligible to Share**: Any opponent with `>=` your visible count of the Featured Icon.
   - **Vulnerable to Demand**: Any opponent with `<` your visible count of the Featured Icon.
3. **Execute Effects (in order)**:
   - Complete one effect entirely before moving to the next.
   - **Non-Demand Effect**: Each eligible sharing opponent executes it in clockwise order (starting from your left), then **you** execute it.
   - **Demand Effect (`I DEMAND ...`)**: Read aloud to each vulnerable opponent in clockwise order (starting from your left); each vulnerable opponent executes it (`I/me/my` = active player; `you/your/yours` = demanded opponent). Non-vulnerable opponents and the active player do nothing.
   - **Golden Rule**: *"Do as much as you can, ignore the rest."*
   - **Optionality**: Only effects/clauses preceded by `"you may"` are optional; everything else is mandatory, even if detrimental.
   - **Ties**: When forced to pick among tied cards (e.g., highest/lowest), the executing player chooses freely.
   - **Verification**: Whenever hidden card identity matters for legal execution, reveal the relevant card(s) to verify.
   - **Conditionals (`If you do` / `If you don't`)**: Always refer to the **entire previous sentence** of that effect; the condition is satisfied only if you met/just met it and actually did something (more than nothing).
4. **Sharing Free Draw**:
   - After all effects on the card finish, if **at least one** opponent eligible to share caused **something to happen to a card** (draw, meld, tuck, score, return, exchange, transfer, splay, achieve, junk, etc. — **revealing alone does NOT count**), you take **1 free Draw Action**.
   - Vulnerable players executing Demands never grant a free Draw Action.

---

## 5. Splaying Rules (4th Edition)

A color stack on a board is in one of 5 states: `unsplayed`, `left`, `right`, `up`, or `aslant`.

| Splay State | Slots Exposed Per Covered Card | Count of Exposed Slots |
| :--- | :--- | :--- |
| **Unsplayed** | None (only top card's 4 slots are visible) | 0 |
| **Left** | `BR` | 1 |
| **Right** | `TL`, `BL` | 2 |
| **Up** | `BL`, `BC`, `BR` | 3 |
| **Aslant** *(new in 4th Ed)* | `TL`, `BL`, `BC`, `BR` | 4 |

- **Minimum Stack Size**: A color with `0` or `1` card **cannot be splayed**. If a splayed stack is reduced to `0` or `1` card, it resets to `unsplayed` (does not remember prior splay).
- **Direction Rules**:
  - Cannot splay a color in the **same direction** it is already splayed.
  - Splaying in a **new direction** unsplays it first, then splays in the new direction.

---

## 6. Dogma Keywords & Mechanics

- **"All cards"**: Resolve one card at a time until no qualifying cards remain.
- **Available Achievement**: Unowned (neither claimed nor junked) Standard or Special Achievement. When an effect junks an available Standard Achievement of a given value (e.g., `1` or `2`), the player selects among eligible face-down Standard Achievements by their visible card-back age and places it face-down into the Junk pile.
- **Bottom**: Bottom card of a color pile (if 1 card in pile, it is both top and bottom).
- **Draw and X**: Draw from specified age (skipping empty ages), then apply `X` (`meld`, `tuck`, `score`, etc.). `'Draw and reveal'` places the card in hand unless taken away by the effect.
- **Exchange**: Swap cards between two locations, even if one side is empty. Exchanged cards do **not** count as scored/melded/drawn for Special Achievements.
- **Highest / Lowest**: Based on age value (`1`–`11`); executing player breaks ties.
- **Junk** *(4th Ed)*: Place card face-down under the Junk card (out of play; fronts cannot be inspected; unaffected unless a card explicitly references the Junk). **Junking a deck** junks every card currently in that deck.
- **Lose**: Eliminated player junks all their cards and is skipped in turn order and adjacency.
- **Return**: Place card face-down on the bottom of its corresponding Age deck (choose order if returning multiple simultaneously).
- **Reveal**: Show front to all players; card stays in its current zone unless moved by effect.
- **Score**: Place card face-down into Score Pile.
- **Self-execute**: Execute all **non-demand** effects of target card in order, ignoring Demand effects and **never sharing** regardless of icon counts. Target card stays where it is unless moved by the executed effects.
  - **Chain Rule**: If *while self-executing* a card's effect you would perform `"self-execute"`, **first draw and achieve an 11**, awarding yourself a **Chain Achievement** (repeatable up to the size of the Age 11 deck).
- **"This effect" / "This action"**: Scoped to since the start of the current single effect vs. since the start of the current player action.
- **Transfer**: Move a card from one area in play to another. Does not count as melding/scoring/achieving. A card transferred to a board becomes a **top card** (continuing splay if splayed).
- **Tuck**: Place card on the **bottom** of its matching color stack on your board, continuing any splay (or creating a new stack).
- **Value**: Age (`1`–`11`). Missing card reference (e.g., top purple card when none exists) has value `0`. Choosing a card value must be `1`–`11`.

---

## 7. Special Achievements & Victory Conditions

### Special Achievements
Claimed without spending an action at the end of any action (unless claimed directly via card effect). If multiple players qualify simultaneously, the **first qualifying player clockwise starting to the left of the current player** claims it.

1. **Empire**: At least **3** visible icons on your board of each of these 6 types: `tower`, `coin`, `leaf`, `lightbulb`, `factory`, `clock` — *or via Construction (Age 2)*.
2. **Monument**: At least **4 top cards with a DEMAND effect** on your board — *or via Masonry (Age 1)*.
3. **World**: At least **12 `clock` icons** visible on your board — *or via Translation (Age 3)*.
4. **Wonder**: **5 colors splayed** on your board, each splayed `right`, `up`, or `aslant` — *or via Invention (Age 4)*.
5. **Universe**: **5 top cards**, each of value **at least 8** — *or via Astronomy (Age 5)*.
6. **Chain Achievement** *(via Chain Rule)*: Achieved by drawing an Age 11 card during nested `self-execute`.

### Four Ways to Win

1. **Achievements** *(checked at the end of each action, after Special Achievements)*:
   - **1v1 (2 players)**: **6** achievements.
   - **1v1v1 (3 players)**: **5** achievements.
   - **2v2 (Team)**: **6** combined team achievements.
   - Tie-breaker if multiple hit target in same action: highest achievement count wins; if still tied, first tied player clockwise from current player's left wins.
2. **Score (Age 12+ Draw)** *(checked immediately when attempting to draw Age 12+)*:
   - Highest Score Pile total wins (combined team score in 2v2).
   - Tie-breaker: most achievements; if still tied, game is a **draw**.
3. **Card Effect**:
   - Immediate win when condition is met. If an effect specifies *"the single player with X"* and X is tied, that portion of the effect is ignored.
4. **Elimination**:
   - All opponents (or opposing team) lose/concede -> remaining player/team wins immediately.

---

## 8. 2v2 Team Rules

- Teammates sit across from each other.
- Teammates are **never** vulnerable to your Demands and are **never** treated as an `"opponent"`.
- Teammates are treated as **Others** for Hidden Information (you cannot look at your teammate's hand or score pile).
- Achievements pool toward the team's **6-achievement** win target, though each player claims Standard Achievements using only their own Score Pile and board.
- If an individual player wins, their team wins; if an individual loses, their teammate may concede or keep playing.
