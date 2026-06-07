import { system } from "@minecraft/server";

export const crafterRecipes = {
}

/**
 * ScriptEvent receiver: "utilitycraft:register_crafter_recipe"
 *
 * Allows other addons or scripts to dynamically add or replace Crafter recipes.
 * The key must contain exactly 9 comma-separated entries.
 *
 * Expected payload format (JSON):
 * ```json
 * {
 *   "iron_ingot,iron_ingot,iron_ingot,air,redstone,air,iron_ingot,iron_ingot,iron_ingot": {
 *     "output": "utilitycraft:machine_case",
 *     "amount": 1
 *   },
 *   "bucket,iron_ingot,bucket,iron_ingot,blast_furnace,iron_ingot,bucket,iron_ingot,bucket": {
 *     "output": "utilitycraft:molten_core",
 *     "amount": 1,
 *     "leftover": ["minecraft:bucket"]
 *   }
 * }
 * ```
 *
 * Behavior:
 * - Automatically adds new recipes if missing.
 * - Replaces existing ones when keys match.
 * - Supports optional `amount` and `leftover` properties.
 * - Only a summary log is printed after completion.
 */
system.afterEvents.scriptEventReceive.subscribe(({ id, message }) => {
    if (id !== "utilitycraft:register_crafter_recipe") return;

    try {
        const payload = JSON.parse(message);
        if (!payload || typeof payload !== "object") return;

        let added = 0;
        let replaced = 0;

        for (const [pattern, data] of Object.entries(payload)) {
            const slots = pattern.split(",");
            if (slots.length !== 9) {
                console.warn(`[UtilityCraft] Invalid Crafter pattern '${pattern}' (must have 9 slots).`);
                continue;
            }
            if (!data.output || typeof data.output !== "string") continue;

            if (crafterRecipes[pattern]) {
                replaced++;
            } else {
                added++;
            }

            crafterRecipes[pattern] = data;
        }
    } catch (err) {
        console.warn("[UtilityCraft] Failed to parse crafter registration payload:", err);
    }
});

// ==================================================
// EXAMPLES – How to register custom Crafter recipes
// ==================================================
/*
import { system, world } from "@minecraft/server";

world.afterEvents.worldLoad.subscribe(() => {
    // Add or replace Crafter recipes dynamically
    const newRecipes = {
        // Normal shaped recipe (3x3)
        "iron_ingot,iron_ingot,iron_ingot,air,redstone,air,iron_ingot,iron_ingot,iron_ingot": {
            output: "utilitycraft:machine_case",
            amount: 1
        },
        // Recipe with leftover bucket
        "bucket,iron_ingot,bucket,iron_ingot,blast_furnace,iron_ingot,bucket,iron_ingot,bucket": {
            output: "utilitycraft:molten_core",
            amount: 1,
            leftover: ["minecraft:bucket"]
        },
        // Replace existing
        "steel_ingot,iron_ingot,steel_ingot,gold_ingot,redstone_block,gold_ingot,steel_ingot,iron_ingot,steel_ingot": {
            output: "utilitycraft:machine_case_v2",
            amount: 2
        }
    };

    // Send the event to the Crafter script
    system.sendScriptEvent("utilitycraft:register_crafter_recipe", JSON.stringify(newRecipes));

    console.warn("[Addon] Custom Crafter recipes registered via system event.");
});

// You can also do this directly with a command inside Minecraft:
Command:
/scriptevent utilitycraft:register_crafter_recipe {"iron_ingot,iron_ingot,iron_ingot,air,redstone,air,iron_ingot,iron_ingot,iron_ingot":{"output":"utilitycraft:machine_case","amount":1},"bucket,iron_ingot,bucket,iron_ingot,blast_furnace,iron_ingot,bucket,iron_ingot,bucket":{"output":"utilitycraft:molten_core","amount":1,"leftover":["minecraft:bucket"]}}
*/
