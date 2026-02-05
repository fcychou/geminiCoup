export enum Role {
  Duke = 'Duke',
  Assassin = 'Assassin',
  Captain = 'Captain',
  Ambassador = 'Ambassador',
  Contessa = 'Contessa',
}

export enum ActionType {
  Income = 'Income',
  ForeignAid = 'Foreign Aid',
  Coup = 'Coup',
  Tax = 'Tax',
  Assassinate = 'Assassinate',
  Steal = 'Steal',
  Exchange = 'Exchange',
}

export interface Card {
  id: string;
  role: Role;
  revealed: boolean;
}

export interface Player {
  id: string;
  name: string;
  isAi: boolean;
  coins: number;
  cards: Card[];
  isEliminated: boolean;
}

export interface GameLog {
  id: string;
  message: string;
  timestamp: number;
  type: 'info' | 'action' | 'challenge' | 'error';
}

export interface GameAction {
  type: ActionType;
  actorId: string;
  targetId?: string;
  blockedBy?: string; // If blocked
  challengedBy?: string; // If challenged
}

export enum GamePhase {
  Setup = 'Setup',
  TurnStart = 'TurnStart',
  ActionPending = 'ActionPending', // Waiting for challenges/blocks
  BlockPending = 'BlockPending', // Waiting for challenges to the block
  ChooseInfluenceToLose = 'ChooseInfluenceToLose',
  ExchangeCards = 'ExchangeCards',
  Resolving = 'Resolving', // Transitional phase to ensure state consistency
  GameOver = 'GameOver',
}

export interface PendingAction {
  action: ActionType;
  actorId: string;
  targetId?: string;
  blockerId?: string; // If currently being blocked
}

// AI Communication types
export interface AiDecision {
  action: ActionType | 'Challenge' | 'Block' | 'Pass';
  targetId?: string;
  cardToKeep?: Role[]; // For exchange
  cardToReveal?: Role; // For losing influence
}