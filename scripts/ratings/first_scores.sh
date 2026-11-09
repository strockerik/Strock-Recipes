#!/bin/bash
# First expert scores for the bar, looked up 2026-11-08. Only primary pages count:
# the critic's own review page or the brand's own awards list, never a retailer.
# Wine Enthusiast's pre-2010 reviews gave a band; it's recorded at its middle
# (85-89 -> 87, 90-95 -> 92.5, 96-100 -> 98).
#
#   bash first_scores.sh            preview every line (writes nothing)
#   bash first_scores.sh --apply    write them (re-running updates in place)
#
# Drinkhacker is entered as its x/10 (letter only: A 9.5, A- 9.0, B+ 8.5, B 8.0).
# "independent" = a blog's own 100-point score, half weight, --reviewer names it.
#
# No usable primary score found: Cimarrón Blanco, Pimm's No. 1, and Laws San Luis
# Valley Rye (every critic score is for the bottled-in-bond release; add those once
# it's confirmed which bottle this is). Skipped as retailer-only: medals for Campari,
# Aperol, Kahlúa, Boomsma, Hendrick's, St-Germain, Nonino and Cointreau.
cd "$(dirname "$0")" || exit 1
s() { python3 ratings.py score "$@" $APPLY; }
APPLY="$1"
WE=https://www.wineenthusiast.com/buying-guide
EC=https://elijahcraig.com/small-batch
DH=https://www.drinkhacker.com

s "Green Chartreuse"   --source wine_enthusiast --raw 93   --year 2016 --url $WE/chartreuse-green/
s "Green Chartreuse"   --source wine_enthusiast --raw 98   --year 2007 --url $WE/chartreuse-green-liqueur-fabriquee-par-les-peres-chartreux/
s "Yellow Chartreuse"  --source wine_enthusiast --raw 92.5 --year 2007 --url $WE/chartreuse-yellow-liqueur-fabriquee-par-les-peres-chartreux/
s "Campari"            --source wine_enthusiast --raw 96   --year 2022 --url $WE/campari/
s "Campari"            --source wine_enthusiast --raw 87   --year 2007 --url $WE/campari-bitter/
s "Hendrick's Gin"     --source wine_enthusiast --raw 92   --year 2012 --url $WE/hendricks-gin/
s "Kahlua"             --source wine_enthusiast --raw 89   --year 2017 --url $WE/kahlua/
s "Kahlua"             --source wine_enthusiast --raw 87   --year 2006 --url $WE/kahlua-liqueur/
s "Boomsma Cloosterbitter"     --source wine_enthusiast --raw 89 --year 2016 --url $WE/boomsma-clooster-bitter/
s "Pierre Ferrand Dry Curaçao" --source wine_enthusiast --raw 95 --year 2019 --url $WE/pierre-ferrand-dry-curacao/
s "Amaro Nonino"       --source wine_enthusiast --raw 96   --year 2014 --url $WE/amaro-nonino/
s "Aperol"             --source wine_enthusiast --raw 95   --year 2022 --url $WE/aperol/
s "Aperol"             --source wine_enthusiast --raw 90   --year 2014 --url $WE/aperol-aperitivo-liqueur/
s "Amaro Montenegro"   --source wine_enthusiast --raw 97   --year 2014 --url $WE/amaro-montenegro/
s "Amaro Montenegro"   --source wine_enthusiast --raw 92.5 --year 2006 --url $WE/montenegro-amaro/
s "Elijah Craig Small Batch" --source sfwsc --medal "Double Gold" --year 2022 --url $EC
s "Elijah Craig Small Batch" --source sfwsc --medal "Double Gold" --year 2021 --url $EC
s "Elijah Craig Small Batch" --source sfwsc --medal "Gold"        --year 2020 --url $EC
s "Elijah Craig Small Batch" --source sfwsc --medal "Gold"        --year 2019 --url $EC
s "Elijah Craig Small Batch" --source usc   --raw 93              --year 2020 --url $EC
s "Elijah Craig Small Batch" --source usc   --raw 94              --year 2019 --url $EC
s "291 Small Batch Colorado Rye" --source wine_enthusiast --raw 89 --year 2022 --url $WE/291-colorado-rye-whiskey/
s "Smith & Cross"      --source wine_enthusiast --raw 95   --year 2014 --url $WE/smith-cross-traditional-jamaica-rum/
s "Plantation 3 Stars" --source wine_enthusiast --raw 94   --year 2016 --url $WE/plantation-3-stars/
s "Plantation 3 Stars" --source sfwsc --medal "Double Gold" --year 2025 --url https://planterayrum.com/product/three-stars/
s "Rhum J.M Blanc"     --source wine_enthusiast --raw 88   --year 2018 --url $WE/rhum-j-m-100-blanc/
s "St. Germain"        --source wine_enthusiast --raw 98   --year 2008 --url $WE/st-germain-liqueur-artisanale/
s "Cointreau"          --source wine_enthusiast --raw 92   --year 2019 --url $WE/cointreau/
s "Cointreau"          --source wine_enthusiast --raw 98   --year 2006 --url $WE/cointreau-liqueur/
s "Luxardo Maraschino Originale" --source wine_enthusiast --raw 92.5 --year 2007 --url $WE/luxardo-il-maraschino-originale-cherry-liqueur/
s "Gran Centenario Plata" --source wine_enthusiast --raw 87 --year 2006 --url $WE/gran-centenario-plata-100-agave-tequila-nom-1122/

