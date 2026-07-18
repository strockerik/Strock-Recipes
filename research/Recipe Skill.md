# Research Brief: Building an AI "Hero Ingredient" Recipe Generator for the U.S. Home Cook

## TL;DR
- **Anchor the generator in a handful of high-frequency American cuisine "modes"** — Italian-American, Mexican/Tex-Mex, American comfort, Asian-American (soy/ginger/garlic), and Mediterranean — each mapped to weeknight formats (skillet, sheet pan, one-pot, stir-fry, soup/braise). Roughly 70% of Americans name American food a favorite cuisine, with Mexican, Chinese, and Italian the only other cuisines with double-digit popularity (Statista, Dec 2025).
- **Assume a standard pantry aggressively but confirm 1–2 "swing" items**: salt, pepper, cooking oil, olive oil, garlic, onion, butter, eggs, flour, sugar, rice, pasta, canned tomatoes, stock, soy sauce and common dried spices can be treated as on-hand; confirm only items that make-or-break the specific recipe (a specific cheese, fish sauce, fresh herbs).
- **Ask 3–5 friendly clarifying questions** (time, servings, dietary restrictions, cuisine lean, equipment) and integrate stored dietary preferences by default; produce ONE well-structured recipe with intro, yield/time, measured ingredients, technique-rich steps, tips/variations and a drink pairing. Actively guard against the documented AI failure modes: wrong ratios, untested "Frankenstein" combinations, unrealistic timing, and missing technique cues.

## Key Findings

1. **America cooks a narrow band of cuisines deeply.** American, Mexican/Tex-Mex, Chinese/Asian-American, and Italian-American dominate; Mediterranean, Indian, and Thai are rising. Comfort dishes (burgers, mashed potatoes, pasta, tacos, soups) rank highest in preference surveys.
2. **Weeknight cooking is format-driven, not recipe-driven.** The dominant formats are skillet/one-pan, sheet-pan, one-pot/Dutch oven, stir-fry, slow-cooker/Instant Pot, air fryer, and soup/stew. Meals are overwhelmingly built on a protein + vegetable + starch template.
3. **A predictable pantry can be assumed.** Cross-referencing multiple pantry checklists yields a stable core of ~30–40 items present in most U.S. kitchens; the generator should assume these and only shop for hero-adjacent specialty items.
4. **"Restaurant quality" comes from technique cues, not fancy ingredients** — seasoning in stages, building a fond/aromatics base, acid and fat balance, and resting/finishing steps. These are exactly what generic AI recipes omit.
5. **AI recipe generation fails in predictable, documented ways** — wrong quantities/ratios (LLMs are weak at math), stitched-together untested combinations, unrealistic timing, and missing food-safety/technique knowledge. The design must actively guard against these.
6. **Dietary personalization is a set-once-with-override problem.** True restriction rates are modest (vegetarian ~4%, vegan ~1%, gluten-free ~11% by self-report), but allergies are widespread (~11% of adults) and non-negotiable for safety, so stored preferences + hard allergen exclusions are the correct default.

## Details

### 1. Most Popular Food Genres & Dish Categories (2024–2026)

**Favorite cuisines.** In Statista's consumer research (published Dec 2025), about 70% of Americans named American food among their favorite cuisines, and only Mexican, Chinese, and Italian also achieved double-digit popularity. However, when foreign cuisines are rated head-to-head, Italian actually edges out home cooking: per YouGov's 24-market study of 25,000+ people, "Here in the U.S. among Americans, Italian food even beat out American cuisine with an 88 percent popularity score," with Mexican a close second (86%), followed by Chinese (84%), Spanish (79%), and Japanese (74%). By raw search demand, restaurant-furniture company Seating Masters' Google-search analysis of 35 cuisines (reported via Cheapism) found that "with nearly 8.6 million searches a month, Chinese is the most looked-up cuisine in the country," with Italian drawing "over 3 million monthly searches and 62,091 Italian restaurants" and Thai ~2.6M. (Search-volume figures vary by source; an alternate Seating Masters figure via Quality Assurance & Food Safety lists Chinese at 3.35M.) An Instacart-cited figure holds that Mexican is the single most popular *homemade* cuisine, closely followed by American.

**Takeaway for the generator:** Italian-American, Mexican/Tex-Mex, American comfort, and Chinese/Asian-American are the "home base." Mediterranean, Indian, and Thai are strong stretch options worth offering when hero ingredients suit them.

