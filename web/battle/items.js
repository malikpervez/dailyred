// What a held item does, in plain words, for the team page and the battle
// summary. Covers every item Daily Red hands out (BATTLE_ITEMS and the
// type-boosting items in team.js) and RED's; anything else falls back to
// Pokémon Showdown's own short description.
const HELP = {
  choiceband: "Attack ×1.5, but it's locked into the first move it uses. Switch it out to pick a different move.",
  leftovers: 'Heals 1/16 of its HP at the end of every turn.',
  shellbell: 'Heals 1/8 of the damage it deals.',
  quickclaw: 'Sometimes (20% of turns) lets it move first.',
  kingsrock: 'Its attacks get a 10% chance to make the target flinch and lose its turn.',
  scopelens: 'Lands critical hits more often.',
  brightpowder: 'Attacks against it are 10% less likely to hit.',
  focusband: '10% chance to survive a knockout hit with 1 HP left.',
  whiteherb: 'Once per battle: undoes any lowered stats.',
  mentalherb: 'Once per battle: cures infatuation (Attract).',
  lumberry: 'Once per battle: cures sleep, poison, burn, paralysis, freezing or confusion.',
  sitrusberry: 'Once per battle: heals 30 HP when it drops to half HP or less.',
  chestoberry: 'Once per battle: wakes it up if it falls asleep.',
  liechiberry: 'Once per battle: raises Attack when it drops to 1/4 HP or less.',
  salacberry: 'Once per battle: raises Speed when it drops to 1/4 HP or less.',
  petayaberry: 'Once per battle: raises Sp. Atk when it drops to 1/4 HP or less.',
  lightball: "Doubles Pikachu's Sp. Atk.",
};

// `item`: a Showdown item (dex.items.get(...)). Returns '' for no item.
export function itemHelp(item) {
  if (!item?.exists) return '';
  if (HELP[item.id]) return HELP[item.id];
  // Silk Scarf, Charcoal, Mystic Water...: "Holder's Fire-type attacks have 1.1× power."
  const boost = /^Holder's (\w+)-type attacks have 1\.1× power\.$/.exec(item.shortDesc ?? '');
  if (boost) return `Its ${boost[1]}-type moves do 10% more damage.`;
  return item.shortDesc ?? '';
}