# --- Second pass (2026-11-08): more critics, competitions' own results pages ---
s "Green Chartreuse"   --source drinkhacker --raw 9.5 --year 2019 --url $DH/2019/05/20/review-yellow-chartreuse-and-green-chartreuse/
s "Yellow Chartreuse"  --source drinkhacker --raw 9.5 --year 2019 --url $DH/2019/05/20/review-yellow-chartreuse-and-green-chartreuse/
s "Hendrick's Gin"     --source drinkhacker --raw 8.0 --year 2011 --url $DH/2011/10/10/review-hendricks-gin/
s "St. Germain"        --source drinkhacker --raw 9.0 --year 2026 --url $DH/2026/01/30/the-best-elderflower-liqueur-7-bottles-tasted-1-winner/
s "Amaro Nonino"       --source drinkhacker --raw 8.5 --year 2024 --url $DH/2024/10/13/review-laperitivo-nonino-and-amaro-nonino/
s "Amaro Montenegro"   --source drinkhacker --raw 9.0 --year 2015 --url $DH/2015/04/13/review-amaro-montenegro/
s "Amaro Montenegro"   --source sfwsc --medal "Double Gold" --year 2018 --url https://www.prnewswire.com/news-releases/amaro-montenegro-takes-home-top-honors-at-2018-san-francisco-world-spirits-competition-300638980.html
s "Amaro Montenegro"   --source iwsc  --medal "Gold"        --year 2018 --url https://www.prnewswire.com/news-releases/amaro-montenegro-awarded-second-consecutive-gold-medal-at-2018-international-wine--spirits-competition-689124851.html
s "Amaro Montenegro"   --source iwsc  --medal "Gold"        --year 2017 --url https://www.prnewswire.com/news-releases/amaro-montenegro-takes-home-top-honors-at-2018-san-francisco-world-spirits-competition-300638980.html
s "Pierre Ferrand Dry Curaçao" --source drinkhacker --raw 9.5 --year 2012 --url $DH/2012/04/27/review-pierre-ferrand-dry-curacao-ancienne-method/
s "Pierre Ferrand Dry Curaçao" --source bartender_spirits_awards --raw 89 --year 2024 --url https://bartenderspiritsawards.com/en/winner-brands/spirits/2024/maison-ferrand-2326/ferrand-dry-curaao-6070.htm
s "Smith & Cross"      --source drinkhacker --raw 9.0 --year 2021 --url $DH/2021/09/17/review-smith-cross-traditional-jamaican-rum/
s "Plantation 3 Stars" --source drinkhacker --raw 9.5 --year 2012 --url $DH/2012/09/26/review-plantation-3-stars-white-rum/
s "Plantation 3 Stars" --source drinkhacker --raw 9.0 --year 2015 --url $DH/2015/11/18/review-plantation-rum-lineup-2015-3-stars-white-original-dark-barbados-5-years-old-extra-old-20th-anniversary-old-reserve-2001-and-pineapple/
s "Rhum J.M Blanc"     --source drinkhacker --raw 9.0 --year 2012 --url $DH/2012/05/13/review-rums-of-rhum-j-m/
s "Rhum J.M Blanc"     --source drinkhacker --raw 8.5 --year 2016 --url $DH/2016/05/16/review-rums-of-rhum-j-m-2016/
s "Rhum J.M Blanc"     --source drinkhacker --raw 9.0 --year 2020 --url $DH/2020/07/02/review-rhum-j-m-blanc-xo-french-oak-and-sirop-2020/
s "Gran Centenario Plata" --source bartender_spirits_awards --raw 86 --year 2021 --url https://bartenderspiritsawards.com/en/winner-brands/spirits/2021/proximo-spirits-949/gran-centenario-plata-2913.htm
s "Del Maguey Vida Puebla" --source spirits_masters --medal "Gold" --year 2026 --url https://www.thespiritsbusiness.com/2026/04/results-time-the-tequila-mezcal-masters-2026/
s "St. George Spiced Pear Liqueur" --source spirit_journal --raw 4 --url https://stgeorgespirits.com/spirits/spiced-pear-liqueur
s "Elijah Craig Small Batch" --source whisky_advocate  --raw 87  --year 2018 --url https://whiskyadvocate.com/Elijah-Craig-Small-Batch-47
s "Elijah Craig Small Batch" --source breaking_bourbon --raw 2.5 --year 2019 --url https://breakingbourbon.com/review/elijah-craig-small-batch
s "291 Small Batch Colorado Rye" --source iwsc --medal "Gold" --year 2018 --url https://distillery291.com/gold-medal-win-for-distillery-291-from-iwsc-continued-2018-international-awards-momentum/
s "291 Small Batch Colorado Rye" --source whiskycast --raw 85 --year 2016 --url https://whiskycast.com/ratings/291-colorado-whiskey/
s "291 Small Batch Colorado Rye" --source whiskey_wash --scale critic100 --raw 76 --year 2016 --url https://thewhiskeywash.com/whiskey-styles/american-whiskey/whiskey-review-291-colorado-whiskey/
s "Wyoming Whiskey Small Batch Bourbon" --source whiskycast --raw 95 --year 2012 --url https://whiskycast.com/ratings/wyoming-whiskey/
s "Wyoming Whiskey Small Batch Bourbon" --source whiskey_wash --scale critic100 --raw 86 --year 2015 --url https://thewhiskeywash.com/whiskey-styles/bourbon/whiskey-review-wyoming-whiskey/
s "Wyoming Whiskey Small Batch Bourbon" --source breaking_bourbon --raw 3 --year 2018 --url https://breakingbourbon.com/review/wyoming-whiskey-small-batch-bourbon
s "Wyoming Whiskey Small Batch Bourbon" --source independent --reviewer "Modern Thirst" --raw 89 --year 2018 --url https://modernthirst.com/2018/05/09/wyoming-whiskey-small-batch-bourbon-review/
s "Wyoming Whiskey Small Batch Bourbon" --source independent --reviewer "The Casks" --raw 85 --year 2019 --url https://thecasks.com/2019/01/16/wyoming-whiskeys-small-batch-bourbon-whiskey-review/
