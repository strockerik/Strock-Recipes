# Research Brief: Food, Wine, Beer & Cocktail Pairing Reference
### For "Pair a drink with this meal" — The House Index

---

## TL;DR

Pairing is not folklore. Wine and beer both have accredited certification bodies (WSET, Court of Master Sommeliers, Cicerone, Brewers Association) that teach pairing as a **small set of repeatable sensory interactions**, not a lookup table. That's good news for a system prompt: the whole domain compresses into ~5 principles per beverage plus a dish-archetype map, and the model can derive the rest.

The three categories differ in how formally codified they are:

| Category | Codification | Best sources | Confidence |
|---|---|---|---|
| **Wine** | High — testable content on WSET L2/L3 and CMS exams | WSET Global, Wine Folly, sommelier education | High |
| **Beer** | High — Cicerone syllabus, Brewers Association official guide | Cicerone.org, CraftBeer.com (BA) | High |
| **Cocktails** | Low — no certification body owns it; trade-press consensus only | Punch, Wine Enthusiast, WSET (spirits) | Medium |

Four things worth flagging up front:

1. **Food acts on the drink more than the reverse.** WSET teaches this explicitly. Your prompt should tell the model to reason "what will this dish do to the drink," not "what flavors sound nice together."
2. **The single highest-leverage rule is the sweetness rule.** The drink must be at least as sweet as the dish, or the dish strips it. This is where naive models fail most often (recommending dry Cabernet with chocolate cake).
3. **"IPA with spicy food" is a real, widespread, wrong answer** that the model will produce from training data. The Brewers Association's own consumer site published a piece debunking it. Worth an explicit line in the prompt.
4. **Recommending a TYPE rather than a bottle is exactly what the education bodies do** in their consumer-facing material. Your framing is defensible with almost no caveating.

---

## Key Findings

- **Six food components matter** (fat, salt, acid, sugar, umami, chili heat) and **six drink components** (acid, tannin, sweetness, alcohol, body, carbonation). Every pairing is an interaction between two of those. WSET's Level 3 syllabus assesses candidates on explaining pairings by reference to these components rather than by tradition.
- **Salt and acid in food SOFTEN a wine** (less astringent, less bitter, fruitier, fuller). **Sugar, umami, and chili heat HARDEN a wine** (more astringent, more bitter, more alcoholic burn). This asymmetry is the engine behind nearly every classic pairing — including steak-and-Cabernet, which works because salt and fat on the steak dismantle the tannin.
- **Tannin binds to fat and protein.** This is a physical mechanism, not a metaphor: tannins complex with fat molecules instead of your salivary proteins, which is why a harsh red mellows against a fatty ribeye or a high-fat cheese.
- **Umami is the trap.** Mushrooms, aged cheese, soy, shellfish amplify bitterness and tannin. WSET notes umami-with-low-salt (asparagus, eggs, ripe soft cheese) is genuinely difficult; umami-with-salt (cured meat, hard cheese) is fine because the salt cancels it out. This is why Pinot Noir — not Cabernet — is the mushroom answer.
- **Beer's framework is "the 3 C's": Complement, Contrast, Cut**, layered on top of **match intensity first**. Cicerone's own exam framework is: (1) match intensities, (2) find complementary aromas/flavors, (3) find contrasting tastes, (4) discuss cutting. Advanced levels add "accentuate, soften, cancel."
- **Beer's contrasting levers, per the Brewers Association**: hop bitterness balances sweetness and richness; roasted malt balances sweetness; carbonation balances richness; alcohol balances richness; sweetness balances chili heat and acidity; hop bitterness *emphasizes* chili heat.
- **That last item is the IPA/spice problem.** Hop iso-alpha acids and capsaicin amplify each other — bitterness makes the heat register harder, and the heat makes the bitterness register harder. Beer is mostly water, so it can't dissolve capsaicin away the way high-ABV ethanol or fat can. Residual malt sugar is what actually helps.
- **Cocktail pairing is deliberately rare in restaurants** — Punch reported that most serious bar programs *don't* offer it. Betony's Eamon Rockey: high alcohol, acidity, sweetness, and bitterness are "not the most food-friendly." But the professionals who do it converge on a consistent set of workarounds (below), which is enough to build a defensible cheat sheet from.
- **The cocktail workaround is low-ABV.** Rockey builds around cider, Champagne, vermouth, herbs, and citrus to get "effervescence, a controllable amount of acidity and bitters, and a lower alcohol content." Sherry- and vermouth-based drinks (Bamboo, Adonis) sip like a spirituous cocktail while leaving the food tastable.
- **Serving-order convention is real and old**: aperitif = dry, bitter, citrusy, low-ABV, appetite-stimulating (sweetness kills appetite); digestif = sweeter/bitter/herbal, higher ABV, small pour, after the meal. Wine Enthusiast's Brandon Ristaino is explicit that a Negroni belongs at aperitivo and should be avoided at the entrée or after.
- **Portion size is part of the pairing.** Full-spirit dinner pairings run 2–3 oz. Punch's Rouge Tomate account describes a full cocktail-paired tasting menu that left the writer "pleasantly buzzed but not drunk" specifically because the drinks were modestly sized and not overly boozy.

