import { GoogleGenAI } from "@google/genai";
import { Player, GameLog, ActionType, Role, PendingAction } from "../types";
import { ACTION_DETAILS } from "../constants";

const getAiClient = () => {
    const apiKey = process.env.API_KEY;
    if (!apiKey) return null;
    return new GoogleGenAI({ apiKey });
};

export const generateAiMove = async (
    bot: Player,
    players: Player[],
    gameHistory: GameLog[],
    pendingAction: PendingAction | null,
    phase: string
): Promise<{ action: string; targetId?: string; decision?: string }> => {
    const ai = getAiClient();
    if (!ai) {
        console.warn("No API Key found, using fallback random AI");
        return fallbackAiLogic(bot, players, pendingAction);
    }

    // Prepare a richer context for the AI
    const recentLogs = gameHistory.slice(-20).map(l => l.message); // Increased history
    
    const gameStateSummary = {
        myId: bot.id,
        myName: bot.name,
        myCoins: bot.coins,
        myLiveCards: bot.cards.filter(c => !c.revealed).map(c => c.role),
        allPlayers: players.map(p => ({
            id: p.id,
            name: p.name,
            coins: p.coins,
            liveCardsCount: p.cards.filter(c => !c.revealed).length,
            isEliminated: p.isEliminated
        })),
        phase: phase,
        pendingAction: pendingAction,
        lastLogs: recentLogs,
    };

    const prompt = `
    You are playing the board game "Coup". You are a bot named ${bot.name} (ID: ${bot.id}).
    Your goal is to be the last player standing.

    Current Game State:
    ${JSON.stringify(gameStateSummary, null, 2)}

    Valid Actions:
    - Income (+1 coin)
    - Foreign Aid (+2 coins, blockable by Duke)
    - Tax (+3 coins, claims Duke, challengeable)
    - Steal (+2 coins from target, claims Captain, blockable by Captain/Ambassador)
    - Exchange (swap cards, claims Ambassador)
    - Assassinate (-3 coins, eliminates influence, claims Assassin, blockable by Contessa)
    - Coup (-7 coins, unblockable, eliminates influence)

    STRATEGIC GUIDELINES:
    1. **Analyze History (IMPORTANT)**: Look at 'lastLogs'. 
       - If you recently tried to bluff (e.g., Tax without a Duke) and were challenged, DO NOT try that same action again immediately.
       - If you tried to Steal from someone and they blocked you, choose a different target or action.
       - Avoid repeating the same action (like Income) more than twice in a row; it makes you predictable.
    
    2. **Turn Logic (Phase: TurnStart)**:
       - **Must Coup**: If you have >= 10 coins, you must choose 'Coup'.
       - **Finishing Move**: If you have >= 7 coins, prefer 'Coup' to eliminate a strong rival (high coins or 2 cards).
       - **Aggression**: If you have < 7 coins, prefer collecting coins quickly (Tax, Foreign Aid, Steal) over Income.
       - **Bluffing**: It is okay to bluff (e.g., Tax without Duke), but check if opponents have been challenging recently.
       - **Targeting**: When Stealing or Assassinating, target players with many coins (threats) or players with 1 card left (easy kill).

    3. **Reaction Logic (Phase: ActionPending)**:
       - If someone acts against you (e.g., Steal on you), and you have the blocker card, BLOCK it.
       - If you don't have the blocker, mostly Pass, unless you want to risk a bluff block.
       - If someone claims a role you hold (e.g., they claim Duke but you have 2 Dukes), CHALLENGE them!

    4. **Block Response (Phase: BlockPending)**:
       - If someone blocks you, and you actually have the card required for your action, CHALLENGE their block.
       - If you were bluffing, PASS (accept the block) to avoid losing a card.

    Output strictly valid JSON:
    {
      "decision": "ActionName" (e.g. "Tax", "Coup") or "Challenge" or "Block" or "Pass",
      "targetId": "TargetPlayerID" (Required for Steal, Coup, Assassinate. Optional otherwise.)
    }
    `;

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-3-flash-preview',
            contents: prompt,
            config: {
                responseMimeType: 'application/json',
                temperature: 1.0, // High creativity to vary moves
            }
        });

        const text = response.text;
        if (!text) throw new Error("Empty response from Gemini");
        const result = JSON.parse(text);
        
        // Basic validation ensuring target exists if needed
        if (['Steal', 'Coup', 'Assassinate'].includes(result.decision) && !result.targetId) {
            // Auto-pick a target if AI forgot
            const validTargets = players.filter(p => !p.isEliminated && p.id !== bot.id);
            if (validTargets.length > 0) {
                // Pick richest target
                result.targetId = validTargets.sort((a,b) => b.coins - a.coins)[0].id;
            }
        }

        return {
            action: result.decision,
            targetId: result.targetId,
            decision: result.decision
        };
    } catch (error: any) {
        // Fallback
        if (error?.status === 429 || error?.code === 429 || error?.message?.includes('429')) {
             console.warn("Gemini Quota Exceeded. Switching to basic AI.");
        } else {
             console.error("Gemini Error:", error);
        }
        return fallbackAiLogic(bot, players, pendingAction);
    }
};

const fallbackAiLogic = (bot: Player, players: Player[], pendingAction: PendingAction | null) => {
    const aliveOpponents = players.filter(p => !p.isEliminated && p.id !== bot.id);
    // Prefer target with most coins
    const target = aliveOpponents.length > 0 
        ? aliveOpponents.sort((a,b) => b.coins - a.coins)[0]
        : null;

    if (pendingAction) {
        if (pendingAction.actorId !== bot.id) {
             // Block if we have the card
             const actionDetails = ACTION_DETAILS[pendingAction.action];
             const myBlockers = actionDetails.blockableBy || [];
             const hasBlocker = bot.cards.some(c => !c.revealed && myBlockers.includes(c.role));
             
             // High chance to block if we have the card, low chance to bluff block
             if (hasBlocker && Math.random() > 0.1) return { action: 'Block', decision: 'Block' };
             if (!hasBlocker && Math.random() < 0.15) return { action: 'Block', decision: 'Block' };

             // Challenge logic: check if we have conflicting info (e.g. 3 dukes revealed/held means they are lying)
             // Simple random challenge for now
             if (Math.random() < 0.05) return { action: 'Challenge', decision: 'Challenge' };
        }
        return { action: 'Pass', decision: 'Pass' };
    }

    const safeTargetId = target ? target.id : (players.find(p => p.id !== bot.id)?.id); 

    if (bot.coins >= 10) return { action: ActionType.Coup, targetId: safeTargetId };
    
    // Weighted Random choices based on cards
    const liveRoles = bot.cards.filter(c => !c.revealed).map(c => c.role);
    
    if (bot.coins >= 7) return { action: ActionType.Coup, targetId: safeTargetId };

    if (liveRoles.includes(Role.Assassin) && bot.coins >= 3) {
         return { action: ActionType.Assassinate, targetId: safeTargetId };
    }
    
    if (liveRoles.includes(Role.Captain)) {
        return { action: ActionType.Steal, targetId: safeTargetId };
    }
    
    if (liveRoles.includes(Role.Duke)) {
        return { action: ActionType.Tax };
    }

    // If no specific cards, random distribution
    const roll = Math.random();
    if (roll < 0.4) return { action: ActionType.Income };
    if (roll < 0.7) return { action: ActionType.ForeignAid };
    if (roll < 0.9) return { action: ActionType.Tax }; // Bluff tax
    return { action: ActionType.Exchange };
};