**Most popular dishes/foods.** YouGov and Statista preference rankings place these at the top: mashed potatoes (~85%), hamburgers/cheeseburgers (~84%), french fries, grilled cheese (~83%), steak and baked potatoes, corn on the cob (~81%), fried chicken (~80%), hash browns, steak and fries (~79%). Practical home-cooking staples that recur across sources: pasta (spaghetti, baked ziti, Alfredo, lasagna), tacos, pizza, chili, meatloaf, roast/rotisserie chicken, stir-fry, casseroles, soups (chicken noodle, broccoli cheddar, potato), pot roast, chicken parmesan, burgers, and sheet-pan chicken-and-vegetables. The Kitchn's state-by-state search analysis found soups & stews the single most popular dinner category nationwide, followed by chicken and beef dishes.

**Weeknight categories.** The categories Americans reach for on weeknights: one-pan/skillet chicken; pasta; tacos/burrito bowls; stir-fry; sheet-pan dinners; soups/chili; grain or "buddha" bowls; and quick roasts. Time pressure dominates: historically about half of Americans spend 30–60 minutes on a weeknight meal and only a small minority spend over an hour.

**Cooking methods.** The microwave is the single most-used appliance, but for actual cooking the popular home methods are: skillet/sauté, sheet-pan roasting, one-pot/Dutch oven, stir-fry (wok/skillet), slow cooker (Crockpot), Instant Pot/pressure cooker, air fryer, and grill. The air fryer surged in the early 2020s and remains a staple. Grill ownership jumped after 2020 (a large share of owners bought a new grill since the pandemic began).

**Regional preferences.** Recognized U.S. regional cuisine categories: New England (seafood, chowders, lobster rolls), Southern/Soul (fried chicken, biscuits, greens, cornbread, barbecue), Cajun/Creole (gumbo, jambalaya, étouffée; the "holy trinity" of onion/celery/bell pepper), Tex-Mex/Southwestern (chili con carne, enchiladas, green-chile dishes, cumin-forward), Midwest/Heartland (casseroles/"hotdish," beef, German-Scandinavian influence), Mid-Atlantic (cheesesteaks, crab), California/Pacific (produce-forward, fusion), and Hawaiian (Polynesian + East Asian). The generator should treat region as a light seasoning on the core cuisine modes rather than a hard constraint.

### 2. Standard American Pantry Staples (assume-on-hand logic)

Synthesized from Food Network, The Kitchn, Budget Bytes, Brightland, and other pantry checklists, here is a tiered model.

**Tier 1 — Assume without asking (near-universal):**
- *Dry/pantry:* all-purpose flour, white sugar, white and/or brown rice, dried pasta, salt, black pepper, at least one neutral cooking oil, canned/crushed tomatoes, canned beans.
- *Fridge:* butter, eggs, milk, ketchup, mustard, mayonnaise, some form of hot sauce.
- *Aromatics (pantry/fridge):* onions, garlic, potatoes.
- *Spice cabinet baseline:* garlic powder, onion powder, paprika, ground cumin, chili powder, crushed red pepper, dried oregano, dried basil, ground cinnamon; baking soda and baking powder.

**Tier 2 — "Almost universal," worth a quick confirm if the recipe hinges on it:**
- Extra-virgin olive oil, chicken/vegetable stock or broth, soy sauce, Worcestershire sauce, brown sugar, honey, vinegars (white, apple cider, red wine, or balsamic), Parmesan, cornstarch, breadcrumbs, tortillas, canned coconut milk, Dijon mustard, BBQ sauce, dried thyme/rosemary/bay leaves, sesame oil.

**Tier 3 — Do NOT assume; treat as hero-adjacent shopping items:**
- Fresh herbs (basil, cilantro, parsley), specialty cheeses (feta, mozzarella, goat), fish sauce, miso, specific fresh produce, wine for cooking, specialty proteins, gochujang/curry paste, buttermilk, heavy cream, nuts.

**Design rule:** Build the recipe primarily from the hero ingredients + Tier 1 + Tier 2, and never require more than 1–2 Tier 3 items — and only when the user has signaled willingness to do a quick grocery run.

### 3. Best Practices for AI Recipe Generation