---

## Details

### 1. Food & Wine

#### 1.1 The universal principles

These are the mechanisms; everything downstream is application.

1. **Match intensity/body.** Delicate dish → delicate wine; bold dish → bold wine. When a sauce dominates, pair to the sauce, not the protein.
2. **The wine should be at least as sweet as the dish.** Sugar in food makes a dry wine taste thin, sour, and bitter. This is the least forgiving rule.
3. **The wine should be at least as acidic as the dish.** Acid in food moderates acid perception in wine; a low-acid wine next to a tart dish reads flat.
4. **Acid (and carbonation) cuts fat.** High-acid wines stimulate salivation and scrub the palate.
5. **Tannin needs fat and protein.** Fat neutralizes astringency. Salt does the same. Tannin + umami without salt = harsh.
6. **Alcohol amplifies chili heat, and heat amplifies tannin.** Spicy dish → low-ABV, low-tannin, off-dry.
7. **Regional pairing ("what grows together goes together")** is a legitimate shortcut, not a cop-out — Chianti with Tuscan tomato ragù, Muscadet with Loire-adjacent oysters. These combinations survived because they satisfy one or more of the mechanisms above.

**Known hard cases:** dark chocolate (bitter-on-bitter with tannic reds); asparagus, eggs, artichoke (umami without salt); anything vinegar-forward. Punch quotes beverage director Scott Cameron: vinegar is "the enemy of wine" — which is precisely the gap a cocktail can fill.

#### 1.2 Dish archetypes → wine types

| Archetype | Wine types | Mechanism |
|---|---|---|
| Grilled/roasted red meat | Cabernet Sauvignon / Bordeaux blend, Syrah, Nebbiolo | Salt + fat bind tannin; intensity match |
| Cream sauce, butter sauce, soft rich cheese | Traditional-method sparkling, oaked Chardonnay, Chenin Blanc | Acid + bubbles cut fat; body match |
| Goat cheese, vinaigrette, green salad | Sauvignon Blanc, Grüner Veltliner | Wine acid must meet dish acid |
| Spicy Asian / Mexican | Off-dry Riesling, Gewürztraminer, dry rosé | Sugar tempers heat; low ABV avoids amplifying burn |
| Fried / fatty | Champagne, Cava, Muscadet, Chablis | Acid + carbonation scrub fat |
| Light seafood / shellfish | Muscadet, Albariño, Chablis (Blanc de Blancs) | High acid, saline, no aromatic domination |
| Tomato-forward Italian | Sangiovese (Chianti), Barbera, Aglianico | High-acid wine vs. high-acid dish; regional |
| Earthy / mushroom (umami) | Pinot Noir, Grüner Veltliner, aged Nebbiolo | Low tannin + acid; congruent earthy notes |
| Cured meat / hard aged cheese | Fino or Amontillado Sherry, tannic reds, sparkling | Salt softens tannin; salt cancels umami |
| Roast chicken / pork | Chardonnay, Pinot Noir, dry Riesling | Body match; versatile mid-weight |
| Dessert | Sauternes, Moscato d'Asti, Port (ruby/tawny for chocolate) | Wine sweeter than the dish |

