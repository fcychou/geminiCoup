import { Role, ActionType } from './types';

export const ROLES = [Role.Duke, Role.Assassin, Role.Captain, Role.Ambassador, Role.Contessa];

export const ACTION_DETAILS: Record<ActionType, { cost: number; description: string; blockableBy?: Role[]; challengeable: boolean }> = {
  [ActionType.Income]: { cost: 0, description: "Take 1 coin", challengeable: false },
  [ActionType.ForeignAid]: { cost: 0, description: "Take 2 coins", blockableBy: [Role.Duke], challengeable: false },
  [ActionType.Coup]: { cost: 7, description: "Pay 7 coins to eliminate an influence", challengeable: false },
  [ActionType.Tax]: { cost: 0, description: "Take 3 coins (Claim Duke)", challengeable: true },
  [ActionType.Assassinate]: { cost: 3, description: "Pay 3 coins to eliminate an influence (Claim Assassin)", blockableBy: [Role.Contessa], challengeable: true },
  [ActionType.Steal]: { cost: 0, description: "Take 2 coins from another player (Claim Captain)", blockableBy: [Role.Captain, Role.Ambassador], challengeable: true },
  [ActionType.Exchange]: { cost: 0, description: "Exchange cards with deck (Claim Ambassador)", challengeable: true },
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  [Role.Duke]: "Tax (3 coins), Block Foreign Aid",
  [Role.Assassin]: "Assassinate (3 coins)",
  [Role.Captain]: "Steal (2 coins), Block Steal",
  [Role.Ambassador]: "Exchange cards, Block Steal",
  [Role.Contessa]: "Block Assassination",
};

export const ROLE_COLORS: Record<Role, string> = {
  [Role.Duke]: "text-purple-400",
  [Role.Assassin]: "text-gray-400",
  [Role.Captain]: "text-blue-400",
  [Role.Ambassador]: "text-green-400",
  [Role.Contessa]: "text-red-400",
};