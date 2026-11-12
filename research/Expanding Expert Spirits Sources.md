# Expanding House Index's Expert Spirits Sources: What to Add, How to Map It, and What to Avoid

The best additions for the non-whiskey gaps are **Spirits Selection by Concours Mondial (results database), the TAG Global Spirits Awards (which publishes a numeric score per product), Whiskyfun (Serge Valentin's 100-point scores, now regularly covering rum and brandy), The Lone Caner (rum), and The GIN is IN (gin)**. Colorado craft whiskey is best covered by the **Denver International Spirits Competition, ADI and ACSA**. Agave and mainstream liqueurs will stay thin no matter what you add, because few independent critics score them consistently. No affordable licensed spirits-score API exists. Wine-Searcher's API is the only official feed that ships a critic score, and Proof66 is a derivative aggregator that would double-count sources you already use.

## TL;DR
- **Add to Tier 1 (critics):** whiskyfun.com (100-pt, also rum, cognac and armagnac), thelonecaner.com (rum, 100-pt), therumhowlerblog.com (rum and vodka, 100-pt; check it is still active), theginisin.com (gin, 0.5–5 stars). Add **Tier 2 (competitions with points):** results.spiritsselection.com, tagspiritsawards.com, whiskycompetition.com, world-spirits.com. Add **Tier 3 (medal-only, Colorado/craft):** denverspiritscomp.com, distilling.com (ADI), americancraftspirits.org (ACSA), worldginawards.com.
- **Downweight or keep manual:** London Spirits Competition and USA Spirits Ratings (scores include 25% value and 25% packaging); Difford's Guide (terms restrict automated use, and it takes sponsorship only from products it rated 4 stars or more); VinePair listicle scores; Tequila Aficionado. Exclude Mezcal Reviews, which is community-driven.
- **Data feeds:** Wine-Searcher's official API returns an "Aggregate Critic Score" and has a five-day free trial. Proof66 leases data and API access to retailers, but it only re-aggregates SFWSC, BTI and Wine Enthusiast. Do not use third-party Apify scrapers of Wine-Searcher. Treat producer "awards" pages as leads only, never as the scored source.

## Key Findings

### 1. Prioritized additions by category gap

| Priority | Source (domain) | Type | Category strength | Scale | Suggested 0–10 mapping | Weight | Access / ToS notes | Est. coverage for your bar |
|---|---|---|---|---|---|---|---|---|
| **Rum / rhum agricole** | | | | | | | | |
| 1 | The Lone Caner (thelonecaner.com) | Critic (single palate) | Rum specialist, 1,100+ numbered reviews; Rumaniacs historic series | 100-pt plus stars | Harsh grader (90+ is rare; a Mhoba 2025 at 86 is called among "the most startling, original rums"). Add +2 before applying the critic curve: 86→7.0, 88→7.5, 90→8.5\[1\] | 1.0 | Active through 2025 (reviews #1126–#1134). robots.txt not verified\[2\] | High for Smith & Cross, Planteray and J.M-type bottles |
| 2 | Whiskyfun (whiskyfun.com) | Critic (Serge Valentin and Angus MacRaild) | Whisky first, but a steady stream of rum (TECA, Velier), cognac and armagnac | 100-pt (80–89 high quality, 90+ exceptional)\[3\] | Same +2 offset as Lone Caner: 85→6.5, 88→7.5, 90→8.5, 92→9.0 | 1.0 whisky; 0.8 non-whisky | Very active (Nov 2026 posts). Serge himself warns he is "not an expert in rum, brandy, tequila, vodka, gin". Page meta says index/follow; robots.txt not verified\[4\] | Very high for Scotch; moderate for rum and cognac; near zero for liqueurs |
| 3 | The Rum Howler Blog (therumhowlerblog.com) | Critic (Chip Dykstra) | Rum, vodka, whisky, flavored rum | 100-pt (e.g., Plantation 3 Stars 89.5, Bacardi Superior 74)\[5\] | Standard critic curve (92→8.0, 95→9.0; 89→7.0, 86→6.0) | 1.0 (0.75 if the review is more than 8 years old) | Large index pages. 2025–26 activity not confirmed | High for mainstream rum (Plantation, Appleton) |
| 4 | Spirits Selection by CMB (results.spiritsselection.com) | Competition | Strong for rhum agricole (Martinique/Guadeloupe Grand Golds), amaro, liqueur, cognac, armagnac, mezcal | Medals (Grand Gold / Gold / Silver); points appear on some retailer pages (e.g., "92 points, Gold" 2021) | Grand Gold 8.0, Gold 7.0, Silver 6.0; if points are shown, use the competition curve (95→8.0) | 0.6 (better than typical medal-only: Spirits Selection's Rules of Entry say total medals "cannot exceed 30% of the total of entries") | Searchable results database by year. You already use "Concours Mondial de Bruxelles"; this subdomain is the better access path | Medium–high for J.M, amari and cognac |
| **Gin** | | | | | | | | |
| 5 | The GIN is IN (theginisin.com) | Critic (Aaron Knoll) | Gin and aquavit, "Over 1000 Reviews", "Best of 2026" list\[6\] | 0.5–5 stars in half steps | 5→9.0, 4.5→8.5, 4→7.5, 3.5→7.0, 3→6.0, 2.5→5.0, ≤2→4.0 or lower | 1.0 | Use only "Our rating". The page also shows reader votes (e.g., "3.8, 6 votes"), which must be ignored\[7\] | High for Hendrick's, Plymouth, Gordon's |
| 6 | World Gin Awards (worldginawards.com) | Competition (World Drinks Awards) | Gin | Medals plus country winners | Bronze 5.5 / Silver 6.5 / Gold 7.5 | 0.5 | Two judging rounds; medal-only\[8\] | Medium |
| **Agave** | | | | | | | | |
| 7 | TAG Global Spirits Awards (tagspiritsawards.com) | Competition (Tony Abou-Ganim, Julio Bermejo co-founders) | Agave, rum, gin, amaro, whiskey | **Publishes a numeric "TAG Score" per product** (e.g., Bulldog Gin 89, Dos Maderas 5+3 95) | Competition curve: 95→8.0, 92→7.0, 89→6.0 | 0.6 (young competition; Platinum is common: 46 platinum and 62 double gold among ~250 medals in 2025)\[9\] | Results published as HTML tables (crawl-friendly)\[10\] | Medium for tequila and rum |
| 8 | Tequila Aficionado (tequilaaficionado.com) | Critic panel (Master Catador Mike Morales) | Tequila and mezcal; "Brands of Promise" top ten from 230+ entries\[11\] | Mostly video and prose; no consistent numeric scale verified | Manual only; Brands of Promise top ten as a medal-equivalent of 8.0 | 0.5 manual | Active (Winter 2026 issue) | Low for Gran Centenario and Cimarrón |
| 9 | Mezcal Report (mezcal.report) | Critic (independent) | Mezcal only | 5-point "agave" rubric\[12\] | 4.5→8.5, 4→7.5, 3.5→7.0, 3→6.0 | 0.5 (new, single palate, unverified credentials) | Unverified | Low |
| 10 | VinePair buying guides (vinepair.com) | Editorial panel | Tequila, gin, rum "Best of" lists | 100-pt | Critic curve | 0.5 (listicle selection bias: only good bottles appear) | — | Medium for mainstream brands |
| **Liqueurs / amari / aperitivi** | | | | | | | | |
| 11 | Difford's Guide (diffordsguide.com) | Critic (Simon Difford) | Best coverage of mainstream liqueurs and aperitivi (St-Germain, Aperol, Italicus, Galliano pages) | Editorial 5 stars in half steps (historically up to "5+")\[13\] | 5→9.0, 4.5→8.5, 4→7.5, 3.5→7.0, 3→6.0, 2.5→5.0 | **Manual only, 0.5** | Terms forbid reproducing site content; an anti-scraping clause names "robot, spider, scraper." It accepts sponsorship only for products "rated at least 4 stars". Product pages also show "Discerning Drinkers" community ratings in schema.org data, which is a trap for automated extraction\[14\]\[15\]\[16\] | High for Chartreuse, St-Germain, Cointreau, Luxardo, Pimm's |
| (see #4, #7) | Spirits Selection and TAG | | Amaro and liqueur categories | | | | | |
| **Brandy / cognac** | | | | | | | | |
| 12 | Whiskyfun (above) plus ADI (distilling.com) | Critic plus competition | Cognac and armagnac; ADI named Ferrand 10 Générations Best International Brandy in 2025\[17\] | — | — | — | — | Indirect for Pierre Ferrand |
| **Whiskey / Colorado craft** | | | | | | | | |
| 13 | International Whisky Competition (whiskycompetition.com) | Competition | Whisky only; publishes scores to two decimals (e.g., Kavalan Solist Fino 97.04) and only three medals per category\[18\] | 100-pt | Competition curve | 0.8 | Results page per year | Medium |
| 14 | Denver International Spirits Competition (denverspiritscomp.com) | Competition (Broomfield, CO) | Colorado craft whiskey: Stranahan's, Branch & Barrel (San Luis Valley rye), Locke + Co, historic Distillery 291 medals\[19\]\[20\] | 100-pt; points published only for top awards (e.g., 1792 Full Proof Platinum 98, Garrison Brothers 97); entrants get exact scores "upon request"\[21\]\[22\]\[23\] | Medal: Bronze 5.5 / Silver 6.5 / Gold 7.0 / Double Gold 8.0; published points use the competition curve | 0.5 (0.7 with points) | $500 entry fee; per The ABV Network citing a DISC post, 326 of 450 entries (72%) medaled in 2021, with only 11 (2%) Double Gold | **Best local source for 291 and Laws** |
| 15 | ADI Judging of Craft Spirits (distilling.com) | Competition | Craft US plus international; full sortable medal table (Bronze to Double-Gold)\[24\] | Medals | SFWSC-style ladder: 5.5 / 6.5 / 7.5 / 8.5 | 0.5 | Forbes (Joe Micallef) reported only 11% of entrants won gold in 2020, though ADI's own recap frames 11% as a share of medals; ADI judges evaluate "no more than 50 spirit samples a day" | Medium for Colorado craft |
| 16 | ACSA Craft Spirits Competition (americancraftspirits.org) | Competition | US craft (members) | 100-pt internally; Bronze 70–79, Silver 80–89, Gold 90–100; publishes medals only (PDF)\[25\] | Gold 7.0 / Silver 6.0 / Bronze 5.0 | 0.5 | 2025: 35 gold, 162 silver, 114 bronze\[26\] | Low–medium |
| 17 | World Spirits Award (world-spirits.com) | Competition (Austria, WOB points) | Mostly Central European craft; fruit brandies, whisky | WOB 100-pt: Double Gold 95.3–100, Gold 90–95, Silver 80–89, Bronze 71–79\[27\]\[28\] | Competition curve on points | 0.6 | Tiny field (214 spirits from 50 producers in 2025); in 2026 Gold and above dominated (10 Double Gold, 63 Gold, 51 Silver, 2 Bronze)\[28\]\[29\] | Very low for your bottles; low priority |

### 2. Competitions to downweight

- **London Spirits Competition and USA Spirits Ratings** (both run by Beverage Trade Network). They publish a points figure per product, which is tempting, but the score blends **Quality 50%, Value 25%, Packaging 25%**, and packaging is judged after the bottle is unveiled.\[30\]\[31\] That score is not a blind quality score. The official pages also give **inconsistent thresholds**: one LSC page says Gold 95–100 / Silver 90–94 / Bronze 85–89, another says Double Gold 96–100 / Gold 90–95 / Silver 85–89 / Bronze 80–84, and the 2018 launch used Gold 90+ / Silver 76–89.\[32\]\[33\]\[34\] The current official USA Spirits Ratings ladder is Double Gold 96+, Gold 90–95, Silver 85–89, Bronze 80–84.\[35\]\[36\] Recommendation: store as medal-only at **0.4 weight**, never as points.
- **SFWSC medal inflation** (already in use). The ABV Network found 86% of SFWSC 2021 entries medaled, and Homebar.io estimated about 80% in 2022 (4,052 medalists out of roughly 5,000 entries). That supports your existing 0.5 medal weight. For contrast, IWSC's 2025 announcement says "Just 3% achieved Gold Outstanding, while 12% were awarded Gold."

### 3. Licensed data feeds and APIs

| Option | What you get | Legitimacy | Pricing | Verdict |
|---|---|---|---|---|
| Wine-Searcher API (Wine Check API) | Product match plus "Wine-Searcher Aggregate Critic Score" (mean of 100-pt critic scores), prices\[37\] | Official, licensed | Paid plans with a five-day free trial; prices not public to automated fetch (site bot-blocked)\[37\] | Worth a trial for coverage, but it returns an aggregate, not per-critic facts, so it cannot feed your weighted blend cleanly. Treat it as one 0.5-weight "aggregate" source |
| Apify "Wine-Searcher scrapers" (~$1.50–$25 per 1,000 records) | Per-critic scores scraped\[38\]\[39\] | Unofficial, likely ToS-violating | Pay-per-event | **Do not use** (same reasoning as your Distiller/BTI exclusion) |
| Proof66 data leasing | Scores, notes and "API services" for retailers and distributors (contact for terms)\[40\] | Licensed | Not published | Derivative: it re-aggregates SFWSC, BTI and Wine Enthusiast.\[41\] BTI is excluded by your policy, and the other two you already collect, so it would double-count. Skip |
| Whiskybase API | Metadata | — | — | Metadata only, as you noted; ratings are community |
| Spirits Selection / competition "APIs" | None found | — | — | Use the public results database |

### 4. Producer "awards" pages

Producer and importer pages are useful **leads, not sources**. Typical problems:
- **Derivative claims.** Crystal Head says it is "top 10th percentile" on Proof66 rather than citing a judged score.\[42\]
- **Missing details.** Medals are listed without year, expression or ABV. For example, Okanagan's "11 gold medals" page does not say which bottles won.\[43\]
- **Re-hosted critic scores.** Colours of Rum features Whiskyfun scores, and retailers re-post "92 points, Gold" from Spirits Selection.\[3\]\[44\]

To verify: (1) find the same product, year and medal on the competition's own results page or the critic's own post; (2) match the exact expression and proof; (3) store the competition or critic URL, never the producer URL; (4) if it cannot be verified, store it as an "unverified claim" with zero weight.

## Details

### Suggested allowed_domains per tier
- **Tier 1 critics (add):** `whiskyfun.com`, `thelonecaner.com`, `therumhowlerblog.com`, `theginisin.com`
- **Tier 1b editorial (low weight):** `vinepair.com`, `tequilaaficionado.com`, `mezcal.report`
- **Tier 2 competitions with points:** `results.spiritsselection.com`, `spiritsselection.com`, `tagspiritsawards.com`, `whiskycompetition.com`, `world-spirits.com`
- **Tier 3 medal-only / regional:** `denverspiritscomp.com`, `distilling.com`, `americancraftspirits.org`, `worldginawards.com`, `londonspiritscompetition.com`, `usaspiritsratings.com`
- **Tier 3 secondary news (to locate results):** `craftspiritsmag.com`, `bevnet.com`, `westword.com`, `imbibemagazine.com`
- **Manual-only:** `diffordsguide.com`

### Mapping conventions (consistent with your existing anchors)
- **Critic curve:** score10 = 8.0 + (pts − 92)/3, rounded to 0.5 (95→9.0, 89→7.0, 86→6.0).
- **Harsh single-palate critics** (Whiskyfun, Lone Caner): add +2 points before applying the critic curve. This is a judgment call based on their stated bands (80–89 "high quality"). Calibrate it against bottles that Wine Enthusiast also scored.
- **Competition curve:** score10 = 8.0 + (pts − 95)/3 (IWSC anchor).
- **Stars (/5):** linear: 5→9.0, 4→7.5, 3→6.0.

### Bottle-level expectations
- **Plantation/Planteray, Smith & Cross:** Rum Howler and Lone Caner are likely hits.
- **Rhum J.M:** Spirits Selection plus Lone Caner/Whiskyfun.
- **Hendrick's:** The GIN is IN.
- **Pierre Ferrand:** ADI and Difford's (manual).\[45\]
- **Chartreuse, St-Germain, Cointreau, Luxardo, Kahlúa, Pimm's, Campari/Aperol:** realistically only Wine Enthusiast (existing) plus Difford's (manual).
- **291 and Laws:** Denver ISC, ADI and ACSA medals.\[20\]
- **Gran Centenario and Cimarrón:** expect little beyond TAG and VinePair.

## Recommendations
1. Ship Tier 1 additions first (Lone Caner, Whiskyfun, GIN is IN, Rum Howler). They are numeric, crawlable HTML from single, consistent palates.
2. Add Spirits Selection and TAG next for rum, agave and amaro. They are the only competitions here that combine liqueur/agave depth with either capped medals or published scores.
3. Add the Colorado tier (Denver ISC, ADI, ACSA) at medal weight for the craft whiskey bottles.
4. Store a `scale_type` field (critic_100, competition_100, composite_QVP, stars_5, medal) so London/USA Spirits Ratings composite scores can never be blended as quality points.
5. Before deploying, have someone manually check each new domain's robots.txt for ClaudeBot / Claude-User / anthropic-ai rules. This research could not retrieve any robots.txt file. Pages on whiskyfun.com, diffordsguide.com and usaspiritsratings.com loaded with no bot challenge, and their meta tags say "index, follow", but that is not robots.txt consent.\[35\]\[46\]

## Caveats
- **Unverified robots.txt and terms.** Robots.txt and terms were not verified for any new domain except Difford's, whose terms are restrictive.
- **Activity status.** Rum Howler activity in 2025–26 is unconfirmed.
- **Undocumented thresholds.** Spirits Selection point thresholds and Denver ISC medal thresholds were not found in official documentation, so the medal-to-score values above are proposed, not published.
- **Weights are judgment calls.** They are calibrated to your existing scheme, not derived from data.
- **Medal-rate statistics are older.** The figures come from third-party analyses (SFWSC about 2021 and 2022, DISC 2021) and may not reflect current years.\[47\]\[48\]

## Sources

1. [White Rums](https://thelonecaner.com/category/rum-reviews-by-type/white-rums/)
2. [Ruminsky](https://thelonecaner.com/author/ruminsky/)
3. [Whisky Fun by Serge Valentine](https://coloursofrum.com/whisky-fun)
4. [Whisky Fun by Serge and Angus, blog, reviews and tasting notes since 2002](https://translate.google.com/translate?u=https%3A%2F%2Fwww.whiskyfun.com%2F&hl=es&sl=en&tl=es&client=srp)
5. [Rum Reviews « The Rum Howler Blog](https://translate.google.com/translate?u=https%3A%2F%2Ftherumhowlerblog.com%2Frum-reviews%2F&hl=es&sl=en&tl=es&client=srp&prev=search)
6. [The GIN is IN, Expert Gin Reviews since 2009](https://theginisin.com/)
7. [Plymouth Gin - The GIN is IN](https://theginisin.com/gin-reviews/plymouth/)
8. [World Gin Awards - Competition](https://www.wine-searcher.com/awards-92-world+gin+awards)
9. [2025 TAG Global Spirits Awards Winners Announced - TAG Global Spirits Awards](https://tagspiritsawards.com/2025-tag-global-spirits-awards-winners-announced/)
10. [2024 Results](https://tagspiritsawards.com/2024-results/)
11. [Tequila Aficionado Magazine - Winter 2026 - Tequila Aficionado](https://www.tequilaaficionado.com/tequila-aficionado-magazine-winter-2026/)
12. [Mezcal Report: Independent Mezcal Reviews & Ratings](https://mezcal.report/)
13. [Spirited Reviews November 2014: Rated Spirits](https://www.diffordsguide.com/encyclopedia/574/bws/spirited-reviews-november-2014)
14. [French 1605](https://www.diffordsguide.com/en-au/cocktails/recipe/12028/french-1605)
15. [1 About us longform](https://www.diffordsguide.com/encyclopedia/directory/company-info)
16. [Product and Bar Reviews: Ratings, Stamps, Rules](https://www.diffordsguide.com/g/1097/diffords-guide/our-reviews-ratings-and-rules-of-engagement)
17. [American Distilling Institute Announces Winners of 2025 International Spirits Competition - ProBrewer](https://probrewer.com/beverage-industry-news/probrewer-news/american-distilling-institute-announces-winners-of-2025-international-spirits-competition/)
18. [International Whisky Competition](https://en.wikipedia.org/wiki/International_Whisky_Competition)
19. [Colorado Distillers Make Their Mark in Judgings, Competitions](https://www.westword.com/food-drink/awarded-colorado-whiskey-makers-40878622/)
20. [Distillery 291](https://en.wikipedia.org/wiki/Distillery_291)
21. [Spirits Competition - Denver International Spirits Competition](https://denverspiritscomp.com/spirits-competition/)
22. [2025 Denver International Spirits Competition Winners Announcement](https://www.bevnet.com/pr/2025/04/03/2025-denver-international-spirits-competition-winners-announcement)
23. [Home - Denver International Spirits Competition](https://denverspiritscomp.com/)
24. [ADI 2025 International Spirits Competition Awards - American Distilling Institute](https://distilling.com/adi-isc/awards/adi-2025-international-spirits-competition-awards/)
25. [ACSA Announces 2025 Craft Spirits Competition & Packaging Award Medalists](https://craftspiritsmag.com/2025/03/12/acsa-announces-2025-craft-spirits-competition-packaging-award-medalists/)
26. [2025 American Craft Spirits Awards](https://americancraftspirits.org/programs/judging/2025-american-craft-spirits-awards/)
27. [Spirits ratings](https://en.wikipedia.org/wiki/Spirits_ratings)
28. [World Spirits Award 2025: A difficult year for everyone!](https://world-spirits.com/en/journal-en/wsa-news/1543-world-spirits-award-2025-a-difficult-year-for-everyone)
29. [World Spirits Award 2025: A difficult year for everyone!](https://www.world-spirits.com/en/journal-en/wsa-news/1530-world-spirits-award-2025-a-difficult-year-for-everyone)
30. [London Spirits Competition](https://thewhiskeywash.com/whiskey-guides/whiskey-awards/london-spirits-competition/)
31. [Judging Process - 2026 London Spirits Competition](https://londonspiritscompetition.com/en/judging-process-247.htm)
32. [2026 London Spirits Competition - Where Spirits Are Rated By Quality, Value and Package](https://londonspiritscompetition.com/en/)
33. [The Awards - London Spirits Competition](https://londonspiritscompetition.com/en/awards-258.htm)
34. [London Spirits Competition Announces Award-Winning Spirits Based on Drinkability](https://londonspiritscompetition.com/en/blog/news-3/london-spirits-competition-announces-award-winning-spirits-based-on-drinkability-29.htm)
35. [2026 USA Spirits Ratings Winners Announced](https://usaspiritsratings.com/en/blog/news-2/2026-usa-spirits-ratings-results-announced-414.htm)
36. [Awards - USA Spirits Ratings will score and qualify spirits for Gold, Silver and Bronze awards.](https://usaspiritsratings.com/en/awards-258.htm)
37. [Wine Data API & Pricing](https://www.wine-searcher.com/trade/api)
38. [Wine-Searcher API: wine and spirits data · Apify](https://apify.com/mrbridge/wine-searcher-scraper-from-list)
39. [Wine-Searcher](https://apify.com/abotapi/wine-searcher-scraper/api)
40. [Proof66 FAQ - Frequently Asked Questions - Liquor Reviews - Spirits Reviews - Proof66.com](https://www.proof66.com/faq.php)
41. [Proof66 Company Profile](https://www.datanyze.com/companies/proof66/354954810)
42. [The "Proof" is in the Awards - Crystal Head Vodka](https://www.crystalheadvodka.com/the-proof-is-in-the-awards/)
43. [Okanagan Spirits Wins Gold for Canada!](https://okanaganspirits.com/blogs/news/okanagan-spirits-wins-gold-for-canada-at-world-spirits-awards)
44. [Noces Royales Cognac & Poire Williams Liqueur — Heavenly Spirits](https://www.heavenlyspirits.com/noces-royales)
45. [Announcing the Winners of the 2025 American Distilling Institute's International Spirits Competition](https://imbibemagazine.com/event/2025-american-distilling-institute-international-spirits-competition/)
46. [Whiskyfun July 2024 - part 1 - Kilkerran, imperial...](https://www.whiskyfun.com/archivejuly24-1-Kilkerran-Imperial.html)
47. [Heavy Medal: Spirits Competitions and the Spirits Consumer — The ABV Network](https://www.abvnetwork.com/whiskey-corner/2021/5/26/heavy-medal-spirits-competitions-and-the-spirits-consumer)
48. [What's up with the San Francisco World Spirits Competition? - Homebar : Homebar](https://homebar.io/whiskey/whats-up-with-the-san-francisco-world-spirits-competition/)