**Sourcing note:** every row above appears in one or more of WSET's own teaching material, Wine Folly's pairing chart, or sommelier-program curricula. The mushroom→Pinot Noir, oyster→Muscadet/Champagne, and Chianti→tomato pairings are the canonical textbook examples cited in CMS/WSET practical training.

---

### 2. Food & Beer

#### 2.1 The universal principles

From the Brewers Association's *American Craft Beer and Food* guide (text by Randy Mosher, distributed by Cicerone) plus the Cicerone exam framework:

1. **Match strength with strength.** Intensity = alcoholic strength + malt character + hop bitterness + sweetness + richness + roastiness + sourness + fermentation character.
2. **Find harmonies (complement).** Shared flavor elements: brown ale's nuttiness with cheddar; imperial stout's roast with chocolate; Oktoberfest's caramel with roast pork.
3. **Create contrasts.** The BA's official interaction chart:
   - Hop bitterness **balances** sweetness
   - Roasted malt **balances** sweetness
   - Carbonation **balances** richness (fat)
   - Alcohol **balances** richness (fat)
   - Sweetness **balances** chili heat
   - Hop bitterness **EMPHASIZES** chili heat
   - Sweetness **balances** acidity
4. **Cut.** Carbonation, bitterness, and sourness lift fat and coating richness off the palate — beer's structural advantage over wine.
5. **Look to classic cuisines.** Schnitzel with pale lager, witbier with mussels, dry stout with oysters.

#### 2.2 Dish archetypes → beer styles

| Archetype | Beer styles | Mechanism |
|---|---|---|
| Grilled/charred red meat, BBQ | Porter, dry stout, Scotch ale, doppelbock | Roast malt resonates with Maillard char |
| Fried/fatty, burgers, fish & chips | Pilsner, pale ale, moderate IPA | Carbonation + bitterness cut fat |
| Light seafood, sushi, salads | Pilsner, witbier, hefeweizen, kölsch | Delicate intensity; witbier classic with mussels |
| Spicy Asian / Mexican | Witbier, hefeweizen, amber lager/Vienna, dubbel | Malt sweetness tempers heat; **avoid high-IBU IPA** |
| Cream sauce, soft cheese | Saison, gose/Berliner Weisse, IPA (for blue) | Acid + carbonation cut; hop aroma bridges to funk |
| Roast chicken / pork | Oktoberfest/Märzen, amber lager, pale ale | Caramel malt complement |
| Tomato-forward Italian | Pilsner, saison, amber ale | Crisp bitterness vs. acidity; peppery yeast |
| Earthy / mushroom | Brown ale, dunkel, saison | Nutty/roasty resonance with earth |
| Dessert / chocolate | Imperial stout, abbey dubbel or strong dark, fruit lambic | Beer at least as intense as the dessert |

**On IPA and spice, specifically.** The BA's chart says hop bitterness emphasizes chili heat, and CraftBeer.com — the BA's own consumer publication — ran a piece arguing directly against the conventional "IPA with spicy food" advice: high alpha-acid content and high capsaicin amplify each other, making the bitter more bitter and the spicy more spicy. Beer's water content means it can't wash capsaicin away the way sufficient ethanol would; carbonation itself also activates pain receptors. The recommendation that survives is residual sweetness and lower IBU.

**On IPA and very sweet dessert.** The BA guide explicitly recommends double IPA for super-sweet items (carrot cake, cheesecake, crème brûlée) — bitterness balancing sugar. But a Cicerone-prep source pushes back on the carrot-cake case specifically, arguing a maltier beer works better and that the pairing is repeated online without testing. **Recommendation: keep "bitter balances very sweet dessert" as a principle; don't hard-code carrot cake + American IPA.**

---

### 3. Food & Cocktails

This is the section where you should hold your claims loosest. There is no Cicerone for cocktails. What follows is trade-press consensus, not curriculum.

