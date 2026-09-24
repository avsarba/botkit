// Display-only fallback for the journal and catch card: common name, scientific name and a
// short field-guide note per species id. The fish module owns the real species data
// (src/fish/species.js); if core passes it as ctx.species / ctx.config.species, the UI uses
// that instead and this table only fills gaps (e.g. a sandbox without the fish module).
export const FIELD_GUIDE = Object.freeze({
  bluegill: {
    name: 'Bluegill',
    latin: 'Lepomis macrochirus',
    blurb: 'A deep-bodied sunfish with a black ear flap and a copper-orange breast in spawning males. Schools in weedy shallows and nests in colonies of saucer-shaped beds.',
  },
  yellow_perch: {
    name: 'Yellow Perch',
    latin: 'Perca flavescens',
    blurb: 'Six to eight dark saddles over a brassy yellow body, with orange lower fins. Travels in loose schools along weed edges and near the bottom.',
  },
  rainbow_trout: {
    name: 'Rainbow Trout',
    latin: 'Oncorhynchus mykiss',
    blurb: 'Stocked in cold, well-oxygenated northern lakes. Pink band along the side, small black spots over the back and tail. Often jumps when hooked.',
  },
  smallmouth_bass: {
    name: 'Smallmouth Bass',
    latin: 'Micropterus dolomieu',
    blurb: 'Bronze-brown with faint vertical bars and a red eye; the jaw stops below the eye. Holds on rock and gravel and fights hard for its size.',
  },
  largemouth_bass: {
    name: 'Largemouth Bass',
    latin: 'Micropterus salmoides',
    blurb: 'Green with a dark, broken stripe along the side; the upper jaw reaches past the eye. Ambushes prey from weeds, docks and lily pads.',
  },
  walleye: {
    name: 'Walleye',
    latin: 'Sander vitreus',
    blurb: 'Large, glassy eyes gather light, so it feeds at dawn, dusk and after dark. Look for the white tip on the lower lobe of the tail.',
  },
  channel_catfish: {
    name: 'Channel Catfish',
    latin: 'Ictalurus punctatus',
    blurb: 'Deeply forked tail, eight barbels and scattered dark spots on young fish. Finds food by taste and smell, and feeds mostly at night.',
  },
  northern_pike: {
    name: 'Northern Pike',
    latin: 'Esox lucius',
    blurb: 'A long ambush predator: rows of pale, bean-shaped spots on a green body and a duck-bill snout full of teeth. Lies in the weeds and strikes in a burst.',
  },
  muskellunge: {
    name: 'Muskellunge',
    latin: 'Esox masquinongy',
    blurb: 'Dark bars or spots on a light body and pointed tail lobes, the reverse of a pike. Rare and very large; anglers call it the fish of ten thousand casts.',
  },
});
