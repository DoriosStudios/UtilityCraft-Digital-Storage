import * as DoriosLib from "DoriosLib/index.js";

const infuserRecipes = {
    "utilitycraft:diamond_dust|minecraft:amethyst_shard": {
        output: "utilitycraft:fluxite",
        required: 2,
        amount: 1
    }
};

DoriosLib.registry.registerInfuserRecipe(infuserRecipes);