#### 3.1 What the professionals actually say

Punch's 2015 survey of cocktail-pairing programs (Rouge Tomate, Atera, Betony, Meadowood, Faith & Flower) is the single most useful primary source and yields these principles:

1. **It's hard, and pros mostly don't do it.** Rockey (Betony): things high in alcohol, acidity, sweetness, and bitterness are not food-friendly. Faith & Flower's Michael Lay doesn't offer a pairing option — too challenging, not enough demand.
2. **Start from the plate.** Cameron (Atera): "The dish is complete. How can I complement it?"
3. **Find where wine can't go.** Vinegar-forward dishes, extreme heat, some desserts. This is cocktails' actual competitive advantage — it's the reason to offer the feature at all.
4. **Layering like flavors works.** Levy (Meadowood) pairs a chocolate-cherry tart with a cherry-liqueur bourbon drink. "Cherry will always taste good with more cherry."
5. **The sweetness rule holds, same as wine.** Cameron: the drink needs to be at least as sweet as the dish or the dessert crushes the cocktail's character — but tempered with fruit acidity so it isn't cloying.
6. **Go low-ABV at the center.** Rockey looks for cider, Champagne, vermouth, herbs, and citrus — "effervescence, a controllable amount of acidity and bitters, and a lower alcohol content."
7. **Don't overthink it.** Punch's closing line: go with what sounds like the most logical match. Cameron's own shorthand — Martini with oysters and mignonette; whiskey cocktail with steak or rich stew; rum drink with something braised.

WSET's spirits-side guidance (the only certification-body content on cocktail pairing I found) mirrors the wine framework almost exactly: match intensity, complement or contrast, balance sweetness and acidity, use temperature and texture, and lean on regional pairing.

#### 3.2 Cocktail styles → dish archetypes

| Cocktail style | Suits | Mechanism |
|---|---|---|
| **Sour / citrus-forward** (Daiquiri, Margarita, Whiskey Sour, Tom Collins) | Fried food, tacos, grilled seafood, rich salads, soft cheese | Citric acid cuts fat exactly as wine acid does; often mirrors lime already on the plate |
| **Bitter / stirred spirit-forward** (Old Fashioned, Manhattan, Negroni, Sazerac) | Steak, porchetta, braises, gumbo, charcuterie | Booziness complements fat; bitterness cleanses palate and balances char |
| **Herbal / botanical** (Martini, G&T, Last Word, Julep) | Oysters, shellfish, herb-roasted chicken, lamb | Salinity affinity; herbal notes bridge to herbs in the dish |
| **Tiki / rum** (Daiquiri variants, rum punch, tropical builds) | Braised meat, jerk chicken, Caribbean, spicy | Sweetness balances heat; regional logic |
| **Highball / effervescent** (G&T, spritz, Japanese highball, shandy) | Anything mid-meal; fried food, cured meat, cheese | ~5% ABV, carbonation, palate-cleansing — the safest with-the-meal option |

**Well-attested specific pairs from Wine Enthusiast's professional panel** (useful as few-shot examples): Old Fashioned + steak (sweetness enhances umami, bitterness balances char); Martini + oysters/shellfish (shared salinity — but a Martini will amplify any chili heat "like adding gas to a fire"); Whiskey Sour + fish and chips; Negroni + cicchetti (aperitivo only); Manhattan + roast chicken thigh or porchetta; Sazerac + duck confit or gumbo (entrée cocktail, neutral sweetness); Tom Collins + Caesar salad; Mint Julep + roast lamb; Last Word + al pastor tacos (sweetness cools the heat).

#### 3.3 Serving order and ABV