**Clarifying questions (ask 3–5, conversational).** The highest-value questions, in priority order:
1. **Time/effort available** ("Quick 30-min weeknight, or something more involved?").
2. **Servings** (how many people / leftovers wanted).
3. **Dietary restrictions/allergies** — pulled from profile, confirmed not re-asked, unless none stored.
4. **Cuisine lean / mood** ("Italian-ish, Mexican, Asian-inspired, or dealer's choice?").
5. **Equipment** (sheet pan / skillet / slow cooker / air fryer / Instant Pot) and **willingness to buy 1–2 items.**
Skill level can be inferred or folded into the time question. Ask them in one friendly batch, not an interrogation.

**What makes a recipe feel "well-tested"/restaurant quality** (from professional-technique sources): season in stages (salt aromatics early, protein before cooking, finish at the end); build a flavor base (sauté aromatics, develop fond, deglaze); balance the five tastes with acid and fat; use correct heat and don't crowd the pan; specify doneness by sensory cue *and* temperature (165°F poultry, 145°F fish); and finish with a fresh/bright element (herbs, citrus, flaky salt). Restaurant quality comes from *technique specificity*, not exotic ingredients.

**Ingredient substitutions.** Offer a substitution when a likely-missing item appears (e.g., "no buttermilk? add 1 tbsp lemon juice to 1 cup milk"; tamari/coconut aminos for soy sauce; dried herb = ⅓ the fresh amount). Keep substitutions verified and safe — never invent a swap that changes food safety or ratios drastically.

**Optimal recipe structure:** (1) short appetizing intro/description and why it works; (2) yield/servings; (3) prep + cook time; (4) ingredient list with precise amounts (weight or volume), grouped by component; (5) numbered method steps with technique and sensory cues; (6) tips/variations and storage; (7) a drink/wine pairing. This mirrors the structure users praise in NYT Cooking, Crouton, and Mela.

**Common failure modes to defend against** (documented across Recipy, ChefTalk, Medium, and others):
- **Wrong quantities/ratios** — LLMs average across recipes and are weak at math; a model may output "1 tablespoon chili powder where 1 teaspoon is correct" or double a canned-milk quantity. Ground ratios in fixed culinary formulas (below).
- **"Frankenstein" recipes** — title from one dish, ingredients from another, untested as a whole. Keep the dish internally coherent.
- **Unrealistic timing** — verify that stated times match the technique (e.g., caramelizing onions is ~30–45 min, not 5).
- **Missing technique/food-safety cues** — always include doneness temps and never generate unsafe methods.
- **Baking is highest-risk** — chemistry-sensitive; be conservative and stick to tested ratios.

### 4. Flavor Pairing & Cuisine Logic

