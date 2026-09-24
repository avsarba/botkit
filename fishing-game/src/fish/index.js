// Fish module entry (see CONTRACT.md "Fish").
//   SPECIES, rollFish(speciesId, rng)        species facts + random catch (species.js, fish-behavior)
//   createFishMesh(species, lengthCm, opts)  procedural fish model (mesh.js, fish-mesh)
//   createFishSystem(ctx)                    population AI, bites and hooked-fish physics (system.js, fish-behavior)
export { SPECIES, SPECIES_BY_ID, getSpecies, rollFish, lengthFromWeight, weightFromLength, lightLevel, lowLightLevel } from './species.js';
export { createFishMesh } from './mesh.js';
export { createFishSystem, HookedFish } from './system.js';