- **Aperitif:** dry, bitter, citrusy, effervescent, low-ABV. Sweetness suppresses appetite; heavy/creamy fills the stomach; spirit-forward on an empty stomach hits hard. Negroni, spritz, G&T, dry Martini, Champagne cocktails.
- **With the meal:** the constraint case. Small pours (2–3 oz for full-spirit builds). Prefer low-ABV backbones — sherry, vermouth, cider, sparkling wine, beer shandies. Keep flavors subtle enough not to bulldoze the plate. A big fatty meal wants effervescence and acidity, not a second Old Fashioned.
- **Digestif:** after the meal. Sweeter, bitterer, herbal, higher ABV, small pour. Amaro, brandy, fortified wine, Old Fashioned–style builds.
- **Dilution matters as a pairing variable, not just a technique.** Cameron gives a pre-meal Martini riff extra stirs specifically for more chill and dilution. Batching a stirred cocktail requires adding ~20–25% water to stand in for the ice that won't be there.

---

### 4. Type, not brand: is the framing defensible?

Yes, comfortably — for consumer-facing pairing content specifically.

- **WSET** frames pairing at the level of *style*: "if you've been recommended a great pairing, and it's a style of wine you loathe…" Their worked example says a salty ribeye works with Barolo, and then immediately: if you don't want to splash out, *any* high-acidity, high-tannin red will do. The mechanism is the recommendation; the bottle is interchangeable.
- **Wine Folly's** entire pairing chart maps dishes to grape varieties and wine styles, not producers.
- **The Brewers Association's** official beer-and-food guide is built around a 28-row chart of *beer types* (Kölsch, Witbier, Doppelbock, Imperial Stout…) with suggested foods, cheeses, desserts, glassware, and serving temperature. No brands appear in the pairing chart at all — and this is a trade-association publication that could have promoted members' brands and chose not to.
- **The BA guide's cooking-with-beer section** does the same thing: "Beer suggestions: pale or amber lightly hopped lager or ale."

**One honest nuance to keep in your back pocket:** at the *professional* end, Cicerone's Advanced and Master exams require candidates to select a **specific commercial beer** for a dish — because at that level, style alone is too coarse a unit (two IPAs at 45 and 90 IBU behave differently against the same plate). So the accurate framing isn't "naming brands is wrong"; it's "**type-level recommendation is the standard convention in consumer education content, and it's the right granularity for a home cook choosing from whatever's at the store**." That's a stronger and more honest defense than claiming brands are never named.

---

## Recommendations

Three blocks below, ~600 words combined, written for near-verbatim paste into the Haiku system prompt alongside `CUISINE FLAVOR BASES`.

