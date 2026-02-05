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

    // Simplified state for AI context
    const gameStateSummary = {
        myId: bot.id,
        myCoins: bot.coins,
        myLiveCards: bot.cards.filter(c => !c.revealed).map(c => c.role), // AI knows its cards
        allPlayers: players.map(p => ({
            id: p.id,
            coins: p.coins,
            liveCardsCount: p.cards.filter(c => !c.revealed).length,
            isEliminated: p.isEliminated
        })),
        phase: phase,
        pendingAction: pendingAction,
        lastLogs: gameHistory.slice(-5).map(l => l.message),
    };

    const prompt = `
    You are playing a game of Coup. You are a bot named ${bot.name} (ID: ${bot.id}).
    Your goal is to be the last player standing.
    
    Current Game State:
    ${JSON.stringify(gameStateSummary, null, 2)}

    Valid Actions & Costs:
    Income (+1), Foreign Aid (+2), Tax (+3, claims Duke), Steal (+2, claims Captain), Exchange (claims Ambassador), Assassinate (-3, claims Assassin), Coup (-7).

    Instructions:
    1. If it is your turn to act (Phase: TurnStart), choose an action. If you have >= 10 coins, you MUST Coup.
    2. If someone else acted (Phase: ActionPending), decide whether to 'Challenge', 'Block' (if eligible), or 'Pass'.
    3. If you are being blocked (Phase: BlockPending), decide whether to 'Challenge' the block or 'Pass'.
    4. Play somewhat aggressively but logically. Bluff if necessary but prefer actions supported by your cards.
    
    Output JSON ONLY:
    {
      "decision": "ActionName" or "Challenge" or "Block" or "Pass",
      "targetId": "TargetPlayerID" (if applicable for Steal, Coup, Assassinate, or Block/Challenge)
    }
    `;

    try {
        const response = await ai.models.generateContent({
            model: 'gemini-3-flash-preview',
            contents: prompt,
            config: {
                responseMimeType: 'application/json'
            }
        });

        const text = response.text;
        if (!text) throw new Error("Empty response from Gemini");
        const result = JSON.parse(text);
        return {
            action: result.decision,
            targetId: result.targetId,
            decision: result.decision
        };
    } catch (error: any) {
        // Handle Quota limits gracefully to keep game running
        if (error?.status === 429 || error?.code === 429 || error?.message?.includes('429')) {
             console.warn("Gemini Quota Exceeded. Switching to basic AI for this turn.");
        } else {
             console.error("Gemini Error:", error);
        }
        return fallbackAiLogic(bot, players, pendingAction);
    }
};

const fallbackAiLogic = (bot: Player, players: Player[], pendingAction: PendingAction | null) => {
    // Simple fallback logic if API fails or not present
    const aliveOpponents = players.filter(p => !p.isEliminated && p.id !== bot.id);
    const target = aliveOpponents.length > 0 
        ? aliveOpponents[Math.floor(Math.random() * aliveOpponents.length)]
        : null;

    if (pendingAction) {
        // Reaction logic
        if (pendingAction.actorId !== bot.id) {
             // 10% chance to challenge if appropriate, mostly pass for simple fallback
             if (Math.random() < 0.1) return { action: 'Challenge', decision: 'Challenge' };
             
             // Block logic
             if (pendingAction.action === ActionType.Steal && pendingAction.targetId === bot.id) {
                // Always try to block steal if targetted
                 return { action: 'Block', decision: 'Block' };
             }
             if (pendingAction.action === ActionType.Assassinate && pendingAction.targetId === bot.id) {
                 return { action: 'Block', decision: 'Block' };
             }
             if (pendingAction.action === ActionType.ForeignAid) {
                 // 20% chance to block aid
                 if (Math.random() < 0.2) return { action: 'Block', decision: 'Block' };
             }
        }
        return { action: 'Pass', decision: 'Pass' };
    }

    // Turn logic
    // Must target someone for Coup/Assassinate/Steal
    const safeTargetId = target ? target.id : (players.find(p => p.id !== bot.id)?.id); 

    if (bot.coins >= 10) return { action: ActionType.Coup, targetId: safeTargetId };
    if (bot.coins >= 7) return { action: ActionType.Coup, targetId: safeTargetId };
    if (bot.coins >= 3) return { action: ActionType.Assassinate, targetId: safeTargetId };
    
    const roll = Math.random();
    if (roll < 0.3) return { action: ActionType.Tax };
    if (roll < 0.6) return { action: ActionType.ForeignAid };
    if (roll < 0.8) return { action: ActionType.Steal, targetId: safeTargetId };
    return { action: ActionType.Income };
};