**Signature flavor bases (the generator's "cuisine grammar"):**
- **Italian-American:** garlic, basil, oregano, tomato, olive oil, Parmesan, crushed red pepper.
- **Mexican/Tex-Mex:** cumin, chili powder/dried chiles, lime, cilantro, oregano, garlic, onion (cumin especially Tex-Mex; note authentic Mexican uses cumin more sparingly).
- **Asian-American / Chinese-American:** soy sauce, ginger, garlic, sesame oil, scallion, rice vinegar; five-spice for depth.
- **Japanese:** soy + mirin + sake (1:1:1); dashi.
- **Thai:** lemongrass, galangal, lime, fish sauce, chile, coconut, basil (balance sweet-sour-salty-spicy).
- **Indian:** spices bloomed in fat — cumin, coriander, turmeric, ginger, garam masala.
- **American comfort:** butter, black pepper, thyme, Worcestershire, garlic/onion powder.
- **Mediterranean/Greek:** olive oil, lemon, oregano, garlic, feta, herbs.
- **Cajun/Creole:** holy trinity (onion, celery, bell pepper), garlic, paprika, cayenne, thyme.

**Beloved protein + vegetable + starch combos:** chicken + broccoli + rice; chicken + green beans + sweet potato (sheet pan); beef + peppers/onion + tortilla or rice; salmon + asparagus/green beans + potato; sausage + peppers + pasta; pork + cabbage/apple + potato; tofu + broccoli + rice; ground beef + tomato + pasta. The near-universal weeknight template is **protein + non-starchy vegetable + starch** — roughly half the plate vegetables, a quarter protein (~3–4 oz cooked), a quarter starch (~1 cup), plus a fat/sauce.

**Golden ratios to hard-code:**
- **Stir-fry sauce:** a 1:1:2:4-style balance of aromatic/acid/sweet/savory-liquid, thickened with a slurry never exceeding ~6:1 liquid-to-starch; a splash of acid and a touch of sugar to round it out; finish with a little cold oil for gloss.
- **Pasta-to-sauce:** ~1.5 cups tomato sauce per pound of dry pasta (Barilla's looser guidance runs up to ~24 oz per lb); ~1 cup per pound for cream/oil-based; finish pasta in the sauce with a splash of starchy pasta water. Meat sauce ~1:1 to 2:1 sauce-to-meat by volume.
- **Pasta cooking:** ~1 lb pasta to ~6 qt salted water.
- **Rice pilaf:** 2 parts liquid to 1 part rice.
- **Braise/stew:** ~10 parts protein : 1 part aromatics/mirepoix : 1–2 parts liquid; braise liquid covers meat by ⅓–⅔, stew liquid covers fully; cook to fork-tender, not by strict time.
- **Puréed vegetable soup:** ~3:1 to 4:1 liquid-to-solid (2:1 for a thick side); ~1 lb vegetables ≈ 2¼ cups.
- **Vinaigrette:** ~3:1 oil to acid.

### 5. Dietary Restriction Prevalence & App UX

**U.S. prevalence (for prioritizing which filters matter):**
- **Vegetarian ~4%, vegan ~1%** — per the Gallup Consumption Habits poll (telephone interviews July 3–27, 2023, n=1,015 adults): "Gallup finds 4% of Americans saying they are vegetarian, in terms of their eating preferences, and 1% identifying as vegan." Vegetarianism runs higher among under-50s (7–8%) and liberals (9%). Plant-based *product* sales far exceed the diet population, so "meatless-friendly" framing matters more than the raw count.
- **Gluten-free ~11% self-reported** — Statista Consumer Insights (Oct 2023–Sep 2024, 4,182–10,051 respondents per quarter) puts U.S. gluten-free dieters at roughly 11%, highest among millennials/Gen Z (11%) vs. boomers (6%). Celiac disease affects ~1% of the population (Gallup: "one in 100 people worldwide"); non-celiac gluten sensitivity is estimated at ~6%. (A widely repeated "12%, up from 7% in 2020" figure traces to the lower-authority aggregator Sci-Tech Today.)
- **Low-carb/keto:** ~17% low-carb in early 2024 (Statista); keto specifically is much smaller (a few percent trying it in a given year).
- **Food allergies are the safety-critical category:** per Gupta et al., *JAMA Network Open* 2019 (survey of 40,443 U.S. adults), "at least 10.8% (>26 million) of US adults are food allergic, whereas nearly 19% of adults believe that they have a food allergy." FARE frames the same study as "11 percent — or more than 26 million individuals nationwide," with 45% allergic to more than one food. The most common adult allergens are shellfish (2.9%), milk (1.9%), and peanut (1.8%). CDC/NCHS (physician-*diagnosed*, 2024 NHIS) reports lower figures — 6.7% of adults and 5.3% of children — the gap reflecting self-reported vs. diagnosed. The "big 9" allergens (milk, egg, peanut, tree nuts, wheat, soy, fish, crustacean shellfish, sesame) dominate; sesame became the 9th labeled U.S. allergen (FASTER Act, effective Jan 1, 2023).
- **Lactose intolerance/dairy avoidance** is common: NIDDK estimates ~36% of U.S. people have lactose malabsorption, and NICHD/NIH cites 30–50 million lactose-intolerant American adults, with sharp variation by ancestry (~95% of Asian Americans, 60–80% of African Americans, vs. lower rates among those of Northern European descent).
- **Halal and kosher** are meaningful minorities: per the Institute for Social Policy and Understanding (ISPU, American Muslim Poll 2022), 83% of U.S. Muslims either require (37%) or prefer (46%) a halal diet, among ~3.45M U.S. Muslims (Pew, 2017). For kosher, Pew Research Center's "Jewish Americans in 2020" found 17% of U.S. Jews keep kosher at home (95% of Orthodox, 24% of Conservative, 5% of Reform), among ~7.5M U.S. Jews.

**How leading apps handle diet filters:**
- **Yummly** has the most granular system: separate Diet, Allergy, and Nutrition preference profiles plus a disliked-ingredients list. Diet options include keto, low-FODMAP, paleo, vegetarian (lacto/ovo variants), vegan, pescatarian, and diabetic-friendly; allergen exclusions cover peanut, tree nut, shellfish, soy, dairy, gluten/wheat, and egg (source: Yummly Help Center + reviews).
- **NYT Cooking** offers search by diet, cuisine, and meal type, with tag-based diet categories (vegetarian, vegan, gluten-free, dairy-free, low-carb, etc.) — less allergen-granular. (Its exact current filter menu is not published on an official help page; treat as medium-confidence.)
- **AllRecipes** organizes special diets as browse categories (diabetic, gluten-free, dairy-free, vegetarian, vegan, low-carb, keto, paleo, Mediterranean, Whole30, and various low-X categories) rather than a single multi-select allergen panel.
- **Crouton** and **Mela** are recipe *managers* that rely on user tags/smart folders (e.g., "Gluten-Free," "Vegan," "Instant Pot") for dietary filtering rather than allergen databases.

**Best UX pattern: set-once-in-profile with per-session override, plus hard allergen locks.** Store dietary preferences in the profile so the AI honors them silently on every generation — this matches how the best apps advertise the feature ("set your dietary preferences once and every recipe respects them automatically"). Allow a per-session override for context ("cooking for a vegetarian guest tonight"). Treat allergies as non-negotiable hard exclusions that are never overridden without explicit confirmation, given the safety stakes and the documented danger of AI hallucinating unsafe substitutions.

## Recommendations

**Stage 1 — Core generation logic (build first):**
1. Encode the five primary cuisine modes (Italian-American, Mexican/Tex-Mex, American comfort, Asian-American, Mediterranean), each with its flavor base and 2–3 default formats (skillet, sheet pan, one-pot).
2. Hard-code the golden ratios above so quantities are formula-derived, not guessed — this is the single biggest defense against the #1 AI failure (wrong ratios).
3. Implement the three-tier pantry model: freely use Tier 1/2, cap Tier 3 at 1–2 items and only with user consent.

**Stage 2 — Conversation & personalization:**
4. Ask 3–5 clarifying questions in one friendly batch (time, servings, cuisine lean, equipment, grocery-run willingness); pull dietary prefs/allergies from profile silently.
5. Set-once + per-session override for diet; hard allergen locks that require explicit confirmation to breach.

**Stage 3 — Output quality:**
6. Enforce the full recipe structure (intro, yield, times, grouped measured ingredients, technique-rich numbered steps with doneness cues, tips/variations, drink pairing).
7. Inject technique cues (stage seasoning, build a base, balance acid/fat, rest/finish) into every method — this is what makes output feel "well-tested."
8. Run a sanity pass before returning: are timings realistic for the technique? do ratios match the formulas? is the dish internally coherent (not Frankenstein)? are doneness temps present?

**Benchmarks that would change the approach:**
- If user feedback shows recipes feel generic → increase technique-cue density and cuisine specificity.
- If users frequently lack an assumed ingredient → demote that item from Tier 1/2 to a confirm prompt.
- If completion/cook-through rates are low → shorten to fewer steps and tighten to Tier-1-only pantry.
- If allergen incidents or complaints appear → tighten hard-lock logic and add an explicit allergen-confirmation step.

## Caveats
- Several dish- and cuisine-popularity figures come from commercial/SEO-oriented sources (Statista summaries behind paywalls, blog aggregations, and search-volume studies commissioned by furniture/BBQ companies); treat exact percentages as directional. Gallup (diet identity), Pew (religious diets), CDC/NCHS and JAMA/FARE (allergies) are the most rigorous.
- Diet self-identification (e.g., "gluten-free ~11%") overstates medical need; actual celiac prevalence is ~1%. Design for both the strict-necessity minority and the larger preference-driven group.
- Search-volume rankings for cuisines vary widely between sources (Chinese reported at both ~8.6M and ~3.35M monthly searches by the same firm via different outlets); use them only to establish relative popularity, not precise magnitudes.
- NYT Cooking's and AllRecipes' exact current filter menus could not be fully verified against official published help pages and reflect known site taxonomy; Yummly's is well-documented.
- "Restaurant quality" and "well-tested" are partly subjective; the technique heuristics here are proxies, not guarantees. The generator produces plausible, coherent recipes — it does not physically test them, so a "not yet kitchen-tested" honesty stance is appropriate.
- Pantry-staple lists vary by household income, region, and household size; the three-tier model is a reasonable central estimate, not a universal truth.