```
WINE PAIRING PRINCIPLES
- Match intensity: delicate dish -> delicate wine. Pair to the sauce, not the protein.
- Wine must be at least as sweet as the dish, or the dish strips it.
- Wine should be at least as acidic as the dish.
- Acid and bubbles cut fat. Tannin needs fat/protein/salt to soften.
- Alcohol amplifies chili heat; heat amplifies tannin. Spicy -> low-ABV, low-tannin, off-dry.
- Umami (mushroom, aged cheese, soy) amplifies tannin unless salt is present.
- Regional logic is valid: what grows together goes together.

WINE BY DISH ARCHETYPE
- Grilled/roasted red meat -> Cabernet Sauvignon, Syrah, Nebbiolo. Salt+fat bind tannin.
- Cream/butter sauce, soft rich cheese -> traditional-method sparkling, oaked Chardonnay,
  Chenin Blanc. Acid and carbonation cut the fat; body matches.
- Goat cheese, vinaigrette, green salad -> Sauvignon Blanc, Gruner Veltliner. Acid meets acid.
- Spicy Asian/Mexican -> off-dry Riesling, Gewurztraminer, dry rose. Sweetness tempers heat;
  low alcohol avoids amplifying the burn.
- Fried/fatty -> Champagne or Cava, Muscadet, Chablis. Acid and bubbles scrub the palate.
- Light seafood/shellfish -> Muscadet, Albarino, Chablis. High acid, saline, non-dominating.
- Tomato-forward Italian -> Sangiovese/Chianti, Barbera, Aglianico. The wine's acid must
  meet the tomato's; regional classic.
- Earthy/mushroom -> Pinot Noir, aged Nebbiolo, Gruner Veltliner. Low tannin plus congruent
  earthiness; big tannin turns harsh against umami.
- Cured meat/hard aged cheese -> Fino or Amontillado Sherry, tannic red, sparkling. Salt
  softens tannin.
- Roast chicken/pork -> Chardonnay, Pinot Noir, dry Riesling. Mid-weight body match.
- Dessert -> Sauternes, Moscato d'Asti, Port. The wine must out-sweet the dish. Dark
  chocolate is hard: bitter on bitter.

BEER PAIRING PRINCIPLES
- Match intensity first, then complement, contrast, or cut.
- Carbonation and alcohol balance richness. Hop bitterness and roasted malt balance sweetness.
- Malt sweetness tempers chili heat. Hop bitterness AMPLIFIES chili heat -- avoid high-IBU
  IPA with spicy food.
- Sourness and acidity refresh the palate against cream and fat.

BEER BY DISH ARCHETYPE
- Grilled/charred red meat, BBQ -> porter, dry stout, Scotch ale. Roast malt echoes the char.
- Fried/fatty, burgers, fish and chips -> pilsner, pale ale, moderate IPA. Carbonation plus
  bitterness cut fat.
- Light seafood, sushi, salads -> pilsner, witbier, hefeweizen, kolsch. Witbier is the
  classic with mussels.
- Spicy Asian/Mexican -> witbier, hefeweizen, amber/Vienna lager, abbey dubbel. Residual
  malt sweetness cools the heat.
- Cream sauce/soft cheese -> saison, gose or Berliner Weisse; IPA for blue cheese.
- Roast chicken/pork -> Oktoberfest/Marzen, amber lager, pale ale. Caramel malt complement.
- Tomato-forward Italian -> pilsner, saison, amber ale. Crisp bitterness against the acidity.
- Earthy/mushroom -> brown ale, dunkel, saison. Nutty roast meets earth.
- Dessert/chocolate -> imperial stout, abbey dubbel or strong dark ale, fruit lambic. Match
  the dessert's intensity; roast resonates with cocoa.

COCKTAIL PAIRING PRINCIPLES
- Less codified than wine or beer -- these are professional conventions, not rules.
- Cocktails are high in alcohol, acid, sugar, and bitterness, which makes them harder to
  pair. The fix is low ABV: build on sherry, vermouth, cider, sparkling wine, or a highball.
- Mid-meal, keep pours small (2-3 oz for spirit-forward) and let dilution do work.
- Drink at least as sweet as the dish, cut with citrus so it isn't cloying.
- Cocktails win where wine fails: vinegar-forward dishes, big chili heat, rich desserts.
- Order: aperitif = dry, bitter, citrusy, low-ABV (sweetness kills appetite). With the meal =
  effervescent and low-ABV. Digestif = sweeter, bitter, herbal, small pour.

COCKTAIL BY DISH ARCHETYPE
- Grilled red meat, braises -> bitter/stirred spirit-forward (Old Fashioned, Manhattan,
  Sazerac). Sweetness lifts umami; bitterness balances char and cleanses fat.
- Fried/fatty, tacos, rich salads -> sour/citrus-forward (Margarita, Whiskey Sour, Daiquiri,
  Tom Collins). Citrus acid cuts fat and mirrors lime already on the plate.
- Oysters, shellfish, herb-roasted chicken, lamb -> herbal/botanical (Martini, G&T, Last
  Word, Julep). Salinity and herb affinity. Note: a Martini amplifies chili heat.
- Spicy, jerk, Caribbean -> tiki/rum or anything with real sweetness. Sugar cools capsaicin.
- Cream sauce, cheese, charcuterie, anything mid-meal -> highball/spritz/effervescent.
  Bubbles plus low ABV keep the palate live across a long meal.
- Dessert -> layer like with like (cherry drink for a cherry tart) and out-sweet the plate;
  or an amaro/bitter digestif as contrast.
```

---

## Caveats

