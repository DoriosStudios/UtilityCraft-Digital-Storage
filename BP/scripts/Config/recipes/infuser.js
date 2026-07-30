import * as DoriosLib from "DoriosLib/index.js";

const infuserRecipes = {
    "utilitycraft:diamond_dust|minecraft:quartz": {
        output: "utilitycraft:fluxite",
        required: 1,
        input_required: 1,
        amount: 1
    }
};

DoriosLib.registry.registerInfuserRecipe(infuserRecipes);
