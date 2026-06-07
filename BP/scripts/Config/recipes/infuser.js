import { system, world } from "@minecraft/server";

const infuserRecipes = {
    "utilitycraft:diamond_dust|minecraft:amethyst_shard": {
        output: "utilitycraft:fluxite",
        required: 2,
        amount: 1
    }
};

world.afterEvents.worldLoad.subscribe(() => {
    system.sendScriptEvent("utilitycraft:register_infuser_recipe", JSON.stringify(infuserRecipes));
});