1. **Cocktail confidence is materially lower than wine or beer.** If the UI shows any confidence signal, cocktails should carry it. The Punch reporting makes clear this is a niche practice even among top bar programs — the honest framing to a user is "here's what bartenders who do this reach for," not "the classic pairing is."
2. **Palate variation is real and taught as such.** WSET explicitly notes taste-bud density varies enormously between people and tells students no expert can anticipate a guest's preference. The model should not be absolutist. A hedge line ("these are starting points, not rules") is defensible and matches how the certification bodies themselves write.
3. **I did not verify the underlying capsaicin/iso-alpha-acid chemistry against primary literature.** The claim is asserted consistently across CraftBeer.com (Brewers Association), food-science-adjacent trade press, and matches the BA's own official interaction chart — but the popular sources cite each other more than they cite papers. Treat "hop bitterness amplifies heat" as well-attested trade consensus, not settled peer-reviewed fact.
4. **The BA guide dates to 2009.** Its style taxonomy predates hazy/NEIPA, pastry stout, and the modern sour explosion. The principles are intact; the style list is incomplete. Hazy IPA in particular is now the commonly recommended IPA for spicy food (lower IBU, fuller body, juicy fruit) — that's post-guide and less well-sourced.
5. **The "IPA + carrot cake" pairing is contested even within Cicerone-prep material**, despite appearing in the BA guide. I left it out of the cheat sheet deliberately. Any pairing you see repeated identically across many blogs is a candidate for the same problem.
6. **Wine Enthusiast is trade press, not education.** Its cocktail pairings are sourced to named beverage directors and sommeliers, which is why I used it — but they are individual professional opinion, not consensus.
7. **The brief avoids brands throughout**, with one unavoidable exception: some cocktail names are proprietary in practice (Pimm's Cup, Aperol Spritz, Negroni's Campari). If your no-commercial-products rule is strict, "bitter aperitif spritz" and "gin-and-bitter-liqueur stirred drink" are the type-level substitutes, at some cost to clarity.
8. **Not covered, but adjacent and possibly worth a follow-up:** sake (WSET has a full three-level qualification and pairing is a taught component), cider, and non-alcoholic pairing — the last of which Punch's sources treated as a first-class category with its own program, not an afterthought.

---

## Sources

**Certification bodies / official education**
- Wine & Spirit Education Trust — *Four rules to masterful food and wine pairing* (James Gore DipWSET), wsetglobal.com
- Wine & Spirit Education Trust — *Food and cocktail pairing: the summer BBQ edition* (2024), wsetglobal.com
- WSET Level 2 / Level 3 Award in Wines syllabus content on food-and-wine taste interactions (via educator and course-provider summaries)
- Brewers Association — *American Craft Beer and Food: Perfect Companions*, text and design by Randy Mosher (2009). Hosted at cicerone.org/sites/default/files/resources/Beer_and_Food_English.pdf
- Cicerone Certification Program — *Exam Tactics: How to Present Beer and Food Pairing Knowledge in Advanced and Master Exams*, cicerone.org
- CraftBeer.com (Brewers Association) — *Science Says You're Wrong About Pairing IPAs and Spicy Foods*

**Trade press**
- Punch — *Can Food and Cocktails Really Pair Well?*, Dan Saltzstein (Jan 2015). Interviews: Pascaline Lepeltier (Rouge Tomate), Scott Cameron (Atera), Eamon Rockey (Betony), Sam Levy (Meadowood), Michael Lay & Jared Hooper (Faith & Flower)
- Wine Enthusiast — *What to Eat with Your Favorite Classic Cocktails*, Dakota Kim (Apr 2024). Interviews: Robert Elliot (Ocean Prime BH), Anthony Lygizos (Leven Deli), Brandon Ristaino (Good Lion Hospitality), Mac Gregory (Pacifica Hotels)

**Wine education / reference**
- Wine Folly — *Food and Wine Pairing Basics*, *Basic Wine and Food Pairing Chart*, *Simple Science of Food and Wine Pairing*, winefolly.com

**Secondary / corroborating**
- The Beer Scholar — Certified Cicerone practice-exam answers (pairing formula, carrot-cake dissent)
- MasterClass — *How to Pair Cocktails With Food*, drawing on Lynnette Marrero and Ryan Chetiyawardana
- Michelin Guide — *Ask the Experts: Daniel Goh* (beer and spice interaction summary)
