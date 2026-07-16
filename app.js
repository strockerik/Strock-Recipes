/* The House Index — app logic (vanilla JS, no build step) */
(function () {
  "use strict";

  // ---------- State ----------
  let section = "recipes"; // "recipes" | "cocktails"
  let viewMode = "recipes"; // "recipes" | "mealplan"
  let searchTerm = "";
  let activeTags = new Set();
  let favoritesOnly = false;
  let sharedOnly = false;     // mirrors favoritesOnly — alternate "view mode"
  let profileNames = {};      // user_id -> display_name, for attribution
  const openItems = new Set(); // ids of expanded items
  const openShareIds = new Set(); // ids of items with their share panel expanded
  let sharesByRecipe = {};    // recipe_id -> [shared_with_user_id, ...], for recipes I own
  // grocery: id -> { servings }
  const basket = new Map();
  // per-recipe chosen servings (id -> servings); absent = the recipe's base.
  // Lets you scale a recipe in its detail view whether or not it's in the basket.
  const servingsByRecipe = new Map();
  // Weekly meal planning. The tray is a session-only staging area of recipe ids;
  // assignments (mealPlan) are persisted in Supabase (meal_plan_entries).
  const mealPlanTray = new Set();
  let mealPlan = [];           // entries in the rolling window: {id,recipeId,date,slot,servings,purchasedAt}
  let placeSheetState = null;  // place-sheet dialog: {mode:"slot",recipeId} | {mode:"recipe",date,slot} | null
  let skipPantryStaples = false;
  const checkedGroceryItems = new Set(); // grocery: combined-item keys checked off
  let shoppingModeOn = false; // big-tap, screen-awake grocery view
  let manualGroceryItems = []; // user-typed items not tied to a recipe: {key,name}; checked state lives in checkedGroceryItems
  let unitSystem = "original"; // recipe-detail display: "original" | "us" | "metric"
  let householdServings = null; // "we usually cook for N" default, applied only when first adding a recipe to the grocery list or meal plan
  let aisleOrder = null; // user-customized store-walk order for grocery categories; set in loadUserLocalState
  let seenPickHint = false; // dismissed the "check recipes to build a grocery list" hint
  let seenIntro = false; // dismissed the first-run Cook/Plan/Shop pointer card
  let planView = "dinners"; // meal-plan grid density: "dinners" | "all"
  // Bar & pantry inventory (Supabase-backed, source of truth): {id,section,category,name,status}
  let inventory = [];
  let invSection = "bar"; // which sub-tab the inventory panel is showing: "bar" | "pantry"
  let collapsedInvCats = new Set(); // "<section>:<category>" keys the user has collapsed; persisted
  // Dietary preferences, stored on the profile row (cross-device); honored silently by the generator.
  let dietPrefs = { diets: [], allergies: [], avoid: [] };

  // ---------- Per-user local persistence ----------
  // Namespaced by user id so two accounts on one device don't collide.
  function userKey(name) { return `hi:${loadedUserId || "anon"}:${name}`; }
  function loadLocal(name, fallback) {
    try {
      const v = localStorage.getItem(userKey(name));
      return v == null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  }
  function saveLocal(name, value) {
    try { localStorage.setItem(userKey(name), JSON.stringify(value)); } catch {}
  }
  function loadUserLocalState() {
    loadLocal("basket", []).forEach(([id, v]) => basket.set(id, v));
    loadLocal("checked", []).forEach((k) => checkedGroceryItems.add(k));
    skipPantryStaples = loadLocal("skipStaples", false);
    manualGroceryItems = loadLocal("manualItems", []);
    loadLocal("mealTray", []).forEach((id) => mealPlanTray.add(id));
    householdServings = loadLocal("household", null);
    aisleOrder = loadStoredAisleOrder();
    seenPickHint = loadLocal("seenPickHint", false);
    seenIntro = loadLocal("seenIntro", false);
    planView = loadLocal("planView", "dinners");
    collapsedInvCats = new Set(loadLocal("invCollapsed", []));
  }
  function maybeShowIntro() {
    introCardEl.hidden = seenIntro;
  }
  function persistGrocery() {
    saveLocal("basket", [...basket.entries()]);
    saveLocal("checked", [...checkedGroceryItems]);
    saveLocal("skipStaples", skipPantryStaples);
    saveLocal("manualItems", manualGroceryItems);
  }

  const DATA = { recipes: [], cocktails: [], sharedRecipes: [], sharedCocktails: [] };
  const POOL_KEY = { recipes: "recipes", cocktails: "cocktails" };
  const SHARED_POOL_KEY = { recipes: "sharedRecipes", cocktails: "sharedCocktails" };
  let byId = {};

  // ---------- Supabase ----------
  if (!window.supabase) {
    const s = document.getElementById("auth-status");
    if (s) s.textContent = "Couldn’t load the app — check your connection and refresh.";
    return;
  }
  const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  let session = null;

  // ---------- Elements ----------
  const $ = (sel) => document.querySelector(sel);
  const listEl = $("#item-list");
  const searchEl = $("#search");
  const tagFiltersEl = $("#tag-filters");
  const toggleFiltersBtn = $("#toggle-filters");
  const toggleFavoritesBtn = $("#toggle-favorites");
  const toggleSharedBtn = $("#toggle-shared");
  const activeFiltersEl = $("#active-filters");
  const resultCountEl = $("#result-count");
  const emptyEl = $("#empty-state");
  const groceryBar = $("#grocery-bar");
  const grocerySummary = $("#grocery-summary");
  const groceryPanel = $("#grocery-panel");
  const groceryContent = $("#grocery-content");
  const groceryProgressEl = $("#grocery-progress");
  const shoppingModeToggle = $("#shopping-mode-toggle");
  const backupPanel = $("#backup-panel");
  const guidePanel = $("#guide-panel");
  const placeSheet = $("#place-sheet");
  const placeSheetTitle = $("#place-sheet-title");
  const placeSheetBody = $("#place-sheet-body");
  const authGate = $("#auth-gate");
  const authForm = $("#auth-form");
  const authEmailEl = $("#auth-email");
  const authPasswordEl = $("#auth-password");
  const authSubmitBtn = $("#auth-submit");
  const authForgotBtn = $("#auth-forgot");
  const authStatusEl = $("#auth-status");
  const authSubEl = $("#auth-sub");
  const authSwitchBtn = $("#auth-switch");
  const authSwitchLabel = $("#auth-switch-label");
  const accountArea = $("#account-area");
  const accountBtn = $("#account-btn");
  const accountPanel = $("#account-panel");
  const accountEmailEl = $("#account-email");
  const accountMenu = $("#account-menu");
  const accountResetForm = $("#account-reset");
  const accountResetIntro = $("#account-reset-intro");
  const accountNewPass = $("#account-newpass");
  const accountNewPass2 = $("#account-newpass2");
  const accountResetStatus = $("#account-reset-status");
  const accountHouseholdInput = $("#account-household-servings");
  const addRecipeBtn = $("#add-recipe");
  const recipeFormPanel = $("#recipe-form-panel");
  const recipeForm = $("#recipe-form");
  const recipeFormTitle = $("#recipe-form-title");
  const recipeFormStatus = $("#recipe-form-status");
  const closeRecipeFormBtn = $("#close-recipe-form");
  const deleteRecipeBtn = $("#delete-recipe");
  const rfId = $("#rf-id");
  const rfName = $("#rf-name");
  const rfSubtitle = $("#rf-subtitle");
  const rfSource = $("#rf-source");
  const rfServings = $("#rf-servings");
  const rfServingsLabel = $("#rf-servings-label");
  const rfTagsKitchen = $("#rf-tags-kitchen");
  const rfTagsBar = $("#rf-tags-bar");
  const rfNotes = $("#rf-notes");
  const rfIngredients = $("#rf-ingredients");
  const rfMethod = $("#rf-method");
  const rfAddIngredientBtn = $("#rf-add-ingredient");
  const rfAddStepBtn = $("#rf-add-step");
  const rfReorderStepsBtn = $("#rf-reorder-steps");
  const rfReorderIngredientsBtn = $("#rf-reorder-ingredients");

  // B2 header / toolbar elements
  const modeRecipesBtn = $("#mode-recipes");
  const modeMealplanBtn = $("#mode-mealplan");
  const recipesControlsEl = $("#recipes-controls");
  const mealPlanView = $("#meal-plan-view");
  const scopeAllBtn = $("#scope-all");
  const addToggle = $("#add-toggle");
  const addMenu = $("#add-menu");
  const detailMoreMenu = $("#detail-more-menu");
  const addFab = $("#add-fab");
  const resultRowEl = $(".result-row");
  const pickHintEl = $("#pick-hint");
  const pickHintDismissBtn = $("#pick-hint-dismiss");
  const introCardEl = $("#intro-card");
  const introDismissBtn = $("#intro-dismiss");

  const addRecipeAiBtn = $("#add-recipe-ai");
  const aiImportPanel = $("#ai-import-panel");
  const closeAiImportBtn = $("#close-ai-import");
  const aiImportPicker = $("#ai-import-picker");
  const aiImportLoading = $("#ai-import-loading");
  const aiImportStatus = $("#ai-import-status");
  const aiImportCancelBtn = $("#ai-import-cancel");
  const aiPhotoInput = $("#ai-photo-input");
  const aiPhotoLabel = $("#ai-photo-label");
  const aiPhotoArea = $("#ai-photo-area");
  const aiPhotoThumbs = $("#ai-photo-thumbs");
  const aiPhotoAddBtn = $("#ai-photo-add");
  const aiPhotoExtractBtn = $("#ai-photo-extract");
  const aiPasteTextBtn = $("#ai-paste-text-btn");
  const aiTextArea = $("#ai-text-area");
  const aiTextInput = $("#ai-text-input");
  const aiTextSubmitBtn = $("#ai-text-submit");
  const aiLinkBtn = $("#ai-link-btn");
  const aiLinkArea = $("#ai-link-area");
  const aiLinkInput = $("#ai-link-input");
  const aiLinkSubmitBtn = $("#ai-link-submit");

  // Dietary preferences (account panel)
  const dietDietsEl = $("#diet-diets");
  const dietAllergiesEl = $("#diet-allergies");
  const dietAllergiesInput = $("#diet-allergies-input");
  const dietAvoidEl = $("#diet-avoid");
  const dietAvoidInput = $("#diet-avoid-input");

  // Bar & pantry inventory panel
  const openInventoryBtn = $("#open-inventory");
  const inventoryPanel = $("#inventory-panel");
  const closeInventoryBtn = $("#close-inventory");
  const invTabBar = $("#inv-tab-bar");
  const invTabPantry = $("#inv-tab-pantry");
  const invAddForm = $("#inv-add");
  const invCategorySelect = $("#inv-category");
  const invNameInput = $("#inv-name");
  const inventoryContent = $("#inventory-content");
  const invGenerateBtn = $("#inv-generate");

  // AI recipe generator panel
  const addRecipeGenerateBtn = $("#add-recipe-generate");
  const generatePanel = $("#generate-panel");
  const closeGenerateBtn = $("#close-generate");
  const generateForm = $("#generate-form");
  const generateConcepts = $("#generate-concepts");
  const genConceptList = $("#gen-concept-list");
  const genConceptsBackBtn = $("#gen-concepts-back");
  const genConceptsRerollBtn = $("#gen-concepts-reroll");
  const generateLoading = $("#generate-loading");
  const generateLoadingMsg = $("#generate-loading-msg");
  const generateStatus = $("#generate-status");
  const generateCancelBtn = $("#generate-cancel");
  const genHintEl = $("#gen-hint");
  const genDietLineEl = $("#gen-diet-line");
  const genIngChips = $("#gen-ing-chips");
  const genIngInput = $("#gen-ing-input");
  const genIngAddBtn = $("#gen-ing-add");
  const genSubmitBtn = $("#gen-submit");
  const genCuisineLabel = $("#gen-opt-cuisine-label");
  const rfInventoryCheck = $("#rf-inventory-check");

  // Describe-a-recipe panel
  const addRecipePromptBtn = $("#add-recipe-prompt");
  const promptPanel = $("#prompt-panel");
  const closePromptBtn = $("#close-prompt");
  const promptForm = $("#prompt-form");
  const promptLoading = $("#prompt-loading");
  const promptStatus = $("#prompt-status");
  const promptCancelBtn = $("#prompt-cancel");
  const promptDietLine = $("#prompt-diet-line");
  const promptInput = $("#prompt-input");
  const promptSubmitBtn = $("#prompt-submit");

  const coachPanel = $("#coach-panel");
  const coachRecipeName = $("#coach-recipe-name");
  const coachThread = $("#coach-thread");
  const coachLoading = $("#coach-loading");
  const coachStatus = $("#coach-status");
  const coachInput = $("#coach-input");
  const coachSendBtn = $("#coach-send");
  const coachModeTroubleshootBtn = $("#coach-mode-troubleshoot");
  const coachModeTweakBtn = $("#coach-mode-tweak");
  const cookPanel = $("#cook-panel");
  const cookTitle = $("#cook-title");
  const cookCloseBtn = $("#cook-close");
  const cookProgressBar = $("#cook-progress-bar");
  const cookRailEl = $("#cook-rail");
  const cookBody = $("#cook-body");
  const cookStepNum = $("#cook-step-num");
  const cookStepText = $("#cook-step-text");
  const cookStepIngredients = $("#cook-step-ingredients");
  const cookTimerChips = $("#cook-timer-chips");
  const cookTimerBar = $("#cook-timer-bar");
  const cookTimerLabel = $("#cook-timer-label");
  const cookTimerClock = $("#cook-timer-clock");
  const cookTimerPauseBtn = $("#cook-timer-pause");
  const cookTimerStopBtn = $("#cook-timer-stop");
  const cookIngredients = $("#cook-ingredients");
  const cookPrevBtn = $("#cook-prev");
  const cookNextBtn = $("#cook-next");
  const cookIngToggle = $("#cook-ing-toggle");
  const cookSectionsEl = $("#cook-sections");

  // ---------- Helpers ----------
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  // Format a scaled amount nicely (¼, ⅓, ½, etc. where clean)
  function fmtAmount(n) {
    if (n == null) return "";
    const whole = Math.floor(n);
    const frac = n - whole;
    const fractions = [
      [0.25, "\u00BC"], [0.333, "\u2153"], [0.5, "\u00BD"],
      [0.667, "\u2154"], [0.75, "\u00BE"], [0.125, "\u215B"],
      [0.375, "\u215C"], [0.625, "\u215D"], [0.875, "\u215E"]
    ];
    for (const [v, sym] of fractions) {
      if (Math.abs(frac - v) < 0.02) return (whole ? whole + " " : "") + sym;
    }
    if (Math.abs(frac) < 0.02) return String(whole);
    // otherwise trim to max 2 decimals
    return String(Math.round(n * 100) / 100);
  }

  function scaledIngredients(item, servings) {
    const k = servings / item.baseServings;
    return item.ingredients.map((ing) => ({
      ...ing,
      scaled: ing.amount == null ? null : ing.amount * k
    }));
  }

  function ingLine(ing, useScaled, system) {
    const rawAmt = useScaled ? ing.scaled : ing.amount;
    const conv = convertForDisplay(rawAmt, ing.unit, system || "original");
    const amtStr = conv.amount == null ? "\u2014" : fmtAmount(conv.amount) + (conv.unit ? " " + conv.unit : "");
    return { amtStr, item: ing.item };
  }

  // Split a list of ingredients or steps into consecutive runs sharing the same
  // `group` label, so each sub-recipe section ("Dough", "Sauce") can render
  // under its own heading. Ungrouped items (group null) form their own run with
  // no heading \u2014 a recipe with no groups yields a single run, identical to before.
  function groupRuns(items) {
    const runs = [];
    items.forEach((it) => {
      const g = it.group || null;
      const last = runs[runs.length - 1];
      if (last && last.group === g) last.items.push(it);
      else runs.push({ group: g, items: [it] });
    });
    return runs;
  }

  // ---------- Grocery unit normalization ----------
  // Recipes keep whatever units they were written in (a baking recipe might
  // weigh 3.5g of yeast; a frosting might use cups). For shopping, every
  // weight is combined in grams and every volume in milliliters, then the
  // combined total is converted to what a US grocery store sells (oz/lb,
  // cups/tbsp/tsp). Small gram amounts (spices, yeast, leavening) are left
  // as-is \u2014 "0.12 oz yeast" isn't more useful than "3.5 g yeast" at the store.
  const G_PER_OZ = 28.3495;
  const G_PER_LB = 453.592;
  const ML_PER_CUP = 236.588;
  const ML_PER_TBSP = 14.7868;
  const ML_PER_TSP = 4.92892;
  const MIN_SHOPPABLE_GRAMS = 50;

  const WEIGHT_TO_G = {
    g: 1, gram: 1, grams: 1, kg: 1000, kilogram: 1000, kilograms: 1000,
    oz: G_PER_OZ, ounce: G_PER_OZ, ounces: G_PER_OZ,
    lb: G_PER_LB, lbs: G_PER_LB, pound: G_PER_LB, pounds: G_PER_LB
  };
  const VOLUME_TO_ML = {
    ml: 1, milliliter: 1, milliliters: 1, millilitre: 1, millilitres: 1,
    l: 1000, liter: 1000, liters: 1000, litre: 1000, litres: 1000,
    tsp: ML_PER_TSP, teaspoon: ML_PER_TSP, teaspoons: ML_PER_TSP,
    tbsp: ML_PER_TBSP, tablespoon: ML_PER_TBSP, tablespoons: ML_PER_TBSP,
    cup: ML_PER_CUP, cups: ML_PER_CUP
  };
  const UNIT_SYNONYMS = {
    clove: "clove", cloves: "clove",
    can: "can", cans: "can",
    slice: "slice", slices: "slice"
  };

  // Convert (amount, unit) to a canonical form for combining across recipes:
  // weights -> grams, volumes -> milliliters, everything else is just
  // spelling-normalized (e.g. "cloves" -> "clove").
  function canonicalQuantity(amount, unit) {
    if (!unit) return { amount, family: null, unit: null };
    const u = unit.trim().toLowerCase();
    if (WEIGHT_TO_G[u] != null) {
      return { amount: amount == null ? null : amount * WEIGHT_TO_G[u], family: "weight", unit: null };
    }
    if (VOLUME_TO_ML[u] != null) {
      return { amount: amount == null ? null : amount * VOLUME_TO_ML[u], family: "volume", unit: null };
    }
    return { amount, family: null, unit: UNIT_SYNONYMS[u] || u };
  }

  const ceilToQuarter = (n) => Math.ceil(n * 4) / 4;
  const ceilToHalf = (n) => Math.ceil(n * 2) / 2;

  // Convert a combined canonical quantity to what's sold at a US grocery store,
  // rounded UP to a practical increment so the list never has you under-buy:
  // weights to the nearest ¼ oz/lb, volumes to ¼ cup / ½ tbsp / ¼ tsp, and
  // loose counts to a whole number (you can't buy 1.3 onions). Weights ≥12 oz
  // switch to lb — nobody buys ground beef in quarter-ounces, and a "~1 lb"
  // reads far more like a real shopping amount than "14¼ oz".
  function shoppableQuantity(amount, family, unit) {
    if (amount == null) return { amount: null, unit };
    if (family === "weight") {
      if (amount < MIN_SHOPPABLE_GRAMS) return { amount: Math.round(amount), unit: "g" };
      const oz = amount / G_PER_OZ;
      return oz >= 12
        ? { amount: ceilToQuarter(amount / G_PER_LB), unit: "lb" }
        : { amount: ceilToQuarter(oz), unit: "oz" };
    }
    if (family === "volume") {
      const cups = amount / ML_PER_CUP;
      if (cups >= 0.2) return { amount: ceilToQuarter(cups), unit: "cup" };
      const tbsp = amount / ML_PER_TBSP;
      return tbsp >= 1
        ? { amount: ceilToHalf(tbsp), unit: "tbsp" }
        : { amount: ceilToQuarter(amount / ML_PER_TSP), unit: "tsp" };
    }
    return { amount: Math.ceil(amount), unit };
  }

  // Convert an ingredient amount into a target unit system for the per-recipe
  // toggle. "original" leaves it untouched; "metric" gives weights in g/kg and
  // volumes in ml/l; "us" gives weights in oz/lb and volumes in tsp/tbsp/cup.
  // Units that are neither weight nor volume (cloves, cans, slices, plain
  // counts) and blank "to taste" amounts pass through unchanged — there's no
  // sensible metric form of "2 cloves garlic".
  function convertForDisplay(amount, unit, system) {
    if (system === "original" || amount == null || !unit) return { amount, unit };
    const u = unit.trim().toLowerCase();
    const gramsPer = WEIGHT_TO_G[u];
    if (gramsPer != null) {
      const g = amount * gramsPer;
      if (system === "metric") {
        return g >= 1000 ? { amount: g / 1000, unit: "kg" } : { amount: g, unit: "g" };
      }
      const oz = g / G_PER_OZ;
      return oz >= 16 ? { amount: oz / 16, unit: "lb" } : { amount: oz, unit: "oz" };
    }
    const mlPer = VOLUME_TO_ML[u];
    if (mlPer != null) {
      const ml = amount * mlPer;
      if (system === "metric") {
        return ml >= 1000 ? { amount: ml / 1000, unit: "l" } : { amount: ml, unit: "ml" };
      }
      if (ml / ML_PER_CUP >= 0.25) return { amount: ml / ML_PER_CUP, unit: "cup" };
      if (ml / ML_PER_TBSP >= 1) return { amount: ml / ML_PER_TBSP, unit: "tbsp" };
      return { amount: ml / ML_PER_TSP, unit: "tsp" };
    }
    return { amount, unit }; // not a convertible unit
  }

  // Always-on-hand items that don't belong on a shopping list. One precompiled
  // alternation (rather than building 6 RegExps per ingredient per render).
  const PANTRY_STAPLE_TERMS = ["salt", "pepper", "oil", "water", "sugar", "butter", "flour"];
  const PANTRY_STAPLE_RE = new RegExp(`\\b(?:${PANTRY_STAPLE_TERMS.join("|")})\\b`, "i");
  function isPantryStaple(nameLower) {
    // Don't let produce peppers (bell/red/chili pepper) or specialty flours
    // (almond/coconut/etc.) trip the staple match — only true staples skip.
    const n = nameLower
      .replace(/\b(?:bell|red|green|chili|chilli|sweet|cayenne|lemon|jalape\w*)\s+pepper/g, " ")
      .replace(/\b(?:almond|coconut|oat|rice|chickpea|nut)\s+flour/g, " ");
    return PANTRY_STAPLE_RE.test(n);
  }

  // Normalize an ingredient name for COMBINING and CATEGORIZING only — the name
  // shown in the list keeps its original wording. Strips prep notes and folds
  // common descriptor synonyms so e.g. "Salt and Black Pepper, to taste" and
  // "salt and pepper", or "guanciale, diced" and "guanciale", land on one line.
  const PREP_WORDS = "to taste|diced|chopped|finely chopped|roughly chopped|minced|grated|finely grated|freshly grated|shredded|sliced|thinly sliced|cubed|crushed|melted|softened|room temperature|at room temperature|sifted|divided|drained|rinsed|optional|peeled|seeded|deseeded|halved|quartered|crumbled|beaten|packed|cooked|uncooked|toasted|warmed|chilled";
  const PREP_CLAUSE_RE = new RegExp(`,\\s*(?:${PREP_WORDS}|plus more\\b.*|for\\b.*|to top\\b.*|to serve\\b.*|to garnish\\b.*)[^,]*`, "gi");
  function normalizeItemName(name) {
    let s = String(name).toLowerCase().trim();
    s = s.replace(/\([^)]*\)/g, " ");        // drop parentheticals "(sauce)", "(⅔ cup)"
    s = s.split(/\s[—–-]\s/)[0];             // drop a trailing dash note ("olive oil — a splash")
    s = s.replace(PREP_CLAUSE_RE, " ");      // drop known prep clauses (keeps "boneless, skinless …")
    s = s
      .replace(/\b(?:black|white|freshly ground|ground)\s+pepper\b/g, "pepper")
      .replace(/\b(?:kosher|sea|maldon|flaky|fine|table)\s+salt\b/g, "salt")
      .replace(/\bextra[-\s]?virgin\s+olive oil\b/g, "olive oil")
      .replace(/\bevoo\b/g, "olive oil")
      .replace(/\bscallions?\b/g, "green onion")
      .replace(/\bconfectioners'?\s+sugar\b/g, "powdered sugar")
      .replace(/\bgarbanzos?\b/g, "chickpea");
    return s.replace(/\s+/g, " ").trim();
  }

  // The name shown on the grocery list: keep the original wording, casing, and
  // product adjectives ("peeled tomatoes", "floury potatoes"), but drop prep
  // instructions the shopper doesn't need ("carrots, diced" -> "carrots",
  // "potatoes, peeled and chopped" -> "potatoes", "olive oil — a splash" ->
  // "olive oil"). Comma clauses that aren't prep ("boneless, skinless chicken")
  // are left intact.
  function displayGroceryName(item) {
    let s = String(item).trim();
    s = s.split(/\s[—–-]\s/)[0];          // drop a trailing dash note
    s = s.replace(PREP_CLAUSE_RE, "");    // drop known prep clauses
    return s.replace(/\s+/g, " ").replace(/[\s,]+$/, "").trim();
  }

  // ---------- Grocery store aisle categorization ----------
  // Keyword buckets that sort the combined shopping list into store sections.
  // Rules are tested in array order and the first match wins, so conflict-prone
  // buckets come before the fresh aisles they could otherwise steal from:
  // Frozen before Produce ("frozen peas" -> Frozen), Canned before Meat/Dairy
  // ("chicken broth" -> Canned, "coconut milk" -> Canned). Word boundaries (\b)
  // keep e.g. "gin" out of "ginger" and "ale" out of "kale". Anything unmatched
  // falls to "Other". It's a heuristic on free-text ingredient names, not a
  // product database, so the odd item lands a shelf over — easy to eyeball.
  const GROCERY_CATEGORY_RULES = [
    { name: "Frozen", terms: ["frozen", "ice cream", "gelato", "sherbet", "popsicle", "tater tot", "tater tots"] },
    { name: "Canned & Jarred", terms: ["canned", "broth", "stock", "bouillon", "condensed", "cream of", "soup", "tomato sauce", "tomato paste", "tomato puree", "crushed tomato", "crushed tomatoes", "diced tomato", "diced tomatoes", "stewed tomato", "marinara", "pasta sauce", "coconut milk", "evaporated milk", "sweetened condensed", "black bean", "black beans", "kidney bean", "kidney beans", "pinto bean", "pinto beans", "white bean", "white beans", "navy bean", "cannellini", "garbanzo", "chickpea", "chickpeas", "refried", "baked bean", "baked beans", "olives", "pickle", "pickles", "relish", "salsa", "jam", "jelly", "preserves", "enchilada sauce", "green chile", "green chiles", "green chilies", "water chestnut", "water chestnuts", "artichoke heart", "artichoke hearts", "roasted red pepper", "anchovy", "anchovies", "capers", "jarred", "applesauce", "pumpkin puree", "canned tuna"] },
    { name: "Bakery", terms: ["bread", "tortilla", "tortillas", "bun", "buns", "bagel", "bagels", "pita", "baguette", "roll", "rolls", "croissant", "naan", "english muffin", "pie crust", "pizza dough", "biscuit", "biscuits", "focaccia", "dinner roll", "hamburger bun", "hot dog bun"] },
    { name: "Produce", terms: ["onion", "onions", "garlic", "tomato", "tomatoes", "potato", "potatoes", "carrot", "carrots", "celery", "lettuce", "romaine", "spinach", "kale", "arugula", "chard", "broccoli", "cauliflower", "cucumber", "cucumbers", "zucchini", "squash", "pumpkin", "butternut", "mushroom", "mushrooms", "cremini", "portobello", "shiitake", "bell pepper", "bell peppers", "jalapeno", "jalapeño", "serrano", "poblano", "lemon", "lemons", "lime", "limes", "orange", "oranges", "apple", "apples", "banana", "bananas", "berry", "berries", "strawberry", "strawberries", "blueberry", "blueberries", "raspberry", "raspberries", "grape", "grapes", "avocado", "avocados", "ginger", "cilantro", "parsley", "basil", "mint", "thyme", "rosemary", "sage", "dill", "scallion", "scallions", "green onion", "green onions", "shallot", "shallots", "leek", "leeks", "corn", "cabbage", "eggplant", "asparagus", "green bean", "green beans", "snap pea", "snap peas", "peas", "sweet potato", "sweet potatoes", "yam", "beet", "beets", "radish", "turnip", "parsnip", "fennel", "herbs", "pineapple", "mango", "peach", "peaches", "pear", "pears", "cherry", "cherries", "cranberry", "cranberries", "melon", "watermelon", "sprouts", "bok choy", "chilli", "chillies", "chile", "chiles", "chile pepper", "red chili", "red chilli", "thai chili", "thai chilli", "fresno", "habanero", "scotch bonnet", "bird's eye"] },
    { name: "Meat & Seafood", terms: ["chicken", "beef", "pork", "bacon", "sausage", "sausages", "ham", "turkey", "lamb", "steak", "steaks", "mince", "ground beef", "ground turkey", "ground pork", "ground chicken", "ground meat", "salmon", "tuna", "shrimp", "prawn", "prawns", "fish", "cod", "tilapia", "halibut", "crab", "lobster", "scallop", "scallops", "chorizo", "prosciutto", "pancetta", "ribs", "brisket", "veal", "duck", "meatball", "meatballs", "filet", "fillet", "tenderloin", "sirloin", "ribeye", "chuck roast", "wings", "drumstick", "drumsticks", "thigh", "thighs", "chicken breast", "pepperoni", "salami", "bratwurst", "hot dog", "hot dogs", "guanciale", "capicola", "capocollo", "soppressata", "mortadella", "speck", "bresaola", "pastrami", "corned beef", "andouille", "kielbasa", "lardons", "ground lamb", "ground veal", "short rib", "short ribs", "flank", "skirt steak", "oxtail", "jowl"] },
    // Nut/seed butters are pantry spreads, not dairy — caught before the Dairy
    // rule's bare "butter" term so "peanut butter" doesn't land in Dairy.
    { name: "Dry Goods & Baking", terms: ["peanut butter", "almond butter", "cashew butter", "sunflower butter", "sunflower seed butter", "nut butter", "cocoa butter"] },
    { name: "Dairy & Eggs", terms: ["milk", "butter", "cheese", "cheddar", "mozzarella", "parmesan", "parmigiano", "feta", "ricotta", "gouda", "swiss cheese", "provolone", "monterey jack", "pepper jack", "cream cheese", "sour cream", "heavy cream", "whipping cream", "half and half", "yogurt", "yoghurt", "egg", "eggs", "margarine", "buttermilk", "cottage cheese", "mascarpone", "creme fraiche", "almond milk", "oat milk", "soy milk", "cream", "burrata", "pecorino", "romano", "gruyere", "gruyère", "asiago", "manchego", "brie", "camembert", "havarti", "queso", "cotija", "halloumi", "paneer"] },
    { name: "Dry Goods & Baking", terms: ["flour", "sugar", "brown sugar", "powdered sugar", "confectioners", "rice", "pasta", "spaghetti", "penne", "macaroni", "fettuccine", "linguine", "noodle", "noodles", "bucatini", "rigatoni", "fusilli", "farfalle", "orzo", "ziti", "rotini", "tagliatelle", "pappardelle", "gnocchi", "lasagna", "lasagne", "vermicelli", "cavatappi", "orecchiette", "gemelli", "ravioli", "tortellini", "cannelloni", "manicotti", "angel hair", "capellini", "ditalini", "paccheri", "conchiglie", "oat", "oats", "oatmeal", "quinoa", "lentil", "lentils", "couscous", "barley", "cornmeal", "cornstarch", "corn starch", "baking powder", "baking soda", "yeast", "cocoa", "vanilla", "almond extract", "chocolate chip", "chocolate chips", "chocolate", "nut", "nuts", "almond", "almonds", "walnut", "walnuts", "pecan", "pecans", "cashew", "cashews", "peanut", "peanuts", "raisin", "raisins", "honey", "maple syrup", "syrup", "molasses", "breadcrumb", "breadcrumbs", "panko", "cereal", "granola", "cracker", "crackers", "gelatin", "shortening", "split pea", "polenta", "grits", "sesame seed", "sesame seeds", "chia", "flax", "sunflower seed", "shredded coconut", "coconut flake", "marshmallow", "marshmallows", "sprinkles", "cake mix", "pancake mix", "baking mix", "crisco", "semolina", "masa", "arrowroot", "tapioca"] },
    { name: "Condiments, Sauces & Spices", terms: ["salt", "pepper", "peppercorn", "soy sauce", "worcestershire", "fish sauce", "oyster sauce", "hoisin", "sriracha", "hot sauce", "tabasco", "ketchup", "catsup", "mustard", "mayo", "mayonnaise", "vinegar", "oil", "olive oil", "vegetable oil", "canola", "sesame oil", "cooking spray", "dressing", "ranch", "bbq sauce", "barbecue sauce", "teriyaki", "gravy", "pesto", "tahini", "miso", "gochujang", "sambal", "harissa", "horseradish", "spice", "spices", "cumin", "paprika", "cinnamon", "nutmeg", "oregano", "garlic powder", "onion powder", "chili powder", "cayenne", "turmeric", "curry", "coriander", "cardamom", "clove", "cloves", "allspice", "bay leaf", "bay leaves", "red pepper flake", "red pepper flakes", "italian seasoning", "seasoning", "garam masala", "extract", "mustard seed", "sea salt", "kosher salt", "taco seasoning", "sauce"] },
    // Alcohol gets its own aisle, separate from non-alcoholic Beverages, so a
    // bar restock (wine, spirits, liqueurs, bitters) never mixes with soda/coffee/tea.
    { name: "Alcohol", terms: ["wine", "beer", "ale", "lager", "cider", "rum", "vodka", "gin", "tequila", "whiskey", "whisky", "bourbon", "brandy", "vermouth", "liqueur", "triple sec", "champagne", "prosecco", "sake", "campari", "aperol", "chartreuse", "amaro", "amaretto", "cointreau", "grand marnier", "st-germain", "pimm", "bitters", "angostura", "sherry", "port", "mezcal", "scotch", "rye", "absinthe", "curacao", "verjus", "shochu", "shōchū", "soju", "spirit"] },
    { name: "Beverages", terms: ["soda", "cola", "tonic", "club soda", "sparkling water", "seltzer", "coffee", "espresso", "tea", "lemonade"] }
  ];
  const GROCERY_CATEGORY_RE = GROCERY_CATEGORY_RULES.map((c) => ({
    name: c.name,
    re: new RegExp(`\\b(?:${c.terms.join("|")})\\b`, "i")
  }));
  const OTHER_CATEGORY = "Other";
  // Default store-walk order for display (independent of the match-priority
  // order above); empty sections are skipped, "Other" is always last. The
  // user can customize this via "Reorder aisles" — see aisleOrder/loadStoredAisleOrder.
  const GROCERY_CATEGORY_ORDER = ["Produce", "Bakery", "Meat & Seafood", "Dairy & Eggs", "Frozen", "Canned & Jarred", "Dry Goods & Baking", "Condiments, Sauces & Spices", "Beverages", "Alcohol", OTHER_CATEGORY];

  // Merge a stored aisle order with the current category list, so a category
  // added to the app after the user last reordered still shows up (appended,
  // before "Other") instead of silently vanishing from the grocery panel.
  function loadStoredAisleOrder() {
    const stored = loadLocal("aisleOrder", null);
    if (!stored) return GROCERY_CATEGORY_ORDER.slice();
    const known = GROCERY_CATEGORY_ORDER.filter((c) => c !== OTHER_CATEGORY);
    const kept = stored.filter((c) => known.includes(c));
    const missing = known.filter((c) => !kept.includes(c));
    return [...kept, ...missing, OTHER_CATEGORY];
  }

  function categorizeGrocery(nameLower) {
    for (const c of GROCERY_CATEGORY_RE) {
      if (c.re.test(nameLower)) return c.name;
    }
    return OTHER_CATEGORY;
  }

  // Group a flat combined-grocery list into store sections, in the user's
  // aisle-walk order, skipping any section with no items.
  function groceryByCategory(items) {
    const buckets = new Map();
    items.forEach((it) => {
      const cat = categorizeGrocery(normalizeItemName(it.item));
      if (!buckets.has(cat)) buckets.set(cat, []);
      buckets.get(cat).push(it);
    });
    return (aisleOrder || GROCERY_CATEGORY_ORDER)
      .filter((cat) => buckets.has(cat))
      .map((cat) => ({ category: cat, items: buckets.get(cat) }));
  }

  // ---------- Data loading (Supabase) ----------
  function mapRecipe(row) {
    return {
      id: row.id,
      section: row.section,
      name: row.name,
      subtitle: row.subtitle,
      source: row.source,
      tags: row.tags || [],
      baseServings: row.base_servings,
      servingsLabel: row.servings_label,
      ingredients: row.ingredients || [],
      // Steps used to be plain strings; they're now {text, group} objects so a
      // step can belong to a sub-recipe section. Normalize legacy strings here
      // so the rest of the app always sees the object shape.
      method: (row.method || []).map((s) =>
        typeof s === "string"
          ? { text: s, group: null }
          : { text: s.text ?? "", group: s.group ?? null }
      ),
      specs: row.specs,
      notes: row.notes,
      isFavorite: !!row.is_favorite,
      userId: row.user_id
    };
  }

  async function loadProfiles() {
    const { data, error } = await supabaseClient.from("profiles").select("id, display_name");
    if (error) return; // attribution is cosmetic — don't block the rest of loadData
    profileNames = {};
    (data || []).forEach((p) => { profileNames[p.id] = p.display_name; });
  }

  async function ensureProfile() {
    if (!session || profileNames[session.user.id]) return;
    const displayName = session.user.email.split("@")[0];
    const { error } = await supabaseClient.from("profiles")
      .upsert({ id: session.user.id, display_name: displayName }, { onConflict: "id" });
    if (!error) profileNames[session.user.id] = displayName;
  }

  // ---------- Dietary preferences (profile-backed, cross-device) ----------
  // Normalize whatever's in the jsonb column to the three-array shape the
  // generator expects, tolerating an empty {} default or a partial row.
  function normalizeDietPrefs(raw) {
    const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
    return { diets: arr(raw?.diets), allergies: arr(raw?.allergies), avoid: arr(raw?.avoid) };
  }
  async function loadMyDietPrefs() {
    if (!session) { dietPrefs = { diets: [], allergies: [], avoid: [] }; return; }
    const { data, error } = await supabaseClient
      .from("profiles").select("diet_prefs").eq("id", session.user.id).single();
    // Missing row/column or any error → keep the empty default (fail open).
    dietPrefs = error ? { diets: [], allergies: [], avoid: [] } : normalizeDietPrefs(data?.diet_prefs);
  }
  async function saveDietPrefs() {
    if (!session) return;
    await ensureProfile(); // guarantee the row exists before writing settings onto it
    const { error } = await supabaseClient.from("profiles")
      .upsert({ id: session.user.id, diet_prefs: dietPrefs }, { onConflict: "id" });
    if (error) toast("Couldn’t save dietary preferences — try again.");
  }

  // ---------- Bar & pantry inventory (Supabase-backed) ----------
  function mapInventoryRow(r) {
    return { id: r.id, section: r.section, category: r.category, name: r.name, status: r.status };
  }
  async function loadInventory() {
    if (!session) { inventory = []; return; }
    const { data, error } = await supabaseClient
      .from("inventory_items").select("*").order("section").order("category");
    inventory = error ? [] : (data || []).map(mapInventoryRow);
  }
  async function addInventoryItem({ section: sec, category, name, status }) {
    if (!session) { toast("You've been signed out — sign in again."); return; }
    const row = { section: sec, category: category || null, name: name || null, status: status || "in" };
    const { data, error } = await supabaseClient
      .from("inventory_items").insert(row).select().single();
    if (error) { toast(`Couldn't add: ${error.message}`); return; }
    inventory.push(mapInventoryRow(data));
    renderInventoryPanel();
  }
  async function updateInventoryStatus(id, status) {
    const item = inventory.find((i) => i.id === id);
    if (!item) return;
    const prev = item.status;
    item.status = status; // optimistic
    renderInventoryPanel();
    const { error } = await supabaseClient.from("inventory_items").update({ status }).eq("id", id);
    if (error) { item.status = prev; renderInventoryPanel(); toast(`Couldn't update: ${error.message}`); }
  }
  async function removeInventoryItem(id) {
    const { error } = await supabaseClient.from("inventory_items").delete().eq("id", id);
    if (error) { toast(`Couldn't remove: ${error.message}`); return; }
    inventory = inventory.filter((i) => i.id !== id);
    renderInventoryPanel();
  }

  // Re-render every view that depends on data / filters / basket state.
  function refreshViews() {
    renderTagFilters();
    renderActiveFilters();
    renderList();
    renderGroceryBar();
  }

  // Drop basket / open-row / active-tag references to recipes or tags that no
  // longer exist (e.g. a recipe deleted on another device). This lets us reload
  // data without nuking the user's whole grocery list, filters, and open rows.
  function pruneStaleState() {
    for (const id of [...basket.keys()]) if (!byId[id]) basket.delete(id);
    for (const id of [...openItems]) if (!byId[id]) openItems.delete(id);
    for (const id of [...openShareIds]) if (!byId[id]) openShareIds.delete(id);
    for (const id of [...mealPlanTray]) if (!byId[id]) mealPlanTray.delete(id);
    const allTags = new Set();
    Object.values(byId).forEach((it) => it.tags.forEach((t) => allTags.add(t)));
    for (const t of [...activeTags]) if (!allTags.has(t)) activeTags.delete(t);
  }

  async function loadData() {
    // Recipes, profile names, and my outgoing shares are independent reads —
    // fetch them concurrently rather than waiting on each other in turn.
    const recipesPromise = supabaseClient
      .from("recipes")
      .select("*")
      .order("name");
    const profilesPromise = loadProfiles();
    const me = session?.user?.id;
    // Inventory + dietary prefs are independent reads used by the generator and
    // the inventory panel — fetch alongside recipes, don't block the list render.
    const inventoryPromise = loadInventory();
    const dietPrefsPromise = loadMyDietPrefs();
    const sharesPromise = supabaseClient
      .from("recipe_shares")
      .select("recipe_id, shared_with_user_id")
      .eq("shared_by_user_id", me);

    const { data, error } = await recipesPromise;

    if (error) {
      toast("Couldn’t load your recipes — try refreshing");
      return;
    }

    const items = (data || []).map(mapRecipe);
    // RLS only ever returns rows you own or rows explicitly shared with you,
    // so every "not mine" row here is something someone shared with me.
    DATA.recipes         = items.filter((it) => it.section === "kitchen" && it.userId === me);
    DATA.cocktails       = items.filter((it) => it.section === "bar"     && it.userId === me);
    DATA.sharedRecipes   = items.filter((it) => it.section === "kitchen" && it.userId !== me);
    DATA.sharedCocktails = items.filter((it) => it.section === "bar"     && it.userId !== me);

    byId = {};
    items.forEach((it) => { byId[it.id] = it; });

    const { data: shares, error: sharesError } = await sharesPromise;
    sharesByRecipe = {};
    if (!sharesError) {
      (shares || []).forEach((s) => {
        (sharesByRecipe[s.recipe_id] || (sharesByRecipe[s.recipe_id] = [])).push(s.shared_with_user_id);
      });
    }

    await profilesPromise; // attribution names must be ready before we render
    await ensureProfile();
    await inventoryPromise; // resolve the background reads so a stale reload can't clobber
    await dietPrefsPromise;

    // Note: we deliberately do NOT blanket-clear basket / activeTags / openItems
    // here, so adding/editing/deleting a recipe doesn't wipe the user's grocery
    // list, filters, or expanded rows. We only prune references that went stale.
    pruneStaleState();
    refreshViews();
  }

  function clearData() {
    DATA.recipes = [];
    DATA.cocktails = [];
    DATA.sharedRecipes = [];
    DATA.sharedCocktails = [];
    profileNames = {};
    sharesByRecipe = {};
    byId = {};
    activeTags.clear();
    openItems.clear();
    openShareIds.clear();
    basket.clear();
    checkedGroceryItems.clear();
    skipPantryStaples = false;
    shoppingModeOn = false;
    manualGroceryItems = [];
    householdServings = null;
    aisleOrder = GROCERY_CATEGORY_ORDER.slice();
    seenPickHint = false;
    seenIntro = false;
    introCardEl.hidden = true;
    planView = "dinners";
    inventory = [];
    collapsedInvCats = new Set();
    dietPrefs = { diets: [], allergies: [], avoid: [] };
    mealPlan = [];
    mealPlanTray.clear();
    closePlaceSheet();
    favoritesOnly = false;
    toggleFavoritesBtn.setAttribute("aria-pressed", "false");
    sharedOnly = false;
    toggleSharedBtn.setAttribute("aria-pressed", "false");
    refreshViews();
  }

  // ---------- Auth ----------
  function initialsFrom(email) {
    const local = (email || "").split("@")[0];
    const parts = local.split(/[._\-+]+/).filter(Boolean);
    if (!parts.length) return "•";
    const first = parts[0][0];
    const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
    return (first + last).toUpperCase();
  }

  function updateAuthUI() {
    authGate.hidden = !!session;
    accountArea.hidden = !session;
    if (session) {
      accountEmailEl.textContent = session.user.email;
      accountBtn.textContent = initialsFrom(session.user.email);
    } else if (!accountPanel.hidden) accountPanel.hidden = true;
  }

  let loadedUserId = null; // whose data is currently loaded

  function initAuth() {
    // onAuthStateChange fires an INITIAL_SESSION event on subscribe, so it
    // handles the initial load too — no separate getSession() call is needed
    // (which would otherwise double-fetch the data on every page load).
    //
    // Data calls are deferred with setTimeout: supabase-js holds an internal
    // auth lock while this callback runs, and queries issued inside it (which
    // call getSession() under the hood) can deadlock — especially when a PWA
    // resumes after sitting in the background.
    supabaseClient.auth.onAuthStateChange((event, newSession) => {
      const wasSignedIn = !!session;
      session = newSession;
      updateAuthUI();
      if (session) {
        if (window.location.hash) history.replaceState(null, "", window.location.pathname + window.location.search);
        // TOKEN_REFRESHED fires roughly hourly — no need to refetch and
        // re-render everything when the same user's token rotates.
        const userChanged = session.user.id !== loadedUserId;
        loadedUserId = session.user.id;
        if (userChanged) loadUserLocalState();
        if (userChanged && event !== "PASSWORD_RECOVERY") setTimeout(maybeShowIntro, 0);
        if (userChanged || event !== "TOKEN_REFRESHED") setTimeout(loadData, 0);
      } else if (wasSignedIn) {
        loadedUserId = null;
        setTimeout(clearData, 0);
      }
      // Arrived via a "Forgot password?" reset link — the recovery session is
      // already active, so open the account menu's set-password form.
      if (event === "PASSWORD_RECOVERY") setTimeout(() => openAccountPanel("reset", true), 0);
    });
  }

  // Where confirmation / reset links should return: THIS deployed app URL, not
  // Supabase's Site URL (which 404s if misconfigured). Must also be in the
  // Supabase redirect allowlist or it's ignored — see README "Accounts".
  const authRedirectTo = () => window.location.origin + window.location.pathname;

  // Turn a raw Supabase auth error into plain, recoverable guidance. Returns
  // { text, resend?, switchToSignin? } — resend offers a "Resend confirmation"
  // button; switchToSignin flips the form to sign-in mode.
  function friendlyAuthError(error, ctx) {
    const raw = (error && error.message) || "Something went wrong — try again.";
    const m = raw.toLowerCase();
    if (m.includes("invalid login credentials"))
      return { text: "That email or password didn’t match. Check them, or reset your password." };
    if (m.includes("email not confirmed"))
      return { text: "Your email isn’t confirmed yet — check your inbox for the link.", resend: true };
    if (ctx === "signup" && (m.includes("already registered") || m.includes("already been registered") || m.includes("user already")))
      return { text: "You already have an account — switched you to Sign in.", switchToSignin: true };
    if (m.includes("rate limit") || m.includes("too many") || m.includes("for security purposes"))
      return { text: "Too many tries — wait a moment, then try again." };
    return { text: raw };
  }

  // Render a status message; optionally append a "Resend confirmation" button.
  function showAuthStatus(result, email) {
    authStatusEl.textContent = result.text;
    if (result.resend && email) {
      authStatusEl.appendChild(document.createTextNode(" "));
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "auth-link";
      btn.textContent = "Resend confirmation email";
      btn.addEventListener("click", () => resendConfirmation(email, btn));
      authStatusEl.appendChild(btn);
    }
    if (result.switchToSignin) setAuthMode("signin", true);
  }

  async function resendConfirmation(email, btn) {
    if (btn) btn.disabled = true;
    try {
      const { error } = await supabaseClient.auth.resend({
        type: "signup", email, options: { emailRedirectTo: authRedirectTo() }
      });
      authStatusEl.textContent = error
        ? friendlyAuthError(error).text
        : `Sent — check ${email} for the confirmation link.`;
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // --- Sign in / Create account: one form, two modes ---
  let authMode = "signin";
  const AUTH_COPY = {
    signin: { submit: "Sign in", busy: "Signing in…", sub: "Sign in to view your recipes.",
              switchLabel: "New here?", switchBtn: "Create an account", pw: "current-password" },
    signup: { submit: "Create account", busy: "Creating account…", sub: "Create an account to start your recipe book.",
              switchLabel: "Have an account?", switchBtn: "Sign in", pw: "new-password" },
  };

  function setAuthMode(mode, keepStatus) {
    authMode = mode === "signup" ? "signup" : "signin";
    const c = AUTH_COPY[authMode];
    authSubmitBtn.textContent = c.submit;
    authSubEl.textContent = c.sub;
    authSwitchLabel.textContent = c.switchLabel;
    authSwitchBtn.textContent = c.switchBtn;
    authPasswordEl.setAttribute("autocomplete", c.pw);
    authForgotBtn.hidden = authMode !== "signin";
    if (!keepStatus) authStatusEl.textContent = "";
  }

  // One auth request at a time. Pressing Enter twice (or double-tapping) would
  // otherwise fire two requests and trip Supabase's rate limit, locking the user
  // out for ~60s. The flag guards re-entry; disabling the buttons also stops an
  // Enter keypress from re-submitting the form while one is in flight.
  let authBusy = false;
  function setAuthBusy(busy) {
    authBusy = busy;
    authSubmitBtn.disabled = busy;
    authForgotBtn.disabled = busy;
    authSwitchBtn.disabled = busy;
    if (busy) authSubmitBtn.innerHTML = '<span class="spinner btn-spin"></span>' + AUTH_COPY[authMode].busy;
    else authSubmitBtn.textContent = AUTH_COPY[authMode].submit;
  }

  // Password show/hide — works for every [data-pw-toggle] field (gate + reset)
  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-pw-toggle]");
    if (!t) return;
    const input = document.getElementById(t.getAttribute("data-pw-toggle"));
    if (!input) return;
    const reveal = input.type === "password";
    input.type = reveal ? "text" : "password";
    t.setAttribute("aria-pressed", reveal ? "true" : "false");
    t.setAttribute("aria-label", reveal ? "Hide password" : "Show password");
    t.textContent = reveal ? "Hide" : "Show";
  });

  authSwitchBtn.addEventListener("click", () => {
    if (authBusy) return;
    setAuthMode(authMode === "signin" ? "signup" : "signin");
  });

  // Submit → sign in or create account depending on the current mode
  authForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (authBusy) return;
    const email = authEmailEl.value.trim();
    const password = authPasswordEl.value;
    if (!email || !password) {
      authStatusEl.textContent = "Enter an email and password first.";
      return;
    }
    if (authMode === "signup" && password.length < 8) {
      authStatusEl.textContent = "Password must be at least 8 characters.";
      return;
    }
    setAuthBusy(true);
    authStatusEl.textContent = AUTH_COPY[authMode].busy;
    try {
      if (authMode === "signup") {
        const { data, error } = await supabaseClient.auth.signUp({
          email, password, options: { emailRedirectTo: authRedirectTo() }
        });
        if (error) showAuthStatus(friendlyAuthError(error, "signup"), email);
        else if (data.session) authStatusEl.textContent = "Account created!"; // confirmation off
        else authStatusEl.textContent = `Account created — check ${email} to confirm, then sign in.`;
      } else {
        const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
        if (error) showAuthStatus(friendlyAuthError(error, "signin"), email);
        // On success, onAuthStateChange takes over (hides the gate, loads data).
      }
    } finally {
      setAuthBusy(false);
    }
  });

  // Forgot password — emails a link that returns here in recovery mode
  authForgotBtn.addEventListener("click", async () => {
    if (authBusy) return;
    const email = authEmailEl.value.trim();
    if (!email) {
      authStatusEl.textContent = "Enter your email above first, then tap this.";
      return;
    }
    setAuthBusy(true);
    authStatusEl.textContent = "Sending reset link…";
    try {
      const { error } = await supabaseClient.auth.resetPasswordForEmail(email, {
        redirectTo: authRedirectTo()
      });
      authStatusEl.textContent = error
        ? friendlyAuthError(error).text
        : `Check ${email} for a link to set a new password.`;
    } finally {
      setAuthBusy(false);
    }
  });

  // --- Account menu (signed-in) ---
  function showAccountView(view) {
    const reset = view === "reset";
    accountMenu.hidden = reset;
    accountResetForm.hidden = !reset;
    if (reset) {
      accountNewPass.value = "";
      accountNewPass2.value = "";
      accountResetStatus.textContent = "";
    }
  }
  function openAccountPanel(view, recovery) {
    accountResetIntro.textContent = recovery
      ? "Welcome back — choose a new password to finish."
      : "Choose a new password.";
    showAccountView(view || "menu");
    accountHouseholdInput.value = householdServings || "";
    renderDietPrefs();
    accountPanel.hidden = false;
  }
  accountBtn.addEventListener("click", () => openAccountPanel("menu"));
  accountHouseholdInput.addEventListener("change", () => {
    const n = parseInt(accountHouseholdInput.value, 10);
    householdServings = n > 0 ? n : null;
    accountHouseholdInput.value = householdServings || "";
    saveLocal("household", householdServings);
  });
  $("#close-account").addEventListener("click", () => (accountPanel.hidden = true));

  pickHintDismissBtn.addEventListener("click", () => {
    seenPickHint = true;
    saveLocal("seenPickHint", true);
    pickHintEl.hidden = true;
  });
  introDismissBtn.addEventListener("click", () => {
    seenIntro = true;
    saveLocal("seenIntro", true);
    introCardEl.hidden = true;
  });
  accountPanel.addEventListener("click", (e) => {
    if (e.target === accountPanel) accountPanel.hidden = true;
  });
  $("#account-change-pw").addEventListener("click", () => showAccountView("reset"));
  $("#account-reset-cancel").addEventListener("click", () => showAccountView("menu"));
  $("#account-backup").addEventListener("click", () => {
    accountPanel.hidden = true;
    openBackupPanel();
  });
  $("#account-signout").addEventListener("click", () => {
    accountPanel.hidden = true;
    supabaseClient.auth.signOut();
  });

  let acctResetBusy = false;
  accountResetForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (acctResetBusy) return;
    const pw = accountNewPass.value;
    const pw2 = accountNewPass2.value;
    if (pw.length < 8) { accountResetStatus.textContent = "Password must be at least 8 characters."; return; }
    if (pw !== pw2) { accountResetStatus.textContent = "Those two passwords don’t match."; return; }
    acctResetBusy = true;
    accountResetStatus.textContent = "Updating…";
    try {
      const { error } = await supabaseClient.auth.updateUser({ password: pw });
      if (error) {
        accountResetStatus.textContent = friendlyAuthError(error).text;
      } else {
        accountResetStatus.textContent = "Password updated.";
        setTimeout(() => { accountPanel.hidden = true; showAccountView("menu"); }, 1200);
      }
    } finally {
      acctResetBusy = false;
    }
  });

  // ---------- Dietary preferences UI (account panel) ----------
  const DIET_OPTIONS = ["vegetarian", "vegan", "pescatarian", "gluten-free", "dairy-free"];
  function renderDietPrefs() {
    dietDietsEl.innerHTML = DIET_OPTIONS.map((d) => {
      const on = dietPrefs.diets.includes(d);
      return `<button type="button" class="tag-chip diet-chip${on ? " is-on" : ""}" data-diet="${d}" aria-pressed="${on}">${d}</button>`;
    }).join("");
    const tagRow = (listName) => dietPrefs[listName].map((v) =>
      `<span class="diet-tag">${esc(v)}<button type="button" class="diet-tag-x" data-diet-remove="${listName}" data-val="${esc(v)}" aria-label="Remove ${esc(v)}">×</button></span>`
    ).join("");
    dietAllergiesEl.innerHTML = tagRow("allergies");
    dietAvoidEl.innerHTML = tagRow("avoid");
  }
  dietDietsEl.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-diet]");
    if (!btn) return;
    const d = btn.dataset.diet;
    const i = dietPrefs.diets.indexOf(d);
    if (i >= 0) dietPrefs.diets.splice(i, 1); else dietPrefs.diets.push(d);
    renderDietPrefs();
    saveDietPrefs();
  });
  function addDietTagFromInput(listName, input) {
    const val = input.value.trim().toLowerCase().replace(/,$/, "");
    input.value = "";
    if (!val || dietPrefs[listName].includes(val)) return;
    dietPrefs[listName].push(val);
    renderDietPrefs();
    saveDietPrefs();
  }
  dietAllergiesInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); addDietTagFromInput("allergies", dietAllergiesInput); }
  });
  dietAvoidInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); addDietTagFromInput("avoid", dietAvoidInput); }
  });
  [dietAllergiesEl, dietAvoidEl].forEach((el) => el.addEventListener("click", (e) => {
    const x = e.target.closest("[data-diet-remove]");
    if (!x) return;
    const listName = x.dataset.dietRemove;
    dietPrefs[listName] = dietPrefs[listName].filter((v) => v !== x.dataset.val);
    renderDietPrefs();
    saveDietPrefs();
  }));

  // ---------- Bar & pantry inventory UI ----------
  const invCap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : "");
  // Text sent to the generator for one inventory item: bar items lead with the
  // spirit TYPE (what the AI actually reasons about), keeping the brand in
  // parens when set, rather than a bare brand name it would have to reverse-map
  // ("Tanqueray" -> "gin"). Pantry items are just their name.
  function genIngredientText(item) {
    if (item.section === "bar") {
      return item.name ? `${invCap(item.category)} (${item.name})` : invCap(item.category);
    }
    return item.name || invCap(item.category);
  }
  // Label for a restocked item on the grocery list: bar items show as
  // "Category - Brand" (e.g. "Tequila - Cimmaron") so the item both reads
  // clearly AND still categorizes correctly (categorizeGrocery matches on the
  // leading spirit-type word even after normalizeItemName trims the " - …" part
  // for its own comparison purposes). Pantry items are just their name.
  function invGroceryLabel(item) {
    if (item.section === "bar") {
      return item.name ? `${invCap(item.category)} - ${item.name}` : invCap(item.category);
    }
    return item.name || invCap(item.category);
  }
  // Bar categories the user picks from (spirit types + common non-spirit bar items).
  const BAR_CATEGORIES = ["gin", "vodka", "rum", "tequila", "mezcal", "whiskey", "bourbon", "rye", "scotch", "brandy", "liqueur", "vermouth", "amaro", "bitters", "wine", "mixer", "other"];
  // Pantry inventory is for stock that keeps for a month or more — a deliberately
  // narrower list than the grocery-list aisles (GROCERY_CATEGORY_ORDER), which
  // covers everything you might buy, perishable or not. Fresh Produce/Bakery/
  // Meat & Seafood only belong here if frozen, so they're folded into "Frozen"
  // rather than offered as their own categories; Dairy & Eggs is left out
  // entirely (not even under Frozen) since this app doesn't track it as pantry stock.
  const PANTRY_CATEGORIES = ["Frozen", "Canned & Jarred", "Dry Goods & Baking", "Condiments, Sauces & Spices", "Beverages", OTHER_CATEGORY];
  const invCategoriesFor = (sec) => (sec === "bar" ? BAR_CATEGORIES : PANTRY_CATEGORIES.slice());
  const INV_STATUSES = ["in", "out"];
  const INV_STATUS_LABEL = { in: "In", out: "Out" };
  function renderInvAddForm() {
    invCategorySelect.innerHTML = invCategoriesFor(invSection)
      .map((c) => `<option value="${esc(c)}">${invSection === "bar" ? invCap(c) : esc(c)}</option>`).join("");
    invNameInput.placeholder = invSection === "bar" ? "Brand (optional)" : "Item (e.g. olive oil)";
  }
  function renderInventoryPanel() {
    invTabBar.classList.toggle("is-on", invSection === "bar");
    invTabBar.setAttribute("aria-selected", String(invSection === "bar"));
    invTabPantry.classList.toggle("is-on", invSection === "pantry");
    invTabPantry.setAttribute("aria-selected", String(invSection === "pantry"));
    // Theme the panel by sub-tab (bar = campari red, pantry = basil green) so the
    // color reflects what you're viewing, not the Kitchen/Bar tab on the main screen.
    inventoryPanel.classList.toggle("is-bar", invSection === "bar");
    inventoryPanel.classList.toggle("is-pantry", invSection === "pantry");
    renderInvAddForm();
    const items = inventory.filter((i) => i.section === invSection);
    // The bridge back to the generator: only worth showing once there's
    // something in-stock to actually cook or mix with.
    const avail = items.filter((i) => i.status !== "out");
    invGenerateBtn.hidden = avail.length === 0;
    invGenerateBtn.textContent = invSection === "bar" ? "🪄 Generate a cocktail from these" : "🪄 Generate a recipe from these";
    if (!items.length) {
      inventoryContent.innerHTML = `<p class="inv-empty">Nothing here yet — add what you have on hand above.</p>`;
      return;
    }
    const groups = {};
    items.forEach((i) => { (groups[i.category || "other"] || (groups[i.category || "other"] = [])).push(i); });
    // Alphabetical throughout: categories by their displayed heading, items
    // within a category by name (brand, or the staple name for pantry).
    const cats = Object.keys(groups).sort((a, b) =>
      (invSection === "bar" ? invCap(a) : a).localeCompare(invSection === "bar" ? invCap(b) : b)
    );
    inventoryContent.innerHTML = cats.map((cat) => {
      const rows = groups[cat].slice().sort((a, b) => (a.name || "").localeCompare(b.name || "")).map((i) => {
        const label = i.name
          ? (invSection === "bar" ? `${esc(invCap(i.category))} — ${esc(i.name)}` : esc(i.name))
          : esc(invCap(i.category));
        const statusBtns = INV_STATUSES.map((s) =>
          `<button type="button" class="inv-status-btn${i.status === s ? " is-" + s : ""}" data-inv-status="${s}" data-id="${i.id}" aria-pressed="${i.status === s}">${INV_STATUS_LABEL[s]}</button>`
        ).join("");
        const restock = i.status !== "in"
          ? `<button type="button" class="inv-restock" data-inv-restock="${i.id}" title="Add to grocery list" aria-label="Add ${esc(label)} to grocery list">🛒</button>`
          : "";
        return `<li class="inv-row">
          <span class="inv-row-name">${label}</span>
          <span class="inv-status">${statusBtns}</span>
          ${restock}
          <button type="button" class="inv-remove" data-inv-remove="${i.id}" aria-label="Remove ${esc(label)}">×</button>
        </li>`;
      }).join("");
      const heading = esc(invSection === "bar" ? invCap(cat) : cat);
      const collapsed = collapsedInvCats.has(invSection + ":" + cat);
      return `<div class="inv-group${collapsed ? " is-collapsed" : ""}">
        <button type="button" class="inv-cat" data-inv-cat="${esc(cat)}" aria-expanded="${!collapsed}">
          <span class="inv-cat-caret" aria-hidden="true">▸</span>
          <span class="inv-cat-name">${heading}</span>
          <span class="inv-cat-count">${groups[cat].length}</span>
        </button>
        <ul class="inv-list">${rows}</ul>
      </div>`;
    }).join("");
  }
  function setInvSection(sec) { invSection = sec; renderInventoryPanel(); }
  function openInventoryPanel() {
    invSection = section === "cocktails" ? "bar" : "pantry";
    renderInventoryPanel();
    inventoryPanel.hidden = false;
  }
  function restockToGrocery(id) {
    const item = inventory.find((i) => i.id === id);
    if (!item) return;
    const name = invGroceryLabel(item);
    if (!name) return;
    // Exact (case-insensitive) match, not normalizeItemName: its "drop the part
    // after ' - '" rule (meant for prep notes like "olive oil — a splash") would
    // otherwise treat "Tequila - Cimmaron" and "Tequila - Don Julio" as the same
    // item and block the second brand from ever being added.
    if (manualGroceryItems.some((m) => m.name.toLowerCase() === name.toLowerCase())) { toast("Already on your grocery list."); return; }
    manualGroceryItems.push({ key: `manual:${Date.now()}`, name });
    persistGrocery();
    renderGroceryBar();
    toast(`Added ${name} to grocery list`);
  }
  openInventoryBtn.addEventListener("click", openInventoryPanel);
  closeInventoryBtn.addEventListener("click", () => (inventoryPanel.hidden = true));
  inventoryPanel.addEventListener("click", (e) => { if (e.target === inventoryPanel) inventoryPanel.hidden = true; });
  invTabBar.addEventListener("click", () => setInvSection("bar"));
  invTabPantry.addEventListener("click", () => setInvSection("pantry"));
  invAddForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const category = invCategorySelect.value;
    const name = invNameInput.value.trim();
    if (invSection === "pantry" && !name) { toast("Type an item name."); return; }
    addInventoryItem({ section: invSection, category, name });
    invNameInput.value = "";
    invNameInput.focus();
  });
  inventoryContent.addEventListener("click", (e) => {
    const statusBtn = e.target.closest("[data-inv-status]");
    if (statusBtn) { updateInventoryStatus(statusBtn.dataset.id, statusBtn.dataset.invStatus); return; }
    const restock = e.target.closest("[data-inv-restock]");
    if (restock) { restockToGrocery(restock.dataset.invRestock); return; }
    const rm = e.target.closest("[data-inv-remove]");
    if (rm) { removeInventoryItem(rm.dataset.invRemove); return; }
    // Collapse/expand a category — toggle the class in place (no re-render, so
    // the rest of the panel's state is untouched) and remember the choice.
    const catBtn = e.target.closest("[data-inv-cat]");
    if (catBtn) {
      const key = invSection + ":" + catBtn.dataset.invCat;
      const nowCollapsed = !collapsedInvCats.has(key);
      if (nowCollapsed) collapsedInvCats.add(key); else collapsedInvCats.delete(key);
      catBtn.closest(".inv-group").classList.toggle("is-collapsed", nowCollapsed);
      catBtn.setAttribute("aria-expanded", String(!nowCollapsed));
      saveLocal("invCollapsed", [...collapsedInvCats]);
    }
  });
  // The inventory -> generator bridge: hand off whatever's in-stock on the
  // current sub-tab, forcing the generator into the matching kitchen/bar mode
  // regardless of which main Kitchen/Bar tab is currently selected. For bar,
  // your spirits ARE the cocktail's ingredients. For pantry we skip the
  // seasoning aisle — the generator assumes common seasonings, so pre-filling
  // spices as required ingredients is exactly the clutter we removed.
  invGenerateBtn.addEventListener("click", () => {
    let avail = inventory.filter((i) => i.section === invSection && i.status !== "out");
    if (invSection === "pantry") avail = avail.filter((i) => i.category !== "Condiments, Sauces & Spices");
    if (!avail.length) return;
    inventoryPanel.hidden = true;
    openGeneratePanel(invSection === "bar" ? "bar" : "kitchen");
    avail.forEach((i) => addGenIngredient(genIngredientText(i)));
  });

  setAuthMode("signin"); // default the gate to sign-in

  // ---------- Filtering ----------
  function activePool() {
    return sharedOnly ? DATA[SHARED_POOL_KEY[section]] : DATA[POOL_KEY[section]];
  }

  function currentItems() {
    const items = activePool();
    const q = searchTerm.trim().toLowerCase();
    return items.filter((it) => {
      if (!sharedOnly && favoritesOnly && !it.isFavorite) return false;
      if (activeTags.size && ![...activeTags].every((t) => it.tags.includes(t))) return false;
      if (!q) return true;
      const hay = [
        it.name, it.subtitle || "", it.source || "",
        it.tags.join(" "),
        it.ingredients.map((i) => i.item).join(" ")
      ].join(" ").toLowerCase();
      return hay.includes(q);
    });
  }

  // ---------- Rendering ----------
  function renderTagFilters() {
    const counts = {};
    activePool().forEach((it) => it.tags.forEach((t) => (counts[t] = (counts[t] || 0) + 1)));
    const tags = Object.keys(counts).sort();
    tagFiltersEl.innerHTML = tags.map((t) =>
      `<button class="tag-chip${activeTags.has(t) ? " is-on" : ""}" data-tag="${esc(t)}">${esc(t)} \u00B7 ${counts[t]}</button>`
    ).join("");
  }

  function renderActiveFilters() {
    if (!activeTags.size) { activeFiltersEl.hidden = true; return; }
    activeFiltersEl.hidden = false;
    activeFiltersEl.innerHTML =
      "Filtering: " +
      [...activeTags].map((t) => `<button class="tag-chip is-on" data-tag="${esc(t)}">${esc(t)} \u2715</button>`).join("") +
      ` <button class="ghost-btn small" id="clear-tags">Clear all</button>`;
  }

  // The chosen serving count for a recipe: the basket value if it's in the
  // grocery list, else a detail-view override, else the recipe's base. One
  // source of truth shared by the list row, the detail stepper, and grocery.
  function chosenServings(it) {
    return basket.has(it.id)
      ? basket.get(it.id).servings
      : (servingsByRecipe.get(it.id) ?? it.baseServings);
  }

  // The servings to use the *first* time a recipe lands in the grocery list or
  // meal plan: an explicit per-recipe override still wins, otherwise fall back
  // to the household default rather than always the recipe's own base. Once
  // placed, the stored value is just edited via setRecipeServings (a full
  // override) — this only shapes the initial number.
  function defaultAddServings(it) {
    return servingsByRecipe.get(it.id) ?? householdServings ?? it.baseServings;
  }

  // Set a recipe's servings from any +/- control, keeping the grocery basket in
  // sync so the combined shopping list reflects the new scale immediately.
  function setRecipeServings(id, n) {
    const v = Math.max(1, n);
    servingsByRecipe.set(id, v);
    if (basket.has(id)) basket.get(id).servings = v;
    persistGrocery();
    renderList();
    renderGroceryBar();
    if (!groceryPanel.hidden) renderGroceryPanel();
  }

  function renderList() {
    const items = currentItems();
    resultCountEl.textContent =
      `${items.length} ${section === "recipes" ? "recipe" : "cocktail"}${items.length === 1 ? "" : "s"}`;
    emptyEl.hidden = items.length > 0;
    pickHintEl.hidden = seenPickHint || items.length === 0;
    if (items.length === 0) {
      const noun = section === "recipes" ? "recipes" : "cocktails";
      const hasFilter = !!(searchTerm.trim() || activeTags.size);
      emptyEl.textContent = sharedOnly && !hasFilter
        ? "Nothing's been shared with you yet — when someone shares a recipe with you, it'll show up here."
        : favoritesOnly && !hasFilter
          ? `No favorite ${noun} yet — tap the ☆ on a recipe to star it.`
          : (hasFilter || favoritesOnly || sharedOnly)
            ? "Nothing matches that search. Clear a tag or try a different word."
            : `No ${noun} yet — tap “+ Add recipe” or “✨ Add with AI” to get started.`;
    }

    listEl.innerHTML = items.map((it) => {
      const picked = basket.has(it.id);
      const servings = chosenServings(it);
      const open = openItems.has(it.id);
      const mine = it.userId === session?.user?.id;
      return `
      <li class="item${open ? " is-open" : ""}" data-id="${esc(it.id)}">
        <div class="item-row">
          <label class="pick-wrap" title="${picked ? "On your grocery list" : "Add to grocery list"}">
            <input type="checkbox" class="pick" ${picked ? "checked" : ""}
                   aria-label="Add ${esc(it.name)} to grocery list">
            <span class="pick-ico" aria-hidden="true">🛒</span>
          </label>
          <button class="item-head" aria-expanded="${open}">
            <span class="item-name">${esc(it.name)}</span>
            ${it.subtitle ? `<span class="item-sub">${esc(it.subtitle)}</span>` : ""}
            ${!mine ? `<span class="item-owner">Shared by ${esc(profileNames[it.userId] || "someone")}</span>` : ""}
            <span class="item-tags">${it.tags.map((t) => `<span class="mini-tag">${esc(t)}</span>`).join("")}</span>
          </button>
          ${picked ? `
          <span class="serv-control" aria-label="Servings for grocery list">
            <button class="serv-btn" data-step="-1" aria-label="Decrease servings">\u2212</button>
            <span class="serv-num">${servings}</span>
            <button class="serv-btn" data-step="1" aria-label="Increase servings">+</button>
            <span class="serv-label">${esc(it.servingsLabel)}</span>
          </span>` : ""}
          ${mine ? `<button class="star-btn${it.isFavorite ? " is-on" : ""}" aria-label="${it.isFavorite ? "Remove from favorites" : "Add to favorites"}" aria-pressed="${it.isFavorite}">${it.isFavorite ? "\u2605" : "\u2606"}</button>` : ""}
          <span class="chevron" aria-hidden="true">\u25B6</span>
        </div>
        ${open ? renderDetail(it, servings) : ""}
      </li>`;
    }).join("");
  }

  function renderDetail(it, servings) {
    const ings = scaledIngredients(it, servings);
    const mine = it.userId === session?.user?.id;
    const multNote = servings !== it.baseServings
      ? `<span class="detail-serv-mult">\u00D7${fmtAmount(servings / it.baseServings)} of ${it.baseServings}</span>`
      : "";
    const servControl = `
      <div class="detail-serv" aria-label="Servings">
        <button class="detail-serv-btn" data-step="-1" aria-label="Fewer servings">\u2212</button>
        <span class="detail-serv-num">${servings} ${esc(it.servingsLabel)}</span>
        <button class="detail-serv-btn" data-step="1" aria-label="More servings">+</button>
        ${multNote}
      </div>`;
    const specRows = it.specs
      ? Object.entries(it.specs).filter(([, v]) => v)
          .map(([k, v]) => `<span><b>${esc(k[0].toUpperCase() + k.slice(1))}:</b> ${esc(v)}</span>`).join("")
      : "";
    const ownerNote = !mine ? ` \u00B7 Shared by ${esc(profileNames[it.userId] || "someone")}` : "";
    const unitToggle = `
      <div class="unit-toggle" role="group" aria-label="Measurement units">
        ${[["original", "Original"], ["us", "US"], ["metric", "Metric"]].map(([v, label]) =>
          `<button class="unit-toggle-btn${unitSystem === v ? " is-on" : ""}" data-unit="${v}" aria-pressed="${unitSystem === v}">${label}</button>`
        ).join("")}
      </div>`;
    const sourceLine = it.source || ownerNote
      ? `<p class="detail-meta">${it.source ? `Source: ${esc(it.source)}` : ""}${ownerNote}</p>`
      : "";
    return `
    <div class="item-detail">
      ${sourceLine}
      ${basket.has(it.id) ? "" : servControl}
      <div class="detail-grid">
        <div>
          <div class="detail-h-row">
            <h3 class="detail-h">Ingredients</h3>
            ${unitToggle}
          </div>
          ${groupRuns(ings).map((run) => `
            ${run.group ? `<h4 class="sub-group">${esc(run.group)}</h4>` : ""}
            <ul class="ing-list">
              ${run.items.map((ing) => {
                const l = ingLine(ing, true, unitSystem);
                return `<li><span class="ing-amt">${esc(l.amtStr)}</span><span>${esc(l.item)}</span></li>`;
              }).join("")}
            </ul>`).join("")}
          ${specRows ? `<div class="spec-table">${specRows}</div>` : ""}
        </div>
        <div>
          <h3 class="detail-h">Method</h3>
          ${groupRuns(it.method).map((run) => `
            ${run.group ? `<h4 class="sub-group">${esc(run.group)}</h4>` : ""}
            <ol class="step-list">${run.items.map((s) => `<li>${esc(s.text)}</li>`).join("")}</ol>`).join("")}
          ${it.notes ? `<p class="detail-notes">${esc(it.notes)}</p>` : ""}
        </div>
      </div>
      <div class="detail-actions-row">
        ${it.method && it.method.length ? `<button class="solid-btn small cook-btn" data-id="${esc(it.id)}">▶ Cook</button>` : ""}
        <button class="ghost-btn small add-to-plan-btn" data-id="${esc(it.id)}">📅 Add to plan</button>
        <button class="ghost-btn small detail-grocery-btn${basket.has(it.id) ? " is-on" : ""}" data-id="${esc(it.id)}">${basket.has(it.id) ? "✓ In grocery list" : "🛒 Add to grocery list"}</button>
        <button class="ghost-btn small coach-btn" data-id="${esc(it.id)}">✨ Ask AI</button>
        <button class="ghost-btn small detail-more-btn" data-id="${esc(it.id)}" aria-haspopup="true" aria-expanded="false">⋯ More</button>
      </div>
      ${mine && openShareIds.has(it.id) ? renderSharePanel(it) : ""}
    </div>`;
  }

  // ---------- Send a recipe outside the app ----------
  // One self-contained .html file in the "Features Guide" design language (the
  // same Claude Design system the in-app guide mirrors), handed to the native
  // share sheet so the user can text or email it. No backend, no library.
  const GUIDE_FONTS = "https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600;9..144,700&family=Public+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap";
  const APP_URL = "https://strockerik.github.io/Strock-Recipes/";

  function recipeFilename(it) {
    const slug = String(it.name).toLowerCase()
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "recipe";
    return slug + ".html";
  }

  function recipeShareHtml(it, servings, system) {
    const accent = it.section === "bar" ? "#B5402A" : "#3E6B3A";
    const kicker = it.section === "bar" ? "Bar" : "Kitchen";

    const ingHtml = groupRuns(scaledIngredients(it, servings)).map((run) => {
      const items = run.items.map((ing) => {
        const l = ingLine(ing, true, system);
        const amt = l.amtStr && l.amtStr !== "—" ? `<b>${esc(l.amtStr)}</b> ` : "";
        return `<li>${amt}${esc(l.item)}</li>`;
      }).join("");
      return `${run.group ? `<h3 class="grp">${esc(run.group)}</h3>` : ""}<ul class="pts">${items}</ul>`;
    }).join("");

    const specHtml = it.specs
      ? Object.entries(it.specs).filter(([, v]) => v)
          .map(([k, v]) => `<li><b>${esc(k[0].toUpperCase() + k.slice(1))}:</b> ${esc(v)}</li>`).join("")
      : "";

    const hasMethod = it.method && it.method.length;
    const methodHtml = hasMethod ? groupRuns(it.method).map((run) => {
      const steps = run.items.map((s) => `<li>${esc(s.text)}</li>`).join("");
      return `${run.group ? `<h3 class="grp">${esc(run.group)}</h3>` : ""}<ol class="steps">${steps}</ol>`;
    }).join("") : "";

    const tags = (Array.isArray(it.tags) ? it.tags : []).filter(Boolean);
    const tagHtml = tags.length
      ? `<p class="tags">${tags.map((t) => `<span>${esc(t)}</span>`).join("")}</p>` : "";
    const subLine = [it.source ? `Source: ${it.source}` : "", `${servings} ${it.servingsLabel}`]
      .filter(Boolean).join("  ·  ");

    return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(it.name)} — The House Index</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="${GUIDE_FONTS}" rel="stylesheet">
<style>
  :root { --paper:#FCFBF8; --ink:#2A2520; --lede:#463f37; --faint:#8A8276; --line:#E8E3D9; --accent:${accent}; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--paper); color:var(--ink);
         font-family:"Public Sans",-apple-system,system-ui,sans-serif; }
  .doc { max-width:40em; margin:0 auto; padding:40px clamp(20px,5vw,40px) 64px; }
  .kicker { font-family:"IBM Plex Mono",ui-monospace,monospace; font-size:11px; font-weight:500;
            letter-spacing:.14em; text-transform:uppercase; color:var(--accent);
            margin:0 0 10px; display:flex; align-items:center; gap:10px; }
  .kicker::before { content:""; width:22px; height:2px; background:var(--accent); display:inline-block; }
  h1 { font-family:"Fraunces",Georgia,serif; font-weight:700; font-size:34px; line-height:1.05;
       letter-spacing:-.015em; margin:0 0 12px; text-wrap:balance; }
  .lede { font-size:17px; line-height:1.55; color:var(--lede); margin:0 0 8px; }
  .sub { font-family:"IBM Plex Mono",ui-monospace,monospace; font-size:12px; color:var(--faint); margin:0; }
  .hero { border-bottom:1px solid var(--line); padding-bottom:24px; margin-bottom:28px; }
  h2 { font-family:"Fraunces",Georgia,serif; font-weight:600; font-size:22px; margin:30px 0 12px; }
  h3.grp { font-family:"Fraunces",Georgia,serif; font-weight:600; font-size:16px; margin:18px 0 8px; color:var(--lede); }
  .pts { list-style:none; margin:0; padding:0; }
  .pts li { position:relative; padding-left:20px; font-size:15px; line-height:1.5; margin-bottom:8px; color:var(--lede); }
  .pts li::before { content:""; position:absolute; left:0; top:8px; width:7px; height:7px; border-radius:50%; background:var(--accent); }
  .pts li b { font-weight:600; color:var(--ink); }
  .steps { counter-reset:step; list-style:none; margin:0; padding:0; }
  .steps li { position:relative; padding-left:34px; margin-bottom:12px; font-size:15px; line-height:1.55; min-height:24px; }
  .steps li::before { counter-increment:step; content:counter(step); position:absolute; left:0; top:0;
       width:23px; height:23px; border-radius:50%; background:var(--accent); color:#fff;
       font-family:"IBM Plex Mono",ui-monospace,monospace; font-size:12px;
       display:flex; align-items:center; justify-content:center; }
  .notes { font-size:14.5px; line-height:1.6; color:var(--lede); background:#fff;
           border:1px solid var(--line); border-radius:12px; padding:14px 16px; margin:18px 0 0; }
  .tags { display:flex; flex-wrap:wrap; gap:6px; margin:18px 0 0; padding:0; }
  .tags span { font-family:"IBM Plex Mono",ui-monospace,monospace; font-size:11px; color:var(--faint);
               border:1px solid var(--line); border-radius:999px; padding:3px 10px; }
  .closer { border-top:1px solid var(--line); margin-top:34px; padding-top:18px;
            font-family:"IBM Plex Mono",ui-monospace,monospace; font-size:11px; color:var(--faint); }
  .closer a { color:var(--accent); text-decoration:none; }
  @media print { @page { margin:1.4cm; } body { background:#fff; } .closer a { color:var(--ink); } }
</style>
</head><body>
<main class="doc">
  <section class="hero">
    <p class="kicker">${kicker}</p>
    <h1>${esc(it.name)}</h1>
    ${it.subtitle ? `<p class="lede">${esc(it.subtitle)}</p>` : ""}
    <p class="sub">${esc(subLine)}</p>
  </section>
  <h2>Ingredients</h2>
  ${ingHtml}
  ${specHtml ? `<ul class="pts">${specHtml}</ul>` : ""}
  ${hasMethod ? `<h2>Method</h2>${methodHtml}` : ""}
  ${it.notes ? `<p class="notes">${esc(it.notes)}</p>` : ""}
  ${tagHtml}
  <p class="closer">Made with <a href="${APP_URL}">The House Index</a></p>
</main>
</body></html>`;
  }

  // Plain-text fallback for share targets that can't take a file attachment.
  function recipeShareText(it, servings, system) {
    const lines = [it.name];
    if (it.subtitle) lines.push(it.subtitle);
    const meta = [it.source ? `Source: ${it.source}` : "", `${servings} ${it.servingsLabel}`]
      .filter(Boolean).join("  ·  ");
    if (meta) lines.push(meta);
    lines.push("", "INGREDIENTS");
    groupRuns(scaledIngredients(it, servings)).forEach((run) => {
      if (run.group) lines.push(`[${run.group}]`);
      run.items.forEach((ing) => {
        const l = ingLine(ing, true, system);
        lines.push(`- ${l.amtStr && l.amtStr !== "—" ? l.amtStr + " " : ""}${l.item}`);
      });
    });
    if (it.method && it.method.length) {
      lines.push("", "METHOD");
      groupRuns(it.method).forEach((run) => {
        let n = 0;
        if (run.group) lines.push(`[${run.group}]`);
        run.items.forEach((s) => { n++; lines.push(`${n}. ${s.text}`); });
      });
    }
    if (it.notes) lines.push("", `Notes: ${it.notes}`);
    lines.push("", `Made with The House Index — ${APP_URL}`);
    return lines.join("\n");
  }

  async function shareRecipeFile(it) {
    const servings = chosenServings(it);
    const html = recipeShareHtml(it, servings, unitSystem);
    const name = recipeFilename(it);
    // Prefer sharing the actual .html file so it lands as a saveable attachment.
    if (navigator.canShare) {
      try {
        const file = new File([html], name, { type: "text/html" });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: it.name });
          return;
        }
      } catch { /* fall through to text / download */ }
    }
    if (navigator.share) {
      try { await navigator.share({ title: it.name, text: recipeShareText(it, servings, unitSystem) }); return; }
      catch { /* user cancelled or unsupported — fall through */ }
    }
    // Last resort (desktop): download the file so it can be attached manually.
    try {
      const blob = new Blob([html], { type: "text/html" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      URL.revokeObjectURL(a.href);
      toast("Saved the recipe file — attach it to a text or email");
    } catch {
      toast("Sharing isn’t available on this device");
    }
  }

  // Recipients a recipe is currently shared with, by user id.
  function shareRecipients(it) {
    return sharesByRecipe[it.id] || [];
  }

  function shareButtonLabel(it) {
    const n = shareRecipients(it).length;
    return n ? `Shared with ${n} ${n === 1 ? "person" : "people"}` : "Share";
  }

  function renderSharePanel(it) {
    const recipients = shareRecipients(it);
    return `
    <div class="share-panel">
      ${recipients.length ? `
      <div class="share-recipients">
        ${recipients.map((uid) => `
          <span class="share-chip">${esc(profileNames[uid] || "that user")}<button type="button" class="share-remove-btn" data-id="${esc(it.id)}" data-user-id="${esc(uid)}" aria-label="Stop sharing with ${esc(profileNames[uid] || "that user")}">×</button></span>
        `).join("")}
      </div>` : `<p class="share-empty">Not shared with anyone yet.</p>`}
      <form class="share-add-row" data-id="${esc(it.id)}">
        <input type="email" class="share-email-input" placeholder="Their email address" required>
        <button type="submit" class="solid-btn small share-add-btn">Share</button>
      </form>
      <p class="share-status" aria-live="polite"></p>
    </div>`;
  }

  // ---------- Grocery list ----------
  function renderGroceryBar() {
    // The list has content when recipes are checked OR when manual/inventory items
    // have been added, so the bar shows (and the panel stays open) for either.
    const recipes = basket.size;
    const total = recipes + manualGroceryItems.length;
    groceryBar.hidden = total === 0;
    if (total === 0) closeGroceryPanel();
    grocerySummary.textContent = recipes > 0
      ? `${recipes} recipe${recipes === 1 ? "" : "s"} in your grocery list`
      : `${manualGroceryItems.length} item${manualGroceryItems.length === 1 ? "" : "s"} in your grocery list`;
  }

  function groceryGroups() {
    return [...basket.entries()]
      .filter(([id]) => byId[id])
      .map(([id, { servings }]) => {
        const it = byId[id];
        return {
          name: it.name,
          servings,
          label: it.servingsLabel,
          lines: scaledIngredients(it, servings).map((ing) => ingLine(ing, true))
        };
      });
  }

  // Merge ingredients across every recipe in the basket into one shopping
  // list: matching item + unit gets summed, units are converted to what a US
  // grocery store sells, and pantry staples can be hidden.
  function combinedGroceryItems() {
    const map = new Map();
    for (const [id, { servings }] of basket) {
      const it = byId[id];
      if (!it) continue;
      scaledIngredients(it, servings).forEach((ing) => {
        if (!ing.item) return;
        const nameKey = normalizeItemName(ing.item);
        if (skipPantryStaples && isPantryStaple(nameKey)) return;
        const { amount, family, unit } = canonicalQuantity(ing.scaled, ing.unit);
        const key = `${nameKey}__${family || unit || ""}`;
        const existing = map.get(key);
        if (existing) {
          if (amount != null) existing.amount = (existing.amount || 0) + amount;
        } else {
          map.set(key, { key, item: displayGroceryName(ing.item), family, unit, amount });
        }
      });
    }
    return [...map.values()]
      .map((entry) => {
        const { amount, unit } = shoppableQuantity(entry.amount, entry.family, entry.unit);
        return { key: entry.key, item: entry.item, amount, unit };
      })
      .sort((a, b) => a.item.localeCompare(b.item));
  }

  // Manual (non-recipe) items, shaped to slot into the same category buckets
  // and checked-off tracking as recipe-derived items.
  function manualAsGroceryItems() {
    return manualGroceryItems.map((m) => ({ key: m.key, item: m.name, amount: null, unit: null, manual: true }));
  }
  function allGroceryItems() {
    return [...combinedGroceryItems(), ...manualAsGroceryItems()];
  }

  // "Other" is always pinned last and isn't part of the reorderable list.
  function renderAisleReorder() {
    const order = (aisleOrder || GROCERY_CATEGORY_ORDER).filter((c) => c !== OTHER_CATEGORY);
    return `<details class="g-reorder">
      <summary>Reorder aisles</summary>
      <ul class="g-reorder-list">
        ${order.map((cat, i) => `
          <li class="g-reorder-row">
            <span>${esc(cat)}</span>
            <span class="g-reorder-btns">
              <button type="button" class="g-reorder-up" data-cat="${esc(cat)}" ${i === 0 ? "disabled" : ""} aria-label="Move ${esc(cat)} up">▲</button>
              <button type="button" class="g-reorder-down" data-cat="${esc(cat)}" ${i === order.length - 1 ? "disabled" : ""} aria-label="Move ${esc(cat)} down">▼</button>
            </span>
          </li>`).join("")}
      </ul>
    </details>`;
  }

  function renderGroceryPanel() {
    const sections = groceryByCategory(allGroceryItems());
    const itemsHtml = sections.length
      ? sections.map((sec) => `
          <li class="g-category">${esc(sec.category)}</li>
          ${sec.items.map((it) => {
            const checked = checkedGroceryItems.has(it.key);
            const amtStr = it.amount == null ? "" : fmtAmount(it.amount) + (it.unit ? " " + it.unit : "");
            return `<li class="${checked ? "is-checked" : ""}">
              <label class="g-item">
                <input type="checkbox" class="g-item-check" data-key="${esc(it.key)}" ${checked ? "checked" : ""}>
                <span class="ing-amt">${esc(amtStr)}</span><span>${esc(it.item)}</span>
              </label>
              ${it.manual ? `<button type="button" class="g-manual-remove" data-key="${esc(it.key)}" aria-label="Remove ${esc(it.item)}">\u00d7</button>` : ""}
            </li>`;
          }).join("")}`).join("")
      : `<p class="g-empty">Nothing to buy \u2014 try turning off "Skip pantry staples".</p>`;

    groceryContent.innerHTML = `
      <form id="grocery-add-manual" class="g-add-manual">
        <input type="text" id="grocery-manual-input" placeholder="Add an item\u2026" autocomplete="off">
        <button type="submit" class="ghost-btn small">Add</button>
      </form>
      <label class="g-staples-toggle">
        <input type="checkbox" id="grocery-skip-staples" ${skipPantryStaples ? "checked" : ""}>
        Skip pantry staples (salt, pepper, oil, water, sugar, butter, flour)
      </label>
      <ul class="g-combined">${itemsHtml}</ul>
      ${renderAisleReorder()}
      <details class="g-by-recipe">
        <summary>By recipe</summary>
        ${groceryGroups().map((g) => `
          <div class="g-recipe">
            <p class="g-recipe-name">${esc(g.name)}</p>
            <p class="g-recipe-serv">${g.servings} ${esc(g.label)}</p>
            <ul class="g-items">
              ${g.lines.map((l) => `<li><span class="ing-amt">${esc(l.amtStr)}</span><span>${esc(displayGroceryName(l.item))}</span></li>`).join("")}
            </ul>
          </div>`).join("")}
      </details>`;
    renderGroceryProgress();
  }

  function renderGroceryProgress() {
    const items = allGroceryItems();
    const total = items.length;
    const done = items.filter((it) => checkedGroceryItems.has(it.key)).length;
    groceryProgressEl.hidden = !shoppingModeOn || !total;
    groceryProgressEl.textContent = `✓ ${done} of ${total}`;
  }

  function setShoppingMode(on) {
    shoppingModeOn = on;
    groceryPanel.classList.toggle("shopping", on);
    shoppingModeToggle.setAttribute("aria-pressed", String(on));
    shoppingModeToggle.textContent = on ? "✓ Shopping mode" : "🛒 Shopping mode";
    renderGroceryProgress();
    if (on) requestWakeLock(); else releaseWakeLock();
  }
  function closeGroceryPanel() {
    groceryPanel.hidden = true;
    if (shoppingModeOn) setShoppingMode(false);
  }

  // Plain text only \u2014 Keep doesn't parse any incoming syntax into real
  // checkboxes or bold, so a leading \u2610/\u2611 glyph here just renders as an
  // inert square once shared. Real checkboxes come from Keep's own
  // \u22ee > Convert to checklist afterward (a note-wide toggle with no way to
  // exempt specific lines), so headers are dash-wrapped to still read as
  // section labels rather than tasks once every line gets a checkbox.
  // Already-checked-off items are left out entirely \u2014 a shopping list of
  // just what's still needed.
  function groceryText() {
    const date = new Date().toLocaleDateString();
    let out = `Grocery list \u2014 ${date}\n\n`;
    const remaining = allGroceryItems().filter((it) => !checkedGroceryItems.has(it.key));
    groceryByCategory(remaining).forEach((sec) => {
      out += `\u2014 ${sec.category.toUpperCase()} \u2014\n`;
      sec.items.forEach((it) => {
        const amtStr = it.amount == null ? "" : fmtAmount(it.amount) + (it.unit ? " " + it.unit : "") + " ";
        out += `- ${amtStr}${it.item}\n`;
      });
      out += `\n`;
    });
    out += `Recipes:\n`;
    groceryGroups().forEach((g) => {
      out += `\u2022 ${g.name} (${g.servings} ${g.label})\n`;
    });
    return out;
  }

  // ---------- Weekly meal planning ----------
  // Local-date helpers (avoid toISOString's UTC shift so "today" is the user's).
  function isoDate(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  function midnight() { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function dayLabel(d) {
    return {
      wd: d.toLocaleDateString(undefined, { weekday: "short" }),
      md: d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
    };
  }
  const SLOTS = ["breakfast", "lunch", "dinner"];
  const slotLabel = (s) => s[0].toUpperCase() + s.slice(1);

  // Load the rolling window of plan entries (past 7 days \u2026 next 7 days). Fails
  // open to an empty plan if the table doesn't exist yet (migration not run).
  async function loadMealPlan() {
    if (!session) { mealPlan = []; return; }
    const { data, error } = await supabaseClient
      .from("meal_plan_entries")
      .select("*")
      .gte("plan_date", isoDate(addDays(midnight(), -7)))
      .lte("plan_date", isoDate(addDays(midnight(), 6)))
      .order("plan_date");
    if (error) { mealPlan = []; return; }
    mealPlan = (data || []).map((r) => ({
      id: r.id, recipeId: r.recipe_id, date: r.plan_date,
      slot: r.slot, servings: r.servings, purchasedAt: r.purchased_at
    }));
  }

  function addToMealPlanTray(id) {
    mealPlanTray.add(id);
    saveLocal("mealTray", [...mealPlanTray]);
    toast("Added to meal plan");
  }
  function removeFromTray(id) {
    mealPlanTray.delete(id);
    saveLocal("mealTray", [...mealPlanTray]);
    renderMealPlan();
  }

  async function assignMealEntry(recipeId, date, slot) {
    if (!session) { toast("You've been signed out \u2014 sign in again."); return; }
    const it = byId[recipeId];
    const servings = it ? defaultAddServings(it) : null;
    const { data, error } = await supabaseClient
      .from("meal_plan_entries")
      .insert({ recipe_id: recipeId, plan_date: date, slot, servings })
      .select()
      .single();
    if (error) { toast(`Couldn't add to plan: ${error.message}`); return; }
    mealPlan.push({ id: data.id, recipeId, date, slot, servings, purchasedAt: null });
    renderMealPlan();
  }

  async function removeMealEntry(entryId) {
    const { error } = await supabaseClient.from("meal_plan_entries").delete().eq("id", entryId);
    if (error) { toast(`Couldn't remove: ${error.message}`); return; }
    mealPlan = mealPlan.filter((e) => e.id !== entryId);
    renderMealPlan();
  }

  // ---------- Add-to-plan picker sheet ----------
  // Replaces the old "arm a tray recipe, then tap a slot" two-step mode with a
  // single tap-to-open sheet, in either direction: pick a recipe first (from
  // the tray) and choose its day/slot, or pick a day/slot first (the "+" on
  // the grid) and choose which tray recipe goes there.
  function parseIsoDate(ds) {
    const [y, m, d] = ds.split("-").map(Number);
    return new Date(y, m - 1, d);
  }
  function openPlaceSheetForRecipe(recipeId) {
    if (!byId[recipeId]) return;
    placeSheetState = { mode: "slot", recipeId };
    renderPlaceSheet();
    placeSheet.hidden = false;
  }
  function openPlaceSheetForSlot(date, slot) {
    if (!mealPlanTray.size) { toast("Add a recipe to the tray first, then tap a slot."); return; }
    placeSheetState = { mode: "recipe", date, slot };
    renderPlaceSheet();
    placeSheet.hidden = false;
  }
  function closePlaceSheet() {
    placeSheet.hidden = true;
    placeSheetState = null;
  }
  function renderPlaceSheet() {
    if (!placeSheetState) return;
    if (placeSheetState.mode === "slot") {
      const it = byId[placeSheetState.recipeId];
      placeSheetTitle.textContent = `Add "${it.name}" to…`;
      placeSheetBody.innerHTML = [0, 1, 2, 3, 4, 5, 6].map((i) => {
        const d = addDays(midnight(), i);
        const ds = isoDate(d);
        const { wd, md } = dayLabel(d);
        return `<div class="ps-day">
          <p class="ps-day-label">${esc(wd)} ${esc(md)}</p>
          <div class="ps-slots">
            ${SLOTS.map((slot) => `<button class="ps-slot-btn" data-date="${ds}" data-slot="${slot}">${slotLabel(slot)}</button>`).join("")}
          </div>
        </div>`;
      }).join("");
    } else {
      const { wd, md } = dayLabel(parseIsoDate(placeSheetState.date));
      placeSheetTitle.textContent = `Add to ${slotLabel(placeSheetState.slot)}, ${wd} ${md}`;
      const recipeBtns = [...mealPlanTray].map((id) => {
        const it = byId[id];
        return it ? `<button class="ps-recipe-btn" data-recipe="${esc(id)}">${esc(it.name)}</button>` : "";
      }).filter(Boolean).join("");
      placeSheetBody.innerHTML = `<div class="ps-recipes">${recipeBtns}</div>`;
    }
  }
  placeSheet.addEventListener("click", (e) => {
    if (e.target === placeSheet) { closePlaceSheet(); return; }
    const slotBtn = e.target.closest(".ps-slot-btn");
    if (slotBtn) {
      assignMealEntry(placeSheetState.recipeId, slotBtn.dataset.date, slotBtn.dataset.slot);
      closePlaceSheet();
      return;
    }
    const recipeBtn = e.target.closest(".ps-recipe-btn");
    if (recipeBtn) {
      assignMealEntry(recipeBtn.dataset.recipe, placeSheetState.date, placeSheetState.slot);
      closePlaceSheet();
    }
  });
  $("#place-sheet-close").addEventListener("click", closePlaceSheet);

  // Build a grocery list from the upcoming planned week: sum each recipe's
  // servings across the days it appears, load that into the basket, and reuse
  // the whole grocery engine. Mark those entries purchased.
  async function groceryFromPlan() {
    const start = isoDate(midnight());
    const end = isoDate(addDays(midnight(), 6));
    const upcoming = mealPlan.filter((e) => e.date >= start && e.date <= end);
    if (!upcoming.length) { toast("No upcoming meals planned yet."); return; }
    const totals = new Map();
    upcoming.forEach((e) => {
      const it = byId[e.recipeId];
      if (!it) return;
      const s = e.servings ?? it.baseServings;
      totals.set(e.recipeId, (totals.get(e.recipeId) || 0) + s);
    });
    if (!totals.size) { toast("Those planned recipes aren't available."); return; }
    basket.clear();
    checkedGroceryItems.clear();
    totals.forEach((s, id) => basket.set(id, { servings: s }));
    const now = new Date().toISOString();
    const ids = upcoming.map((e) => e.id);
    await supabaseClient.from("meal_plan_entries").update({ purchased_at: now }).in("id", ids);
    upcoming.forEach((e) => { e.purchasedAt = now; });
    setViewMode("recipes");
    renderList();
    renderGroceryBar();
    renderGroceryPanel();
    groceryPanel.hidden = false;
  }

  function mealDayCard(d, isHistory) {
    const ds = isoDate(d);
    const { wd, md } = dayLabel(d);
    const dayPurchased = isHistory && mealPlan.some((e) => e.date === ds && e.purchasedAt);
    const slotsHtml = SLOTS.map((slot) => {
      const entries = mealPlan.filter((e) => e.date === ds && e.slot === slot);
      // In "dinners" planner view, breakfast/lunch are hidden entirely (not
      // collapsed to a stub row, which saved no space and just read as clutter).
      // A breakfast/lunch that already has a meal still shows, so switching to
      // "dinners" never orphans something you scheduled in "all meals". To add a
      // breakfast or lunch, switch to "All meals".
      if (!isHistory && planView === "dinners" && slot !== "dinner" && !entries.length) {
        return "";
      }
      const chips = entries.map((e) => {
        const it = byId[e.recipeId];
        const name = it ? esc(it.name) : "(recipe unavailable)";
        return isHistory
          ? `<button class="mp-chip mp-chip-hist" data-cook="${esc(e.recipeId)}" data-serv="${e.servings ?? ""}"${it ? "" : " disabled"}>${name}</button>`
          : `<span class="mp-chip">${name}<button class="mp-chip-x" data-entry="${esc(e.id)}" aria-label="Remove">\u00d7</button></span>`;
      }).join("");
      const add = isHistory ? "" : `<button class="mp-slot-add" data-date="${ds}" data-slot="${slot}" aria-label="Add to ${slot}">+</button>`;
      return `<div class="mp-slot">
        <span class="mp-slot-label">${slotLabel(slot)}</span>
        <div class="mp-slot-items">${chips}${add}</div>
      </div>`;
    }).join("");
    return `<div class="mp-day">
      <div class="mp-day-head"><span class="mp-day-wd">${wd}</span> <span class="mp-day-md">${md}</span>${dayPurchased ? `<span class="mp-purchased">\u2713 purchased</span>` : ""}</div>
      ${slotsHtml}
    </div>`;
  }

  function renderMealPlan() {
    const trayIds = [...mealPlanTray];
    const tray = trayIds.length
      ? trayIds.map((id) => {
          const it = byId[id];
          if (!it) return "";
          return `<span class="mp-tray-item">
            <button class="mp-tray-chip" data-tray="${esc(id)}">${esc(it.name)}</button>
            <button class="mp-tray-x" data-tray-remove="${esc(id)}" aria-label="Remove from tray">\u00d7</button>
          </span>`;
        }).join("")
      : `<p class="mp-empty">Open a recipe and tap <b>\ud83d\udcc5 Add to plan</b> to stage it here, then tap it and a day below to schedule it.</p>`;

    const upcoming = [0, 1, 2, 3, 4, 5, 6].map((i) => mealDayCard(addDays(midnight(), i), false)).join("");
    const history = [1, 2, 3, 4, 5, 6, 7].map((i) => mealDayCard(addDays(midnight(), -i), true)).join("");

    const todayStr = isoDate(midnight());
    const endStr = isoDate(addDays(midnight(), 6));
    const upcomingCount = mealPlan.filter((e) => e.date >= todayStr && e.date <= endStr).length;

    mealPlanView.innerHTML = `
      <section class="mp-section">
        <h3 class="detail-h">Recipes to plan</h3>
        <div class="mp-tray">${tray}</div>
      </section>
      <section class="mp-section">
        <div class="mp-section-head">
          <h3 class="detail-h">Upcoming 7 days</h3>
          <button id="mp-make-grocery" class="solid-btn small"${upcomingCount ? "" : " disabled"}>\ud83d\uded2 Create grocery list</button>
        </div>
        <div class="mp-view-toggle" role="group" aria-label="Planner view">
          <button type="button" class="mp-view-btn${planView === "dinners" ? " is-active" : ""}" data-plan-view="dinners">Dinners</button>
          <button type="button" class="mp-view-btn${planView === "all" ? " is-active" : ""}" data-plan-view="all">All meals</button>
        </div>
        ${upcoming}
      </section>
      <section class="mp-section">
        <h3 class="detail-h">History \u2014 last 7 days</h3>
        ${history}
      </section>`;

    // Update the tab badge with the count of upcoming planned meals
    updateMealplanBadge(upcomingCount);
  }

  function updateMealplanBadge(n) {
    const b = $("#mealplan-count");
    b.textContent = n;
    b.hidden = !n;
  }

  function setViewMode(mode) {
    viewMode = mode;
    const recipes = mode === "recipes";
    modeRecipesBtn.classList.toggle("is-active", recipes);
    modeMealplanBtn.classList.toggle("is-active", !recipes);
    modeRecipesBtn.setAttribute("aria-selected", String(recipes));
    modeMealplanBtn.setAttribute("aria-selected", String(!recipes));
    recipesControlsEl.hidden = !recipes;
    listEl.hidden = !recipes;
    resultRowEl.hidden = !recipes;
    if (!recipes) pickHintEl.hidden = true;
    else pickHintEl.hidden = seenPickHint || currentItems().length === 0;
    mealPlanView.hidden = recipes;
    if (!recipes) {
      if (!session) { toast("Sign in to plan meals."); setViewMode("recipes"); return; }
      loadMealPlan().then(() => renderMealPlan());
    }
  }

  function syncScope() {
    const all = !favoritesOnly && !sharedOnly;
    scopeAllBtn.classList.toggle("is-on", all);
    toggleFavoritesBtn.classList.toggle("is-on", favoritesOnly);
    toggleSharedBtn.classList.toggle("is-on", sharedOnly);
    scopeAllBtn.setAttribute("aria-selected", String(all));
  }

  function toast(msg) {
    let t = document.querySelector(".toast");
    if (!t) {
      t = document.createElement("div");
      t.className = "toast";
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove("show"), 2200);
  }

  // ---------- Recipe form (add / edit / delete) ----------
  function ingredientRow(ing) {
    const amount = ing && ing.amount != null ? ing.amount : "";
    const unit = ing && ing.unit != null ? ing.unit : "";
    const item = ing ? ing.item : "";
    // The ▲▼ control only shows in reorder mode (CSS-gated, like the step rows);
    // the save read-back ignores everything but the three inputs, so it's inert.
    return `
      <div class="rf-ing-row">
        <input type="number" step="any" class="rf-ing-amount" placeholder="amt" value="${esc(amount)}">
        <input type="text" class="rf-ing-unit" placeholder="unit" value="${esc(unit)}">
        <input type="text" class="rf-ing-item" placeholder="ingredient" value="${esc(item)}" required>
        <div class="rf-ing-move">
          <button type="button" class="rf-move-up" aria-label="Move ingredient up">▲</button>
          <button type="button" class="rf-move-down" aria-label="Move ingredient down">▼</button>
        </div>
        <button type="button" class="rf-row-remove" aria-label="Remove ingredient">×</button>
      </div>`;
  }

  function stepRow(text) {
    // The ▲▼ control is only visible in reorder mode (CSS hides it otherwise),
    // and the save read-back ignores everything but .rf-step-text, so it's inert.
    return `
      <div class="rf-step-row">
        <textarea class="rf-step-text" rows="2" placeholder="Step…">${esc(text || "")}</textarea>
        <div class="rf-step-move">
          <button type="button" class="rf-move-up" aria-label="Move step up">▲</button>
          <button type="button" class="rf-move-down" aria-label="Move step down">▼</button>
        </div>
        <button type="button" class="rf-row-remove" aria-label="Remove step">×</button>
      </div>`;
  }

  // A section divider in the form: every ingredient/step row below it belongs to
  // this section until the next divider. Leaving the field blank = ungrouped.
  // In reorder mode the ↑↓ buttons are shown (CSS-controlled) to move the whole section.
  function sectionHeadingRow(label) {
    return `
      <div class="rf-section-row">
        <input type="text" class="rf-section-input" placeholder="Section (e.g. Dough)" value="${esc(label || "")}">
        <div class="rf-section-move">
          <button type="button" class="rf-section-up" aria-label="Move section up">↑</button>
          <button type="button" class="rf-section-down" aria-label="Move section down">↓</button>
        </div>
        <button type="button" class="rf-row-remove" aria-label="Remove section">×</button>
      </div>`;
  }

  // Build the form rows for a list of grouped ingredients/steps: emit a section
  // divider before each non-null group, then that group's item rows.
  function buildRows(items, rowFn) {
    return groupRuns(items)
      .map((run) => (run.group ? sectionHeadingRow(run.group) : "") + run.items.map(rowFn).join(""))
      .join("");
  }

  // Show the kitchen (cuisine/protein/dish) or bar (spirit/style) tag groups
  // depending on the currently-selected section radio.
  function updateTagGroupsVisibility() {
    const isBar = recipeForm.querySelector('input[name="rf-section"]:checked').value === "bar";
    rfTagsKitchen.hidden = isBar;
    rfTagsBar.hidden = !isBar;
  }

  // Check the tag-picker boxes matching the given tags (case-insensitive);
  // tags not in our taxonomy are silently ignored.
  function setCheckedTags(tags) {
    const set = new Set((tags || []).map((t) => String(t).trim().toLowerCase()));
    recipeForm.querySelectorAll('input[name="rf-tag"]').forEach((cb) => {
      cb.checked = set.has(cb.value);
    });
  }

  // Only the visible (kitchen or bar) group's checked boxes count — the
  // hidden group may retain stale checks from before a section switch.
  function checkedTags() {
    const group = rfTagsBar.hidden ? rfTagsKitchen : rfTagsBar;
    return [...group.querySelectorAll('input[name="rf-tag"]:checked')].map((cb) => cb.value);
  }

  recipeForm.querySelectorAll('input[name="rf-section"]').forEach((radio) => {
    radio.addEventListener("change", updateTagGroupsVisibility);
  });

  function openRecipeForm(item) {
    recipeFormStatus.textContent = "";
    if (item) {
      recipeFormTitle.textContent = "Edit recipe";
      rfId.value = item.id;
      rfName.value = item.name;
      rfSubtitle.value = item.subtitle || "";
      rfSource.value = item.source || "";
      rfServings.value = item.baseServings;
      rfServingsLabel.value = item.servingsLabel || "";
      setCheckedTags(item.tags);
      rfNotes.value = item.notes || "";
      const radio = recipeForm.querySelector(`input[name="rf-section"][value="${item.section}"]`);
      if (radio) radio.checked = true;
      rfIngredients.innerHTML = buildRows(item.ingredients, ingredientRow);
      rfMethod.innerHTML = buildRows(item.method, (s) => stepRow(s.text));
      deleteRecipeBtn.hidden = false;
    } else {
      recipeFormTitle.textContent = "Add recipe";
      recipeForm.reset();
      rfId.value = "";
      const radio = recipeForm.querySelector(
        `input[name="rf-section"][value="${section === "recipes" ? "kitchen" : "bar"}"]`
      );
      if (radio) radio.checked = true;
      rfIngredients.innerHTML = ingredientRow(null);
      rfMethod.innerHTML = stepRow("");
      deleteRecipeBtn.hidden = true;
    }
    // The form DOM persists between opens — make sure reorder mode starts off.
    rfMethod.classList.remove("reordering");
    rfReorderStepsBtn.setAttribute("aria-pressed", "false");
    rfReorderStepsBtn.textContent = "↕ Reorder";
    rfIngredients.classList.remove("reordering");
    rfReorderIngredientsBtn.setAttribute("aria-pressed", "false");
    rfReorderIngredientsBtn.textContent = "↕ Reorder";
    // Clear any prior generator inventory-check so it never lingers on a
    // hand-added or edited recipe (only the generator re-populates it).
    rfInventoryCheck.hidden = true;
    rfInventoryCheck.innerHTML = "";
    updateTagGroupsVisibility();
    recipeFormPanel.hidden = false;
  }

  // After the generator fills the form, compare the recipe's ingredients against
  // the user's in-stock inventory and show a quiet "have / need" line. Only runs
  // when inventory exists; basic staples (salt/pepper/oil…) are assumed on hand
  // and never listed on either side, so the "need" list stays signal, not noise.
  function renderInventoryCheck(recipe) {
    rfInventoryCheck.hidden = true;
    rfInventoryCheck.innerHTML = "";
    if (!inventory.length) return;
    // Bar rows match on their spirit TYPE (category); pantry rows on their name.
    const stockKeys = inventory
      .filter((i) => i.status === "in")
      .map((i) => normalizeItemName(i.section === "bar" ? i.category : (i.name || i.category)))
      .filter(Boolean);
    const have = [], need = [];
    (recipe.ingredients || []).forEach((ing) => {
      const raw = flattenText(ing && ing.item != null ? ing.item : ing);
      const norm = normalizeItemName(raw);
      if (!norm || isPantryStaple(norm)) return; // assumed on hand — skip both lists
      const matched = stockKeys.some((k) => k === norm || norm.includes(k) || k.includes(norm));
      (matched ? have : need).push(displayGroceryName(raw));
    });
    if (!have.length && !need.length) return;
    const line = (icon, label, items) =>
      items.length ? `<span class="rf-inv-part"><b>${icon} ${label}:</b> ${esc(items.join(", "))}</span>` : "";
    rfInventoryCheck.innerHTML =
      `<p class="rf-inv-lead">Checked against your inventory:</p>` +
      line("✓", "You have", have) + line("🛒", "You'll need", need);
    rfInventoryCheck.hidden = false;
  }

  function closeRecipeForm() {
    recipeFormPanel.hidden = true;
  }

  // The model occasionally double-nests a step, e.g. {text: {text: "...", group: null}, group: null}
  // instead of {text: "...", group: null}. Drill into `.text` until we hit a
  // string, so a stray nested object can't end up stringified as "[object Object]".
  function flattenText(value, depth) {
    if (typeof value === "string") return value;
    if (value && typeof value === "object" && (depth || 0) < 5) return flattenText(value.text, (depth || 0) + 1);
    return "";
  }

  // Only accept a real string group label — guards against the same
  // double-nesting putting an object where a label belongs.
  function extractedGroup(value) {
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  // Coerce a model-extracted amount to a number or null
  // ("1/2" → 0.5, "1 1/2" → 1.5, "2" → 2).
  function extractedAmount(value) {
    if (typeof value === "number" && isFinite(value)) return value;
    if (typeof value === "string") {
      const frac = value.trim().match(/^(?:(\d+)\s+)?(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)$/);
      if (frac && Number(frac[3]) !== 0) {
        return Number(frac[1] || 0) + Number(frac[2]) / Number(frac[3]);
      }
      const n = parseFloat(value);
      if (isFinite(n)) return n;
    }
    return null;
  }

  // Populate the (already-open, blank) add-recipe form with AI-extracted fields.
  // The model's tool output *usually* matches the schema, but the API doesn't
  // enforce it — tags have arrived as one comma-joined string, which used to
  // throw mid-fill and leave ingredients/method blank. Normalize every field so
  // one odd value can't abort the rest.
  function fillRecipeFormFromExtraction(recipe) {
    rfName.value = recipe.name || "";
    rfSubtitle.value = recipe.subtitle || "";
    rfSource.value = recipe.source || "";
    rfServings.value = Math.max(1, Math.round(extractedAmount(recipe.base_servings) || 4));
    rfServingsLabel.value = recipe.servings_label || "servings";
    const tags = Array.isArray(recipe.tags) ? recipe.tags
      : typeof recipe.tags === "string" ? recipe.tags.split(",") : [];
    setCheckedTags(tags);
    rfNotes.value = recipe.notes || "";
    const targetSection = recipe.section === "bar" ? "bar" : "kitchen";
    const radio = recipeForm.querySelector(`input[name="rf-section"][value="${targetSection}"]`);
    if (radio) radio.checked = true;
    updateTagGroupsVisibility();
    const ingredients = (Array.isArray(recipe.ingredients) ? recipe.ingredients : [])
      .map((ing) => typeof ing === "string"
        ? { amount: null, unit: null, item: ing.trim(), group: null }
        : { amount: extractedAmount(ing?.amount), unit: ing?.unit || null, item: flattenText(ing?.item).trim(), group: extractedGroup(ing?.group) })
      .filter((ing) => ing.item);
    rfIngredients.innerHTML = ingredients.length ? buildRows(ingredients, ingredientRow) : ingredientRow(null);
    const method = (Array.isArray(recipe.method) ? recipe.method
      : typeof recipe.method === "string" ? recipe.method.split(/\n+/) : [])
      .map((s) => typeof s === "string"
        ? { text: s.trim(), group: null }
        : { text: flattenText(s?.text).trim(), group: extractedGroup(s?.group) })
      .filter((s) => s.text);
    rfMethod.innerHTML = method.length ? buildRows(method, (s) => stepRow(s.text)) : stepRow("");
  }

  rfAddIngredientBtn.addEventListener("click", () => {
    rfIngredients.insertAdjacentHTML("beforeend", ingredientRow(null));
  });
  rfAddStepBtn.addEventListener("click", () => {
    rfMethod.insertAdjacentHTML("beforeend", stepRow(""));
  });
  $("#rf-add-ingredient-section").addEventListener("click", () => {
    rfIngredients.insertAdjacentHTML("beforeend", sectionHeadingRow(""));
  });
  $("#rf-add-step-section").addEventListener("click", () => {
    rfMethod.insertAdjacentHTML("beforeend", sectionHeadingRow(""));
  });
  // Nudge a single form row (ingredient, step, or section divider) up or down
  // one position within its container. A section divider slides through the
  // rows like any other row — so moving a divider leaves the ingredients/steps
  // in place and just re-groups the one it passes (the save handler derives
  // each row's group from its position relative to the dividers). This is what
  // "move the section, keep the ingredients still" means.
  function nudgeRow(rowEl, dir) {
    const c = rowEl.parentElement;
    if (dir < 0) {
      if (rowEl.previousElementSibling) c.insertBefore(rowEl, rowEl.previousElementSibling);
    } else if (rowEl.nextElementSibling) {
      c.insertBefore(rowEl.nextElementSibling, rowEl);
    }
  }

  // One delegated reorder handler shape, shared by ingredients and method:
  // ✕ removes a row; section ↑↓ and per-row ▲▼ both nudge one position.
  function bindReorderHandler(container, rowSelector) {
    container.addEventListener("click", (e) => {
      if (e.target.classList.contains("rf-row-remove")) {
        e.target.closest(`${rowSelector}, .rf-section-row`).remove();
        return;
      }
      const secMove = e.target.closest(".rf-section-up, .rf-section-down");
      if (secMove) {
        nudgeRow(secMove.closest(".rf-section-row"), secMove.classList.contains("rf-section-up") ? -1 : 1);
        return;
      }
      const rowMove = e.target.closest(".rf-move-up, .rf-move-down");
      if (rowMove) {
        nudgeRow(rowMove.closest(rowSelector), rowMove.classList.contains("rf-move-up") ? -1 : 1);
      }
    });
  }
  bindReorderHandler(rfIngredients, ".rf-ing-row");
  bindReorderHandler(rfMethod, ".rf-step-row");
  rfReorderStepsBtn.addEventListener("click", () => {
    const on = rfMethod.classList.toggle("reordering");
    rfReorderStepsBtn.setAttribute("aria-pressed", String(on));
    rfReorderStepsBtn.textContent = on ? "✓ Done" : "↕ Reorder";
  });
  rfReorderIngredientsBtn.addEventListener("click", () => {
    const on = rfIngredients.classList.toggle("reordering");
    rfReorderIngredientsBtn.setAttribute("aria-pressed", String(on));
    rfReorderIngredientsBtn.textContent = on ? "✓ Done" : "↕ Reorder";
  });

  addRecipeBtn.addEventListener("click", () => openRecipeForm(null));
  closeRecipeFormBtn.addEventListener("click", closeRecipeForm);
  recipeFormPanel.addEventListener("click", (e) => {
    if (e.target === recipeFormPanel) closeRecipeForm();
  });

  recipeForm.addEventListener("submit", async (e) => {
    e.preventDefault();

    // A PWA left in the background for days can lose its session.
    if (!session) {
      recipeFormStatus.textContent = "You’ve been signed out — sign in again, your edits are still here.";
      return;
    }

    // Walk rows top-to-bottom; a section divider sets the group for every
    // ingredient/step row beneath it until the next divider.
    const ingredients = [];
    let ingGroup = null;
    [...rfIngredients.children].forEach((row) => {
      if (row.classList.contains("rf-section-row")) {
        ingGroup = row.querySelector(".rf-section-input").value.trim() || null;
      } else if (row.classList.contains("rf-ing-row")) {
        const amount = row.querySelector(".rf-ing-amount").value;
        const unit = row.querySelector(".rf-ing-unit").value.trim();
        const itemName = row.querySelector(".rf-ing-item").value.trim();
        if (itemName) ingredients.push({ amount: amount === "" ? null : Number(amount), unit: unit || null, item: itemName, group: ingGroup });
      }
    });

    const method = [];
    let stepGroup = null;
    [...rfMethod.children].forEach((row) => {
      if (row.classList.contains("rf-section-row")) {
        stepGroup = row.querySelector(".rf-section-input").value.trim() || null;
      } else if (row.classList.contains("rf-step-row")) {
        const text = row.querySelector(".rf-step-text").value.trim();
        if (text) method.push({ text, group: stepGroup });
      }
    });

    const id = rfId.value;
    const existing = id ? byId[id] : null;

    const name = rfName.value.trim();
    // Only warn about a clash with one of YOUR OWN recipes — byId also holds
    // recipes others have shared with you, and a name match there isn't a
    // duplicate in your book (copyToMyBook filters the same way).
    const myId = session.user.id;
    const dupe = Object.values(byId).find(
      (it) => it.userId === myId && it.id !== id && it.name.trim().toLowerCase() === name.toLowerCase()
    );
    if (dupe && !confirm(`A recipe named "${dupe.name}" already exists. Save this one too?`)) {
      return;
    }

    const row = {
      user_id: session.user.id,
      section: recipeForm.querySelector('input[name="rf-section"]:checked').value,
      name,
      subtitle: rfSubtitle.value.trim() || null,
      source: rfSource.value.trim() || null,
      tags: checkedTags(),
      base_servings: Number(rfServings.value),
      servings_label: rfServingsLabel.value.trim() || "servings",
      ingredients,
      method,
      specs: existing ? existing.specs : null,
      notes: rfNotes.value.trim() || null
    };

    recipeFormStatus.textContent = "Saving…";
    const { error } = id
      ? await supabaseClient.from("recipes").update(row).eq("id", id)
      : await supabaseClient.from("recipes").insert(row);

    if (error) {
      recipeFormStatus.textContent = `Error: ${error.message}`;
      return;
    }

    closeRecipeForm();
    toast(id ? "Recipe updated" : "Recipe added");
    await loadData();
  });

  async function toggleFavorite(item) {
    const next = !item.isFavorite;
    item.isFavorite = next; // optimistic
    renderList();
    const { error } = await supabaseClient.from("recipes").update({ is_favorite: next }).eq("id", item.id);
    if (error) {
      item.isFavorite = !next;
      renderList();
      toast(`Error: ${error.message}`);
    }
  }

  // Share `item` with the account registered to `email`. Status messages
  // (not-found, already-shared, etc.) are written into the panel's own
  // `.share-status` line rather than a toast, so they don't get lost.
  async function shareRecipe(item, email, formEl) {
    if (!session) { toast("You've been signed out — sign in again."); return; }
    const statusEl = formEl.parentElement.querySelector(".share-status");
    const trimmed = email.trim();
    if (!trimmed) return;

    const { data: foundId, error: lookupError } = await supabaseClient
      .rpc("lookup_user_id_by_email", { lookup_email: trimmed });
    if (lookupError) { statusEl.textContent = `Error: ${lookupError.message}`; return; }
    if (!foundId) { statusEl.textContent = "No account found with that email."; return; }
    if (foundId === session.user.id) { statusEl.textContent = "That's your own account."; return; }
    if ((sharesByRecipe[item.id] || []).includes(foundId)) { statusEl.textContent = "Already shared with them."; return; }

    const { error } = await supabaseClient.from("recipe_shares").insert({
      recipe_id: item.id,
      shared_with_user_id: foundId,
      shared_by_user_id: session.user.id
    });
    if (error) { statusEl.textContent = `Error: ${error.message}`; return; }

    (sharesByRecipe[item.id] || (sharesByRecipe[item.id] = [])).push(foundId);
    if (!profileNames[foundId]) await loadProfiles(); // pick up the new recipient's display name
    renderList();
  }

  async function unshareRecipe(item, userId) {
    if (!session) { toast("You've been signed out — sign in again."); return; }
    const { error } = await supabaseClient.from("recipe_shares")
      .delete()
      .eq("recipe_id", item.id)
      .eq("shared_with_user_id", userId);
    if (error) { toast(`Error: ${error.message}`); return; }
    sharesByRecipe[item.id] = (sharesByRecipe[item.id] || []).filter((id) => id !== userId);
    renderList();
  }

  // A recipient dismissing a recipe shared with them: delete the share row that
  // points at them. Doesn't touch the owner's recipe (RLS only lets you delete
  // a share where shared_with_user_id = you).
  async function removeSharedWithMe(item) {
    if (!session) { toast("You've been signed out — sign in again."); return; }
    if (!confirm(`Remove “${item.name}” from your shared recipes? This only removes it from your list — the owner keeps their copy.`)) return;
    const { error } = await supabaseClient.from("recipe_shares")
      .delete()
      .eq("recipe_id", item.id)
      .eq("shared_with_user_id", session.user.id);
    if (error) { toast(`Couldn’t remove: ${error.message}`); return; }
    openItems.delete(item.id);
    await loadData();
    toast("Removed from your shared recipes.");
  }

  // The portable, re-importable shape of one recipe: the `recipes` columns
  // minus the environment-specific `id`/`user_id`. Single source of truth shared
  // by copyToMyBook (clone within the app), the JSON export, and the backup
  // script — change a column in one place and all three stay in sync.
  function toBackupRow(it) {
    return {
      section: it.section,
      name: it.name,
      subtitle: it.subtitle,
      source: it.source,
      tags: it.tags,
      base_servings: it.baseServings,
      servings_label: it.servingsLabel,
      ingredients: it.ingredients,
      method: it.method,
      specs: it.specs,
      notes: it.notes,
      is_favorite: it.isFavorite
    };
  }

  // Serialize ALL of the signed-in user's own recipes (kitchen + bar) to a
  // versioned JSON envelope. DATA.recipes/cocktails are already owner-only, so
  // recipes others shared with me are correctly left out of my backup.
  function exportRecipesJSON() {
    return JSON.stringify({
      app: "The House Index",
      version: 1,
      exportedAt: new Date().toISOString(),
      account: session?.user?.email || null,
      recipes: [...DATA.recipes, ...DATA.cocktails].map(toBackupRow)
    }, null, 2);
  }

  async function copyToMyBook(item) {
    if (!session) { toast("You've been signed out — sign in again."); return; }
    const name = item.name;
    const dupe = Object.values(byId).find(
      (it) => it.userId === session.user.id && it.name.trim().toLowerCase() === name.trim().toLowerCase()
    );
    if (dupe && !confirm(`A recipe named "${dupe.name}" already exists in your book. Copy this one too?`)) return;

    // A copy is a fresh, unfavorited recipe owned by me.
    const row = { ...toBackupRow(item), user_id: session.user.id, is_favorite: false };
    const { error } = await supabaseClient.from("recipes").insert(row);
    if (error) { toast(`Error: ${error.message}`); return; }
    toast("Copied to your book");
    await loadData();
  }

  async function deleteRecipe(item) {
    if (!confirm(`Delete "${item.name}"? This can't be undone.`)) return;
    const { error } = await supabaseClient.from("recipes").delete().eq("id", item.id);
    if (error) {
      toast(`Error: ${error.message}`);
      return;
    }
    openItems.delete(item.id);
    basket.delete(item.id);
    toast("Recipe deleted");
    await loadData();
  }

  // ---------- AI recipe import ----------
  const MAX_AI_PHOTOS = 4; // front/back of a card, or a few pages — one recipe either way

  // Photos staged for the current extraction: multiple pages or sides of ONE
  // recipe, sent together so the AI can combine them into a single result.
  let aiPhotoQueue = []; // [{ mediaType, data }]

  function renderAiPhotoQueue() {
    const n = aiPhotoQueue.length;
    aiPhotoThumbs.innerHTML = aiPhotoQueue.map((p, i) => `
      <div class="ai-photo-thumb">
        <img src="data:${p.mediaType};base64,${p.data}" alt="Photo ${i + 1}">
        <button type="button" class="ai-photo-remove" data-index="${i}" aria-label="Remove photo ${i + 1}">×</button>
      </div>`).join("");
    aiPhotoArea.hidden = n === 0;
    aiPhotoLabel.hidden = n > 0;
    aiPhotoAddBtn.hidden = n >= MAX_AI_PHOTOS;
    aiPhotoExtractBtn.textContent = n > 1 ? `Extract recipe (${n} photos)` : "Extract recipe";
  }

  function openAiImport() {
    aiImportStatus.textContent = "";
    aiTextInput.value = "";
    aiTextArea.hidden = true;
    aiLinkInput.value = "";
    aiLinkArea.hidden = true;
    aiPhotoInput.value = "";
    aiPhotoQueue = [];
    renderAiPhotoQueue();
    aiImportPicker.hidden = false;
    aiImportLoading.hidden = true;
    aiImportPanel.hidden = false;
  }

  // Increments on every new extraction AND on cancel/close, so a slow response
  // from an abandoned request can never populate the form later.
  let extractionToken = 0;

  function closeAiImport() {
    extractionToken++;
    aiPhotoQueue = [];
    aiImportPanel.hidden = true;
  }

  const MAX_IMAGE_DIM = 1600; // Claude caps vision input near 1568px; no point sending more.

  // Downscale and re-encode as JPEG. This shrinks multi-MB phone photos before
  // upload and converts iPhone HEIC images (which Claude's vision API rejects)
  // into a supported format. Returns base64 (no data: prefix).
  function processImage(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        const scale = Math.min(1, MAX_IMAGE_DIM / Math.max(img.width, img.height));
        const width = Math.round(img.width * scale);
        const height = Math.round(img.height * scale);
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        // Higher quality (0.92) preserves fine pen strokes on handwritten cards;
        // the size cost is small and recipe cards are the priority use case.
        const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
        resolve(dataUrl.slice(dataUrl.indexOf(",") + 1));
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("Couldn’t read that image."));
      };
      img.src = url;
    });
  }

  const EXTRACTION_TIMEOUT_MS = 75_000;
  const EXTRACTION_TIMEOUT = Symbol("extraction-timeout");

  async function runExtraction(payload) {
    const token = ++extractionToken;
    aiImportPicker.hidden = true;
    aiImportLoading.hidden = false;
    aiImportStatus.textContent = "";

    // Catch errors here (rather than at the await below) so a slow response that
    // arrives after the timeout below doesn't produce an unhandled rejection.
    const invokePromise = supabaseClient.functions.invoke("extract-recipe", {
      body: payload
    }).catch((error) => ({ error }));
    const timeoutPromise = new Promise((resolve) =>
      setTimeout(() => resolve(EXTRACTION_TIMEOUT), EXTRACTION_TIMEOUT_MS)
    );

    const result = await Promise.race([invokePromise, timeoutPromise]);

    // Stale response: the user cancelled, closed the panel, or started a newer
    // extraction while this one was in flight.
    if (token !== extractionToken || aiImportPanel.hidden) return;

    if (result === EXTRACTION_TIMEOUT) {
      aiImportPicker.hidden = false;
      aiImportLoading.hidden = true;
      aiImportStatus.textContent = "That's taking too long — check your connection and try again.";
      return;
    }

    const { data, error } = result;

    if (error || data?.error) {
      aiImportPicker.hidden = false;
      aiImportLoading.hidden = true;
      aiImportStatus.textContent = `Error: ${data?.error || error.message}`;
      // A link that can't be read (bot-walled site, video with no recipe) should
      // route straight to the path that always works — pasting the text.
      if (payload.type === "url") {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "ghost-btn small ai-paste-fallback";
        btn.textContent = "📋 Paste text instead";
        btn.addEventListener("click", () => aiPasteTextBtn.click());
        aiImportStatus.appendChild(document.createElement("br"));
        aiImportStatus.appendChild(btn);
      }
      return;
    }

    closeAiImport();
    openRecipeForm(null);
    fillRecipeFormFromExtraction(data.recipe);
    recipeFormStatus.textContent = "AI extracted this recipe — please review before saving.";
  }

  addRecipeAiBtn.addEventListener("click", openAiImport);
  closeAiImportBtn.addEventListener("click", closeAiImport);
  aiImportCancelBtn.addEventListener("click", closeAiImport);
  aiImportPanel.addEventListener("click", (e) => {
    if (e.target === aiImportPanel) closeAiImport();
  });

  aiPasteTextBtn.addEventListener("click", () => {
    aiTextArea.hidden = false;
    aiLinkArea.hidden = true;
    aiTextInput.focus();
  });

  aiTextSubmitBtn.addEventListener("click", () => {
    const text = aiTextInput.value.trim();
    if (!text) return;
    runExtraction({ type: "text", text });
  });

  aiLinkBtn.addEventListener("click", () => {
    aiLinkArea.hidden = false;
    aiTextArea.hidden = true;
    aiLinkInput.focus();
  });

  aiLinkSubmitBtn.addEventListener("click", () => {
    let url = aiLinkInput.value.trim();
    if (!url) return;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `https://${url}`; // pasted without scheme
    runExtraction({ type: "url", url });
  });

  aiLinkInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      aiLinkSubmitBtn.click();
    }
  });

  aiPhotoInput.addEventListener("change", async () => {
    const file = aiPhotoInput.files?.[0];
    aiPhotoInput.value = ""; // reset so picking the same file again re-fires change
    if (!file || aiPhotoQueue.length >= MAX_AI_PHOTOS) return;
    let data;
    try {
      data = await processImage(file);
    } catch {
      aiImportStatus.textContent = "Couldn’t read that image — try another photo.";
      return;
    }
    aiPhotoQueue.push({ mediaType: "image/jpeg", data });
    aiImportStatus.textContent = "";
    renderAiPhotoQueue();
  });

  aiPhotoAddBtn.addEventListener("click", () => aiPhotoInput.click());

  aiPhotoExtractBtn.addEventListener("click", () => {
    if (!aiPhotoQueue.length) return;
    runExtraction({ type: "image", images: aiPhotoQueue.slice() });
  });

  aiPhotoThumbs.addEventListener("click", (e) => {
    const btn = e.target.closest(".ai-photo-remove");
    if (!btn) return;
    aiPhotoQueue.splice(Number(btn.dataset.index), 1);
    renderAiPhotoQueue();
  });

  // ---------- AI recipe generator ----------
  // One-shot: ingredients (+ optional quick-picks) → one recipe, funneled through
  // the same fillRecipeFormFromExtraction path as AI import and the coach.
  // Whether the AI can lean on a couple of items you don't have yet — the single
  // biggest lever on whether a recipe stays 100% pantry or nudges toward a
  // grocery run. Left unset, the model still defaults to a conservative couple
  // of adds (see the Edge Function prompt).
  const GEN_GROCERY = [{ v: "none", label: "Use what I have" }, { v: "quick", label: "OK for a quick grocery run" }];
  const GEN_TIME = [{ v: "quick", label: "Quick (~30 min)" }, { v: "involved", label: "Worth the effort" }];
  const GEN_SERVINGS = [2, 4, 6];
  const GEN_CUISINE = ["any", "italian", "mexican", "american", "asian", "mediterranean", "french"];
  const GEN_STYLE_BAR = ["any", "classic", "sour", "highball", "tiki", "stirred"];
  const GEN_EQUIP_KITCHEN = ["any", "stovetop", "oven", "sheet pan", "slow cooker", "air fryer", "no-cook"];
  const GEN_EQUIP_BAR = ["any", "shaken", "stirred", "built", "blended"];
  let genState = { ingredients: [], groceryRun: null, time: null, servings: null, cuisine: null, equipment: null };
  let genConcepts = [];       // the 3 ideas from step 1, awaiting a pick
  let genLastPayload = null;  // inputs captured at step 1, reused for step 2
  let generationToken = 0;    // ++ on close and on each new call — abandons stale responses
  const GENERATION_TIMEOUT_MS = 75_000;
  const GENERATION_TIMEOUT = Symbol("generation-timeout");
  // Normally the generator follows the main Kitchen/Bar tab, but it can be
  // opened forced into one mode (e.g. from the inventory panel's "Generate from
  // these" button on the Bar sub-tab) without touching the main tab underneath.
  let genForcedSection = null; // "bar" | "kitchen" | null
  const genIsBar = () => (genForcedSection ? genForcedSection === "bar" : section === "cocktails");

  function renderGenChips() {
    genIngChips.innerHTML = genState.ingredients.map((ing, i) =>
      `<span class="gen-chip">${esc(ing)}<button type="button" class="gen-chip-x" data-gen-ing="${i}" aria-label="Remove ${esc(ing)}">×</button></span>`
    ).join("");
  }
  function renderGenOptions() {
    const bar = genIsBar();
    genCuisineLabel.textContent = bar ? "Style" : "Cuisine";
    const single = (key, opts, valueOf, labelOf) => {
      const row = generatePanel.querySelector(`[data-gen-single="${key}"]`);
      row.innerHTML = opts.map((o) => {
        const v = valueOf(o), lbl = labelOf(o);
        const on = String(genState[key]) === String(v);
        return `<button type="button" class="tag-chip gen-optchip${on ? " is-on" : ""}" data-gen-opt="${key}" data-val="${esc(String(v))}" aria-pressed="${on}">${esc(lbl)}</button>`;
      }).join("");
    };
    single("groceryRun", GEN_GROCERY, (o) => o.v, (o) => o.label);
    single("time", GEN_TIME, (o) => o.v, (o) => o.label);
    single("servings", GEN_SERVINGS, (o) => o, (o) => String(o));
    single("cuisine", bar ? GEN_STYLE_BAR : GEN_CUISINE, (o) => o, (o) => invCap(o));
    single("equipment", bar ? GEN_EQUIP_BAR : GEN_EQUIP_KITCHEN, (o) => o, (o) => invCap(o));
  }
  // The generate panel has three swappable views: the input form, the concept
  // picker, and the loading spinner. Exactly one shows at a time.
  function showGenView(view) {
    generateForm.hidden = view !== "form";
    generateConcepts.hidden = view !== "concepts";
    generateLoading.hidden = view !== "loading";
  }
  function openGeneratePanel(forceSection) {
    genForcedSection = forceSection || null;
    genState = { ingredients: [], groceryRun: null, time: null, servings: null, cuisine: null, equipment: null };
    genConcepts = [];
    genLastPayload = null;
    genIngInput.value = "";
    generateStatus.textContent = "";
    const bar = genIsBar();
    genHintEl.textContent = bar
      ? "List the spirits and mixers you've got and AI will suggest a few cocktails to pick from."
      : "List your main ingredients and AI will suggest a few recipes to pick from. It assumes you have common seasonings.";
    genIngInput.placeholder = bar ? "Type an ingredient (e.g. gin, lime, mint)" : "Type a main ingredient (e.g. chicken thighs)";
    renderGenDietLine();
    renderGenChips();
    renderGenOptions();
    showGenView("form");
    generatePanel.hidden = false;
  }
  // Dietary preferences are applied silently, but a first-time user has no way
  // to know that — surface a quiet line naming what's honored, or a link to set
  // them up if nothing's been chosen yet. Shared by the generator and the
  // describe-a-recipe panels; the Edit link carries data-diet-edit so either
  // container's click handler can route to the account panel.
  function dietLineHTML() {
    const parts = [
      ...dietPrefs.diets,
      ...dietPrefs.allergies.map((a) => `no ${a}`),
      ...dietPrefs.avoid.map((a) => `avoiding ${a}`)
    ];
    return parts.length
      ? `Honoring your preferences (${esc(parts.join(", "))}) · <button type="button" data-diet-edit class="link-inline">Edit</button>`
      : `<button type="button" data-diet-edit class="link-inline">Set dietary preferences</button>`;
  }
  function renderGenDietLine() { genDietLineEl.innerHTML = dietLineHTML(); }
  genDietLineEl.addEventListener("click", (e) => {
    if (!e.target.closest("[data-diet-edit]")) return;
    closeGeneratePanel();
    openAccountPanel("menu");
  });
  function closeGeneratePanel() {
    generationToken++; // abandon any in-flight generation
    generatePanel.hidden = true;
  }
  function addGenIngredient(raw) {
    const val = String(raw).trim().replace(/,$/, "");
    if (!val) return;
    const norm = val.toLowerCase();
    if (!genState.ingredients.some((x) => x.toLowerCase() === norm)) genState.ingredients.push(val);
    genIngInput.value = "";
    renderGenChips();
  }
  // Assemble the generator inputs — shared by the concepts step and the full step.
  function buildGenPayload() {
    return {
      ingredients: genState.ingredients.slice(),
      section: genIsBar() ? "bar" : "kitchen",
      chips: {
        groceryRun: genState.groceryRun || undefined,
        time: genState.time || undefined,
        servings: genState.servings ? Number(genState.servings) : undefined,
        cuisine: genState.cuisine && genState.cuisine !== "any" ? genState.cuisine : undefined,
        equipment: genState.equipment && genState.equipment !== "any" ? genState.equipment : undefined
      },
      dietPrefs
    };
  }
  function genInvoke(body) {
    const invokePromise = supabaseClient.functions.invoke("generate-recipe", { body }).catch((error) => ({ error }));
    const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve(GENERATION_TIMEOUT), GENERATION_TIMEOUT_MS));
    return Promise.race([invokePromise, timeoutPromise]);
  }
  function genFail(msg, backView) { showGenView(backView); generateStatus.textContent = msg; }

  // Step 1: ask for 3 concepts.
  async function runConcepts() {
    if (!genState.ingredients.length) { generateStatus.textContent = "Add at least one ingredient first."; return; }
    genLastPayload = buildGenPayload();
    const token = ++generationToken;
    generateStatus.textContent = "";
    generateLoadingMsg.textContent = "Finding a few ideas…";
    showGenView("loading");
    const result = await genInvoke({ ...genLastPayload, mode: "concepts" });
    if (token !== generationToken || generatePanel.hidden) return; // stale / cancelled
    if (result === GENERATION_TIMEOUT) return genFail("That's taking too long — check your connection and try again.", "form");
    const { data, error } = result;
    if (error || data?.error) return genFail(`Error: ${data?.error || error.message}`, "form");
    genConcepts = Array.isArray(data.concepts) ? data.concepts : [];
    if (!genConcepts.length) return genFail("Couldn't come up with ideas — try different ingredients.", "form");
    renderConcepts();
    showGenView("concepts");
  }
  function renderConcepts() {
    genConceptList.innerHTML = genConcepts.map((c, i) =>
      `<button type="button" class="gen-concept" data-concept="${i}">
        <span class="gen-concept-title">${esc(c.title)}</span>
        <span class="gen-concept-blurb">${esc(c.blurb)}</span>
      </button>`
    ).join("");
  }
  // Step 2: develop the picked concept into a full recipe.
  async function pickConcept(i) {
    const concept = genConcepts[i];
    if (!concept || !genLastPayload) return;
    const token = ++generationToken;
    generateStatus.textContent = "";
    generateLoadingMsg.textContent = "Writing your recipe…";
    showGenView("loading");
    const result = await genInvoke({ ...genLastPayload, mode: "full", concept });
    if (token !== generationToken || generatePanel.hidden) return; // stale / cancelled
    if (result === GENERATION_TIMEOUT) return genFail("That's taking too long — check your connection and try again.", "concepts");
    const { data, error } = result;
    if (error || data?.error) return genFail(`Error: ${data?.error || error.message}`, "concepts");
    closeGeneratePanel();
    openRecipeForm(null);
    fillRecipeFormFromExtraction(data.recipe);
    recipeFormStatus.textContent = "AI generated this recipe — please review before saving.";
    renderInventoryCheck(data.recipe);
  }

  addRecipeGenerateBtn.addEventListener("click", () => openGeneratePanel());
  closeGenerateBtn.addEventListener("click", closeGeneratePanel);
  generateCancelBtn.addEventListener("click", closeGeneratePanel);
  genSubmitBtn.addEventListener("click", runConcepts);
  genConceptsBackBtn.addEventListener("click", () => { generateStatus.textContent = ""; showGenView("form"); });
  genConceptsRerollBtn.addEventListener("click", runConcepts);
  genConceptList.addEventListener("click", (e) => {
    const card = e.target.closest("[data-concept]");
    if (card) pickConcept(Number(card.dataset.concept));
  });
  genIngInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); addGenIngredient(genIngInput.value); genIngInput.focus(); }
  });
  genIngAddBtn.addEventListener("click", () => { addGenIngredient(genIngInput.value); genIngInput.focus(); });
  genIngChips.addEventListener("click", (e) => {
    const x = e.target.closest("[data-gen-ing]");
    if (!x) return;
    genState.ingredients.splice(Number(x.dataset.genIng), 1);
    renderGenChips();
  });
  generatePanel.addEventListener("click", (e) => {
    if (e.target === generatePanel) { closeGeneratePanel(); return; }
    const opt = e.target.closest("[data-gen-opt]");
    if (!opt) return;
    const key = opt.dataset.genOpt;
    genState[key] = String(genState[key]) === opt.dataset.val ? null : opt.dataset.val;
    renderGenOptions();
  });

  // ---------- Describe a recipe (free-text request -> one classic recipe) ----------
  let promptToken = 0; // ++ on close and on each call, abandons a stale response
  function openPromptPanel() {
    promptInput.value = "";
    promptStatus.textContent = "";
    promptDietLine.innerHTML = dietLineHTML();
    promptForm.hidden = false;
    promptLoading.hidden = true;
    promptPanel.hidden = false;
    promptInput.focus();
  }
  function closePromptPanel() {
    promptToken++;
    promptPanel.hidden = true;
  }
  async function runPromptRecipe() {
    const prompt = promptInput.value.trim();
    if (!prompt) { promptStatus.textContent = "Describe the recipe you'd like first."; return; }
    const token = ++promptToken;
    promptStatus.textContent = "";
    promptForm.hidden = true;
    promptLoading.hidden = false;
    const invokePromise = supabaseClient.functions.invoke("generate-recipe", {
      body: { mode: "prompt", prompt, dietPrefs }
    }).catch((error) => ({ error }));
    const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve(GENERATION_TIMEOUT), GENERATION_TIMEOUT_MS));
    const result = await Promise.race([invokePromise, timeoutPromise]);
    if (token !== promptToken || promptPanel.hidden) return; // stale / cancelled
    const fail = (msg) => { promptForm.hidden = false; promptLoading.hidden = true; promptStatus.textContent = msg; };
    if (result === GENERATION_TIMEOUT) return fail("That's taking too long — check your connection and try again.");
    const { data, error } = result;
    if (error || data?.error) return fail(`Error: ${data?.error || error.message}`);
    closePromptPanel();
    openRecipeForm(null);
    fillRecipeFormFromExtraction(data.recipe);
    recipeFormStatus.textContent = "AI wrote this recipe — please review before saving.";
    renderInventoryCheck(data.recipe);
  }
  addRecipePromptBtn.addEventListener("click", openPromptPanel);
  closePromptBtn.addEventListener("click", closePromptPanel);
  promptCancelBtn.addEventListener("click", closePromptPanel);
  promptSubmitBtn.addEventListener("click", runPromptRecipe);
  promptInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); runPromptRecipe(); }
  });
  promptPanel.addEventListener("click", (e) => {
    if (e.target === promptPanel) { closePromptPanel(); return; }
    if (e.target.closest("[data-diet-edit]")) { closePromptPanel(); openAccountPanel("menu"); }
  });

  // ---------- AI recipe coach (troubleshoot / improve) ----------
  // A conversational assistant scoped to one recipe. The full thread is held
  // client-side and resent each turn (the Edge Function is stateless); in
  // troubleshoot mode the AI asks clarifying questions before diagnosing.
  // Each recipe's conversation (per mode) is cached in localStorage for 24h so
  // the cook can close the panel and revisit the coaching later.
  let coachRecipeId = null;
  let coachMode = "troubleshoot";
  let coachMessages = [];          // [{ role:"user"|"assistant", content }]
  let coachBusy = false;
  let coachToken = 0;              // guards stale responses
  let coachLastResult = null;      // the latest assistant result (for Apply)

  const COACH_PLACEHOLDERS = {
    troubleshoot: "Describe what happened — e.g. “the caramel turned out grainy and the apples were watery.”",
    tweak: "What would you like changed? e.g. “it’s too sweet” or “the sauce feels like it’s missing something.”"
  };

  // --- 24h conversation persistence (per recipe, per mode) ---
  const COACH_STORE_PREFIX = "coach:v1:";
  const COACH_TTL_MS = 24 * 60 * 60 * 1000;
  const COACH_MAX_STORED_MESSAGES = 40;
  const coachStoreKey = (recipeId) => COACH_STORE_PREFIX + recipeId;

  // Read a recipe's stored conversations, dropping any mode older than 24h.
  function loadCoachStore(recipeId) {
    try {
      const raw = localStorage.getItem(coachStoreKey(recipeId));
      if (!raw) return {};
      const store = JSON.parse(raw) || {};
      let changed = false;
      for (const mode of Object.keys(store)) {
        if (!store[mode] || Date.now() - (store[mode].updatedAt || 0) > COACH_TTL_MS) {
          delete store[mode];
          changed = true;
        }
      }
      if (changed) {
        if (Object.keys(store).length) localStorage.setItem(coachStoreKey(recipeId), JSON.stringify(store));
        else localStorage.removeItem(coachStoreKey(recipeId));
      }
      return store;
    } catch {
      return {}; // storage unavailable (e.g. Safari private mode) — in-memory only
    }
  }

  // Persist the current conversation; called after every turn.
  function saveCoachState() {
    if (!coachRecipeId) return;
    try {
      const store = loadCoachStore(coachRecipeId);
      if (coachMessages.length) {
        store[coachMode] = {
          messages: coachMessages.slice(-COACH_MAX_STORED_MESSAGES),
          result: coachLastResult,
          updatedAt: Date.now()
        };
      } else {
        delete store[coachMode];
      }
      if (Object.keys(store).length) localStorage.setItem(coachStoreKey(coachRecipeId), JSON.stringify(store));
      else localStorage.removeItem(coachStoreKey(coachRecipeId));
    } catch { /* storage unavailable — the in-memory thread still works this session */ }
  }

  // Load the saved thread for the current recipe + mode into memory (or empty).
  function restoreCoachState() {
    const saved = loadCoachStore(coachRecipeId)[coachMode];
    coachMessages = saved && Array.isArray(saved.messages) ? saved.messages.slice() : [];
    coachLastResult = saved && saved.result ? saved.result : null;
  }

  function coachRecipe() {
    return coachRecipeId ? byId[coachRecipeId] : null;
  }

  // The recipe shape the Edge Function (and a revised_recipe round-trip) expects.
  function serializeRecipeForCoach(it) {
    return {
      name: it.name,
      subtitle: it.subtitle,
      section: it.section,
      tags: it.tags,
      base_servings: it.baseServings,
      servings_label: it.servingsLabel,
      ingredients: it.ingredients,
      method: it.method,
      notes: it.notes
    };
  }

  function setCoachMode(mode) {
    coachMode = mode === "tweak" ? "tweak" : "troubleshoot";
    coachModeTroubleshootBtn.classList.toggle("is-active", coachMode === "troubleshoot");
    coachModeTroubleshootBtn.setAttribute("aria-selected", String(coachMode === "troubleshoot"));
    coachModeTweakBtn.classList.toggle("is-active", coachMode === "tweak");
    coachModeTweakBtn.setAttribute("aria-selected", String(coachMode === "tweak"));
    coachInput.placeholder = COACH_PLACEHOLDERS[coachMode];
    // Restore this mode's saved conversation (within 24h), else start fresh.
    coachStatus.textContent = "";
    restoreCoachState();
    renderCoachThread();
  }

  function openCoachPanel(id) {
    const it = byId[id];
    if (!it) return;
    coachRecipeId = id;
    coachToken++;
    coachLoading.hidden = true;
    coachInput.value = "";
    coachRecipeName.textContent = `· ${it.name}`;
    setCoachMode("troubleshoot");
    coachPanel.hidden = false;
    coachInput.focus();
  }

  function closeCoachPanel() {
    coachToken++;             // abandon any in-flight response
    coachBusy = false;
    coachPanel.hidden = true;
  }

  function renderCoachThread() {
    const it = coachRecipe();
    const mine = it && it.userId === session?.user?.id;
    if (!coachMessages.length) {
      const hint = coachMode === "tweak"
        ? "Tell me what to improve and I’ll suggest specific changes — and can rewrite the recipe for you to review."
        : "Tell me what went wrong and I’ll help you figure out why. I may ask a couple of questions first.";
      coachThread.innerHTML = `<p class="coach-empty">${esc(hint)}</p>`;
      return;
    }
    const parts = coachMessages.map((m, i) => {
      const last = i === coachMessages.length - 1;
      let extra = "";
      // Attach suggestions / Apply / Emphasize to the final assistant turn only.
      if (m.role === "assistant" && last && coachLastResult) {
        const sugg = coachLastResult.suggestions || [];
        if (sugg.length) {
          extra += `<ul class="coach-suggestions">${sugg.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>`;
        }
        const concluded = !coachLastResult.needs_more_info;
        // Action buttons get their own line under the reply (the wrapper is block).
        if (concluded && coachLastResult.revised_recipe && mine) {
          // A revised recipe is ready (a tweak, or a troubleshoot emphasis) → review & save.
          extra += `<div class="coach-actions"><button type="button" class="solid-btn small coach-apply-btn">Apply changes to recipe</button></div>`;
        } else if (concluded && coachMode === "troubleshoot" && mine) {
          // Diagnosis is in — offer to bake the lesson into the recipe's steps.
          extra += `<div class="coach-actions"><button type="button" class="ghost-btn small coach-emphasize-btn">✍️ Update recipe to emphasize this</button></div>`;
        }
      }
      return `<div class="coach-msg ${m.role === "user" ? "user" : "ai"}">${esc(m.content).replace(/\n/g, "<br>")}${extra}</div>`;
    });
    coachThread.innerHTML = parts.join("");
    coachThread.scrollTop = coachThread.scrollHeight;
  }

  async function sendCoach(textOverride) {
    if (coachBusy) return;
    const it = coachRecipe();
    if (!it) return;
    const text = (textOverride != null ? textOverride : coachInput.value).trim();
    if (!text) return;

    coachMessages.push({ role: "user", content: text });
    if (textOverride == null) coachInput.value = "";
    coachLastResult = null;
    saveCoachState();
    renderCoachThread();

    coachBusy = true;
    coachSendBtn.disabled = true;
    coachLoading.hidden = false;
    coachStatus.textContent = "";
    const token = ++coachToken;

    const invokePromise = supabaseClient.functions.invoke("recipe-coach", {
      body: { mode: coachMode, recipe: serializeRecipeForCoach(it), messages: coachMessages }
    }).catch((error) => ({ error }));
    const timeoutPromise = new Promise((resolve) =>
      setTimeout(() => resolve(EXTRACTION_TIMEOUT), EXTRACTION_TIMEOUT_MS)
    );
    const raced = await Promise.race([invokePromise, timeoutPromise]);

    // Stale: panel closed, mode switched, or a newer turn started.
    if (token !== coachToken || coachPanel.hidden) return;
    coachBusy = false;
    coachSendBtn.disabled = false;
    coachLoading.hidden = true;

    if (raced === EXTRACTION_TIMEOUT) {
      coachStatus.textContent = "That’s taking too long — check your connection and try again.";
      return;
    }
    const { data, error } = raced;
    if (error || data?.error) {
      coachStatus.textContent = `Error: ${data?.error || error.message}`;
      return;
    }

    coachLastResult = data.result;
    coachMessages.push({ role: "assistant", content: data.result.reply });
    saveCoachState();
    renderCoachThread();
    coachInput.focus();
  }

  // Ask the coach to fold the diagnosis into the recipe's steps, then route the
  // returned revised recipe through the normal review-before-save flow.
  const COACH_EMPHASIZE_PROMPT =
    "Based on what we figured out, please update my recipe to emphasize the step(s) I got wrong — make the critical detail (the exact amount, temperature, timing, or technique that caused the problem) clear and hard to miss in the method, so I don't repeat the mistake. Keep everything else the same.";
  function requestCoachEmphasis() {
    sendCoach(COACH_EMPHASIZE_PROMPT);
  }

  function applyCoachRevision() {
    const it = coachRecipe();
    const revised = coachLastResult?.revised_recipe;
    if (!it || !revised) return;
    closeCoachPanel();
    openRecipeForm(it);
    fillRecipeFormFromExtraction(revised);
    recipeFormStatus.textContent = "AI suggested these changes — please review before saving.";
  }

  coachModeTroubleshootBtn.addEventListener("click", () => setCoachMode("troubleshoot"));
  coachModeTweakBtn.addEventListener("click", () => setCoachMode("tweak"));
  coachSendBtn.addEventListener("click", () => sendCoach());
  coachInput.addEventListener("keydown", (e) => {
    // Enter sends; Shift+Enter inserts a newline.
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendCoach();
    }
  });
  coachThread.addEventListener("click", (e) => {
    if (e.target.closest(".coach-apply-btn")) applyCoachRevision();
    else if (e.target.closest(".coach-emphasize-btn")) requestCoachEmphasis();
  });
  $("#close-coach").addEventListener("click", closeCoachPanel);
  coachPanel.addEventListener("click", (e) => {
    if (e.target === coachPanel) closeCoachPanel();
  });

  // ---------- Events ----------
  // Tabs
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      section = btn.dataset.section;
      document.querySelectorAll(".tab").forEach((b) => {
        const on = b === btn;
        b.classList.toggle("is-active", on);
        b.setAttribute("aria-selected", on);
      });
      document.body.classList.toggle("section-cocktails", section === "cocktails");
      activeTags.clear();
      refreshViews();
    });
  });

  // Search
  searchEl.addEventListener("input", () => {
    searchTerm = searchEl.value;
    renderList();
  });

  // Filter panel toggle
  toggleFiltersBtn.addEventListener("click", () => {
    const open = tagFiltersEl.hidden;
    tagFiltersEl.hidden = !open;
    toggleFiltersBtn.setAttribute("aria-expanded", open);
  });

  // Favorites-only toggle
  toggleFavoritesBtn.addEventListener("click", () => {
    favoritesOnly = !favoritesOnly;
    toggleFavoritesBtn.setAttribute("aria-pressed", String(favoritesOnly));
    if (favoritesOnly) {
      sharedOnly = false;
      toggleSharedBtn.setAttribute("aria-pressed", "false");
    }
    syncScope();
    // refreshViews (not just renderList): turning this on clears sharedOnly,
    // which swaps the active pool, so the tag-filter bar must rebuild too.
    refreshViews();
  });

  // Shared-with-me toggle
  toggleSharedBtn.addEventListener("click", () => {
    sharedOnly = !sharedOnly;
    toggleSharedBtn.setAttribute("aria-pressed", String(sharedOnly));
    if (sharedOnly) {
      favoritesOnly = false;
      toggleFavoritesBtn.setAttribute("aria-pressed", "false");
    }
    syncScope();
    refreshViews(); // pool changed — tag filters + active filters need refresh too
  });

  // Scope-all resets both filters
  scopeAllBtn.addEventListener("click", () => {
    favoritesOnly = false; sharedOnly = false;
    toggleFavoritesBtn.setAttribute("aria-pressed", "false");
    toggleSharedBtn.setAttribute("aria-pressed", "false");
    syncScope();
    refreshViews();
  });

  // Tag chips (filter panel + active-filter row)
  function handleTagClick(e) {
    const chip = e.target.closest(".tag-chip");
    if (chip) {
      const t = chip.dataset.tag;
      activeTags.has(t) ? activeTags.delete(t) : activeTags.add(t);
      refreshViews();
      return;
    }
    if (e.target.id === "clear-tags") {
      activeTags.clear();
      refreshViews();
    }
  }
  tagFiltersEl.addEventListener("click", handleTagClick);
  activeFiltersEl.addEventListener("click", handleTagClick);

  // List interactions (expand, pick, servings) — event delegation
  listEl.addEventListener("click", (e) => {
    const li = e.target.closest(".item");
    if (!li) return;
    const id = li.dataset.id;

    if (e.target.closest(".star-btn")) {
      toggleFavorite(byId[id]);
      return;
    }

    if (e.target.classList.contains("pick")) {
      // Carry any scale chosen in the detail view into the grocery list.
      if (e.target.checked) basket.set(id, { servings: defaultAddServings(byId[id]) });
      else basket.delete(id);
      persistGrocery();
      renderList();
      renderGroceryBar();
      if (!groceryPanel.hidden) renderGroceryPanel();
      return;
    }

    if (e.target.closest(".detail-grocery-btn")) {
      if (basket.has(id)) basket.delete(id);
      else basket.set(id, { servings: defaultAddServings(byId[id]) });
      persistGrocery();
      renderList();
      renderGroceryBar();
      if (!groceryPanel.hidden) renderGroceryPanel();
      return;
    }

    // Servings steppers: the list-row one (grocery) and the detail-view one
    // both route through setRecipeServings so the scale stays consistent.
    const stepBtn = e.target.closest(".serv-btn, .detail-serv-btn");
    if (stepBtn) {
      setRecipeServings(id, chosenServings(byId[id]) + Number(stepBtn.dataset.step));
      return;
    }

    if (e.target.closest(".cook-btn")) {
      openCookMode(byId[id], chosenServings(byId[id]));
      return;
    }

    if (e.target.closest(".coach-btn")) {
      openCoachPanel(id);
      return;
    }

    const removeBtn = e.target.closest(".share-remove-btn");
    if (removeBtn) {
      unshareRecipe(byId[id], removeBtn.dataset.userId);
      return;
    }

    const moreBtn = e.target.closest(".detail-more-btn");
    if (moreBtn) {
      const it = byId[id];
      const mine = it.userId === session?.user?.id;
      if (!detailMoreMenu.hidden && detailMoreMenuTrigger === moreBtn) closeDetailMoreMenu();
      else openDetailMoreMenu(moreBtn, it, mine);
      return;
    }

    if (e.target.closest(".add-to-plan-btn")) {
      addToMealPlanTray(id);
      return;
    }

    const unitBtn = e.target.closest(".unit-toggle-btn");
    if (unitBtn) {
      unitSystem = unitBtn.dataset.unit;
      renderList();
      return;
    }

    if (e.target.closest(".item-head") || e.target.classList.contains("chevron")) {
      openItems.has(id) ? openItems.delete(id) : openItems.add(id);
      renderList();
    }
  });

  // Submitting the "share with..." form inside an open share panel.
  listEl.addEventListener("submit", (e) => {
    const form = e.target.closest(".share-add-row");
    if (!form) return;
    e.preventDefault();
    const li = form.closest(".item");
    const input = form.querySelector(".share-email-input");
    shareRecipe(byId[li.dataset.id], input.value, form);
  });

  // ---------- Cook mode (guided, full-screen, screen stays awake) ----------
  let cookItem = null;
  let cookServings = 0;
  let cookIdx = 0;
  let cookSteps = [];
  let cookCheckedIngs = new Set(); // session-only, reset each time cook mode opens
  let wakeLock = null;

  async function requestWakeLock() {
    releaseWakeLock(); // drop any stale lock before acquiring a fresh one
    try {
      if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen");
    } catch {
      // Denied, low battery, or unsupported — cooking still works, screen may dim.
      wakeLock = null;
    }
  }
  function releaseWakeLock() {
    if (wakeLock) {
      wakeLock.release().catch(() => {});
      wakeLock = null;
    }
  }
  // Browsers drop the lock when the tab is backgrounded; re-take it on return.
  document.addEventListener("visibilitychange", () => {
    if ((!cookPanel.hidden || shoppingModeOn) && document.visibilityState === "visible") requestWakeLock();
  });

  function openCookMode(item, servings) {
    cookSteps = item.method || [];
    if (!cookSteps.length) {
      toast("No method steps to cook from");
      return;
    }
    cookItem = item;
    cookServings = servings;
    cookIdx = 0;
    cookCheckedIngs = new Set();
    stopCookTimer();
    cookTitle.textContent = item.name;
    renderCookIngredients();
    cookIngredients.hidden = true;
    cookIngToggle.setAttribute("aria-expanded", "false");
    cookPanel.hidden = false;
    document.body.style.overflow = "hidden";
    renderCookStep();
    requestWakeLock();
  }

  function renderCookSectionBar() {
    // Build a deduplicated list of sections [{group, firstIdx}] from cookSteps
    const sections = [];
    let lastGroup;
    cookSteps.forEach((s, i) => {
      const g = s.group || null;
      if (g !== lastGroup) { sections.push({ group: g, firstIdx: i }); lastGroup = g; }
    });
    if (sections.length < 2) { cookSectionsEl.hidden = true; return; }
    const currentGroup = cookSteps[cookIdx].group || null;
    cookSectionsEl.innerHTML = sections.map((sec) =>
      `<button class="cook-sec-chip${sec.group === currentGroup ? " is-active" : ""}"
               data-cook-idx="${sec.firstIdx}">${esc(sec.group || "Intro")}</button>`
    ).join("");
    cookSectionsEl.hidden = false;
    // Scroll the active chip into view
    const active = cookSectionsEl.querySelector(".cook-sec-chip.is-active");
    if (active) active.scrollIntoView({ inline: "nearest", block: "nearest", behavior: "smooth" });
  }

  function renderCookStep() {
    const total = cookSteps.length;
    const step = cookSteps[cookIdx];
    const prefix = step.group ? `${step.group} · ` : "";
    cookStepNum.textContent = `${prefix}Step ${cookIdx + 1} of ${total}`;
    cookStepText.textContent = step.text;
    renderCookStepIngredients(step);
    renderStepTimers(step);
    cookProgressBar.style.width = `${((cookIdx + 1) / total) * 100}%`;
    cookPrevBtn.disabled = cookIdx === 0;
    cookNextBtn.textContent = cookIdx === total - 1 ? "Done ✓" : "Next →";
    cookBody.scrollTop = 0;
    renderCookSectionBar();
    renderCookRail();
  }

  function renderCookRail() {
    const total = cookSteps.length;
    if (total < 2) { cookRailEl.hidden = true; return; }
    cookRailEl.innerHTML = cookSteps.map((_, i) =>
      `<button type="button" class="cook-rail-dot${i === cookIdx ? " is-active" : ""}"
               data-cook-idx="${i}" aria-label="Go to step ${i + 1}"></button>`
    ).join("");
    cookRailEl.hidden = false;
    const active = cookRailEl.querySelector(".cook-rail-dot.is-active");
    if (active) active.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
  }

  // Surface the relevant ingredient amounts inline with each step, so the cook
  // doesn't have to flip back to the ingredients panel mid-task. Pills are
  // display-only (pointer-events: none in CSS) so they never intercept the
  // tap-to-advance / swipe handling on .cook-step.
  function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
  function renderCookStepIngredients(step) {
    const stepLower = step.text.toLowerCase();
    const matches = scaledIngredients(cookItem, cookServings).filter((ing) => {
      if (!ing.item) return false;
      const head = normalizeItemName(ing.item).split(/[,(]/)[0].trim();
      if (!head) return false;
      return new RegExp(`\\b${escapeRegex(head)}\\b`, "i").test(stepLower);
    });
    cookStepIngredients.hidden = !matches.length;
    if (!matches.length) return;
    cookStepIngredients.innerHTML = matches.map((ing) => {
      const amtStr = ing.scaled == null ? "" : fmtAmount(ing.scaled) + (ing.unit ? " " + ing.unit : "");
      return `<span class="cook-step-ing">${esc([amtStr, displayGroceryName(ing.item)].filter(Boolean).join(" "))}</span>`;
    }).join("");
  }

  // ---------- Cook step timers ----------
  // {endsAt, label, intervalId, paused, remaining} — survives step changes,
  // cleared on open/close. While paused, `intervalId` is null and `remaining`
  // (seconds left) is authoritative instead of `endsAt`.
  let cookTimer = null;
  const DURATION_RE = /(\d+(?:\.\d+)?)\s*(hours?|hrs?|minutes?|mins?|seconds?|secs?)\b/gi;
  function parseDurations(text) {
    const out = [];
    let m;
    DURATION_RE.lastIndex = 0;
    while ((m = DURATION_RE.exec(text))) {
      const value = parseFloat(m[1]);
      const unit = m[2].toLowerCase();
      const seconds = unit.startsWith("h") ? value * 3600 : unit.startsWith("m") ? value * 60 : value;
      out.push({ seconds: Math.round(seconds), label: m[0] });
    }
    return out;
  }
  function renderStepTimers(step) {
    const durations = parseDurations(step.text);
    cookTimerChips.hidden = !durations.length;
    if (!durations.length) return;
    cookTimerChips.innerHTML = durations.map((d) =>
      `<button type="button" class="cook-timer-chip" data-seconds="${d.seconds}" data-label="${esc(d.label)}">⏱ ${esc(d.label)}</button>`
    ).join("");
  }
  function startCookTimer(seconds, label) {
    if (cookTimer) clearInterval(cookTimer.intervalId);
    cookTimer = { endsAt: Date.now() + seconds * 1000, label, intervalId: null, paused: false, remaining: null };
    cookTimerBar.hidden = false;
    cookTimerBar.classList.remove("is-paused");
    cookTimerLabel.textContent = label;
    cookTimerPauseBtn.textContent = "Pause";
    cookTimerPauseBtn.setAttribute("aria-label", "Pause timer");
    paintTimer();
    cookTimer.intervalId = setInterval(paintTimer, 1000);
  }
  function paintTimer() {
    if (!cookTimer) return;
    const remaining = Math.round((cookTimer.endsAt - Date.now()) / 1000);
    if (remaining <= 0) { timerDone(); return; }
    const mm = String(Math.floor(remaining / 60)).padStart(2, "0");
    const ss = String(remaining % 60).padStart(2, "0");
    cookTimerClock.textContent = `${mm}:${ss}`;
  }
  // A soft two-note chime (sine tones with a fade-in/out envelope) rather than
  // a single tone snapping straight to full volume and cutting off abruptly.
  function playTimerChime() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const now = ctx.currentTime;
      const notes = [
        { freq: 880, start: 0, dur: 0.35 },
        { freq: 1108.73, start: 0.26, dur: 0.5 }
      ];
      notes.forEach(({ freq, start, dur }) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0, now + start);
        gain.gain.linearRampToValueAtTime(0.18, now + start + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + start + dur);
        osc.connect(gain).connect(ctx.destination);
        osc.start(now + start);
        osc.stop(now + start + dur + 0.05);
      });
      const totalMs = (Math.max(...notes.map((n) => n.start + n.dur)) + 0.1) * 1000;
      setTimeout(() => ctx.close(), totalMs);
    } catch {}
  }
  // Soft accent-tinted pulse over the cook panel so the "time's up" moment is
  // visible even if the phone's face-down or the sound's missed — one-shot,
  // self-removing so it can re-fire for the next timer. `animationend` never
  // fires under prefers-reduced-motion (the global rule disables the
  // animation), so fall back to a timeout there.
  function flashCookPanel() {
    cookPanel.classList.remove("cook-timer-flash");
    void cookPanel.offsetWidth; // restart the animation if it's still mid-flash
    cookPanel.classList.add("cook-timer-flash");
    const clear = () => cookPanel.classList.remove("cook-timer-flash");
    cookPanel.addEventListener("animationend", clear, { once: true });
    setTimeout(clear, 1000);
  }
  function timerDone() {
    if (cookTimer) clearInterval(cookTimer.intervalId);
    cookTimerBar.classList.remove("is-paused");
    cookTimerClock.textContent = "Done!";
    if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 200]);
    playTimerChime();
    flashCookPanel();
    cookTimer = null;
  }
  function pauseCookTimer() {
    if (!cookTimer || cookTimer.paused) return;
    clearInterval(cookTimer.intervalId);
    cookTimer.intervalId = null;
    cookTimer.remaining = Math.max(0, Math.round((cookTimer.endsAt - Date.now()) / 1000));
    cookTimer.paused = true;
    cookTimerBar.classList.add("is-paused");
    cookTimerPauseBtn.textContent = "Resume";
    cookTimerPauseBtn.setAttribute("aria-label", "Resume timer");
  }
  function resumeCookTimer() {
    if (!cookTimer || !cookTimer.paused) return;
    cookTimer.endsAt = Date.now() + cookTimer.remaining * 1000;
    cookTimer.paused = false;
    cookTimerBar.classList.remove("is-paused");
    cookTimerPauseBtn.textContent = "Pause";
    cookTimerPauseBtn.setAttribute("aria-label", "Pause timer");
    paintTimer();
    cookTimer.intervalId = setInterval(paintTimer, 1000);
  }
  function stopCookTimer() {
    if (cookTimer) clearInterval(cookTimer.intervalId);
    cookTimer = null;
    cookTimerBar.hidden = true;
    cookTimerBar.classList.remove("is-paused");
  }
  cookTimerChips.addEventListener("click", (e) => {
    const chip = e.target.closest(".cook-timer-chip");
    if (!chip) return;
    e.stopPropagation();
    startCookTimer(Number(chip.dataset.seconds), chip.dataset.label);
  });
  cookTimerPauseBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!cookTimer) return;
    cookTimer.paused ? resumeCookTimer() : pauseCookTimer();
  });
  cookTimerStopBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    stopCookTimer();
  });

  function renderCookIngredients() {
    const ings = scaledIngredients(cookItem, cookServings);
    const note = cookServings !== cookItem.baseServings
      ? `scaled to ${cookServings} ${cookItem.servingsLabel}`
      : `makes ${cookItem.baseServings} ${cookItem.servingsLabel}`;
    cookIngredients.innerHTML = `
      <p class="cook-ing-note">${esc(note)}</p>
      ${groupRuns(ings).map((run) => `
        ${run.group ? `<h4 class="sub-group">${esc(run.group)}</h4>` : ""}
        <ul class="ing-list">
          ${run.items.map((ing) => {
            const l = ingLine(ing, true);
            const key = normalizeItemName(ing.item);
            const checked = cookCheckedIngs.has(key);
            return `<li class="ing-row${checked ? " is-checked" : ""}" data-ing="${esc(key)}"><span class="ing-amt">${esc(l.amtStr)}</span><span>${esc(l.item)}</span></li>`;
          }).join("")}
        </ul>`).join("")}`;
  }

  function cookNext() {
    if (cookIdx >= cookSteps.length - 1) {
      closeCookMode();
      return;
    }
    cookIdx++;
    renderCookStep();
  }
  function cookPrev() {
    if (cookIdx === 0) return;
    cookIdx--;
    renderCookStep();
  }
  function closeCookMode() {
    cookPanel.hidden = true;
    document.body.style.overflow = "";
    releaseWakeLock();
    stopCookTimer();
  }

  // Section bookmark chips — tap to jump to the first step of that section
  cookSectionsEl.addEventListener("click", (e) => {
    const chip = e.target.closest(".cook-sec-chip");
    if (chip) { cookIdx = parseInt(chip.dataset.cookIdx, 10); renderCookStep(); }
  });

  // Step rail — tap a dot to jump straight to that step
  cookRailEl.addEventListener("click", (e) => {
    const dot = e.target.closest(".cook-rail-dot");
    if (dot) { cookIdx = parseInt(dot.dataset.cookIdx, 10); renderCookStep(); }
  });

  // Swipe left/right to advance/go back
  let swipeStartX = 0, swipeStartY = 0, cookSwiped = false;
  cookBody.addEventListener("touchstart", (e) => {
    swipeStartX = e.touches[0].clientX;
    swipeStartY = e.touches[0].clientY;
    cookSwiped = false;
  }, { passive: true });
  cookBody.addEventListener("touchend", (e) => {
    const dx = e.changedTouches[0].clientX - swipeStartX;
    const dy = e.changedTouches[0].clientY - swipeStartY;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      cookSwiped = true;
      if (dx < 0) cookNext(); else cookPrev(); // swipe left = forward, right = back
    }
  }, { passive: true });

  // Tap the step body to advance (suppress if a swipe just fired)
  cookBody.addEventListener("click", () => {
    if (cookSwiped) { cookSwiped = false; return; }
    cookNext();
  });
  cookNextBtn.addEventListener("click", cookNext);
  cookPrevBtn.addEventListener("click", cookPrev);
  cookCloseBtn.addEventListener("click", closeCookMode);
  cookIngToggle.addEventListener("click", () => {
    cookIngredients.hidden = !cookIngredients.hidden;
    cookIngToggle.setAttribute("aria-expanded", String(!cookIngredients.hidden));
  });
  cookIngredients.addEventListener("click", (e) => {
    const row = e.target.closest(".ing-row");
    if (!row) return;
    const key = row.dataset.ing;
    if (cookCheckedIngs.has(key)) cookCheckedIngs.delete(key);
    else cookCheckedIngs.add(key);
    row.classList.toggle("is-checked");
  });
  document.addEventListener("keydown", (e) => {
    if (cookPanel.hidden) return;
    if (e.key === "ArrowRight") { e.preventDefault(); cookNext(); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); cookPrev(); }
    else if (e.key === "Escape") {
      // Consume the keypress: this handler hides the panel synchronously, so
      // the later panel-Escape listener would otherwise see it as closed and
      // also close whatever is underneath on the same keypress.
      e.stopImmediatePropagation();
      closeCookMode();
    }
  });

  // Grocery bar / panel
  function openGroceryPanel() {
    renderGroceryPanel();
    groceryPanel.hidden = false;
  }
  $("#open-grocery").addEventListener("click", openGroceryPanel);
  // Header shortcut: always available, so a list built only from pantry/bar
  // restocks (no checked recipes) can still be opened.
  $("#open-grocery-top").addEventListener("click", openGroceryPanel);
  $("#close-grocery").addEventListener("click", closeGroceryPanel);
  groceryPanel.addEventListener("click", (e) => {
    if (e.target === groceryPanel) closeGroceryPanel();
  });
  shoppingModeToggle.addEventListener("click", () => setShoppingMode(!shoppingModeOn));

  // Mode tabs: Recipes ↔ Meal plan
  modeRecipesBtn.addEventListener("click", () => setViewMode("recipes"));
  modeMealplanBtn.addEventListener("click", () => setViewMode("mealplan"));
  mealPlanView.addEventListener("click", (e) => {
    if (e.target.closest("#mp-make-grocery")) { groceryFromPlan(); return; }
    const viewBtn = e.target.closest("[data-plan-view]");
    if (viewBtn) {
      planView = viewBtn.dataset.planView;
      saveLocal("planView", planView);
      renderMealPlan();
      return;
    }
    const trayRemove = e.target.closest("[data-tray-remove]");
    if (trayRemove) { removeFromTray(trayRemove.dataset.trayRemove); return; }
    const trayChip = e.target.closest("[data-tray]");
    if (trayChip) { openPlaceSheetForRecipe(trayChip.dataset.tray); return; }
    const slotAdd = e.target.closest(".mp-slot-add");
    if (slotAdd) { openPlaceSheetForSlot(slotAdd.dataset.date, slotAdd.dataset.slot); return; }
    const entryX = e.target.closest("[data-entry]");
    if (entryX) { removeMealEntry(entryX.dataset.entry); return; }
    const cook = e.target.closest("[data-cook]");
    if (cook) {
      const it = byId[cook.dataset.cook];
      if (!it) { toast("That recipe is no longer available."); return; }
      openCookMode(it, cook.dataset.serv ? Number(cook.dataset.serv) : it.baseServings);
    }
  });
  $("#clear-grocery").addEventListener("click", () => {
    basket.clear();
    checkedGroceryItems.clear();
    persistGrocery();
    renderList();
    renderGroceryBar();
  });

  // Grocery panel: manual item add/remove
  groceryContent.addEventListener("submit", (e) => {
    if (e.target.id !== "grocery-add-manual") return;
    e.preventDefault();
    const input = $("#grocery-manual-input");
    const name = input.value.trim();
    if (!name) return;
    manualGroceryItems.push({ key: `manual:${Date.now()}`, name });
    persistGrocery();
    renderGroceryPanel();
    $("#grocery-manual-input").focus();
  });
  groceryContent.addEventListener("click", (e) => {
    const removeBtn = e.target.closest(".g-manual-remove");
    if (removeBtn) {
      const key = removeBtn.dataset.key;
      manualGroceryItems = manualGroceryItems.filter((m) => m.key !== key);
      checkedGroceryItems.delete(key);
      persistGrocery();
      renderGroceryPanel();
      return;
    }
    const upBtn = e.target.closest(".g-reorder-up");
    const downBtn = e.target.closest(".g-reorder-down");
    if (upBtn || downBtn) {
      const cat = (upBtn || downBtn).dataset.cat;
      const order = (aisleOrder || GROCERY_CATEGORY_ORDER).slice();
      const i = order.indexOf(cat);
      const j = upBtn ? i - 1 : i + 1;
      if (i < 0 || j < 0 || j >= order.length || order[j] === OTHER_CATEGORY) return;
      [order[i], order[j]] = [order[j], order[i]];
      aisleOrder = order;
      saveLocal("aisleOrder", aisleOrder);
      renderGroceryPanel();
      const reopened = groceryContent.querySelector(".g-reorder");
      if (reopened) reopened.open = true;
    }
  });

  // Grocery panel: pantry-staples toggle + per-item check-off
  groceryContent.addEventListener("change", (e) => {
    if (e.target.id === "grocery-skip-staples") {
      skipPantryStaples = e.target.checked;
      persistGrocery();
      renderGroceryPanel();
      return;
    }
    if (e.target.classList.contains("g-item-check")) {
      const key = e.target.dataset.key;
      if (e.target.checked) checkedGroceryItems.add(key);
      else checkedGroceryItems.delete(key);
      const li = e.target.closest("li");
      if (li) li.classList.toggle("is-checked", e.target.checked);
      persistGrocery();
      renderGroceryProgress();
    }
  });

  // Export actions
  $("#copy-grocery").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(groceryText());
      toast("List copied \u2014 paste it anywhere");
    } catch {
      toast("Couldn\u2019t copy \u2014 try the download button");
    }
  });

  $("#download-grocery").addEventListener("click", () => {
    const blob = new Blob([groceryText()], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "grocery-list.txt";
    a.click();
    URL.revokeObjectURL(a.href);
  });

  $("#share-grocery").addEventListener("click", async () => {
    const text = groceryText();
    if (navigator.share) {
      try {
        await navigator.share({ title: "Grocery list", text });
      } catch { /* user cancelled */ }
    } else {
      try {
        await navigator.clipboard.writeText(text);
        toast("Sharing isn\u2019t available here \u2014 list copied instead");
      } catch {
        toast("Use Copy or Download on this device");
      }
    }
  });

  // ---------- Backup / export ----------
  // Mirrors the grocery export trio (Download / Copy / Share), but the payload
  // is the full-fidelity recipe JSON and Share prefers a real file attachment so
  // an email-to-self lands as a saveable .json (the offsite copy).
  function backupFilename() {
    return `house-index-backup-${isoDate(new Date())}.json`;
  }
  function openBackupPanel() {
    if (!session) { toast("Sign in to back up your recipes."); return; }
    const k = DATA.recipes.length, b = DATA.cocktails.length, n = k + b;
    $("#backup-content").innerHTML =
      `<p class="g-empty">${n} recipe${n === 1 ? "" : "s"} ready to export as JSON ` +
      `(${k} kitchen, ${b} bar).</p>`;
    backupPanel.hidden = false;
  }
  $("#close-backup").addEventListener("click", () => (backupPanel.hidden = true));
  backupPanel.addEventListener("click", (e) => {
    if (e.target === backupPanel) backupPanel.hidden = true;
  });

  // ---------- ＋ Add dropdown + mobile FAB ----------
  function closeAddMenu() {
    addMenu.hidden = true;
    addToggle.setAttribute("aria-expanded", "false");
  }
  function openAddMenu(triggerBtn) {
    addMenu.hidden = false;
    addToggle.setAttribute("aria-expanded", "true");
    // Position the fixed menu relative to the trigger
    const r = triggerBtn.getBoundingClientRect();
    if (window.innerWidth > 560) {
      // Below the desktop toggle, right-aligned
      addMenu.style.top = (r.bottom + 8) + "px";
      addMenu.style.right = (window.innerWidth - r.right) + "px";
      addMenu.style.bottom = "";
      addMenu.style.left = "";
    } else {
      // Above the FAB on mobile
      addMenu.style.bottom = (window.innerHeight - r.top + 8) + "px";
      addMenu.style.right = (window.innerWidth - r.right) + "px";
      addMenu.style.top = "";
      addMenu.style.left = "";
    }
  }
  addToggle.addEventListener("click", (e) => {
    e.stopPropagation();
    addMenu.hidden ? openAddMenu(addToggle) : closeAddMenu();
  });
  addFab.addEventListener("click", (e) => {
    e.stopPropagation();
    addMenu.hidden ? openAddMenu(addFab) : closeAddMenu();
  });
  document.addEventListener("click", (e) => {
    if (!addMenu.hidden && !e.target.closest("#add-menu") && e.target !== addToggle && e.target !== addFab) {
      closeAddMenu();
    }
  });
  // Close menu after any action opens its panel
  [addRecipeAiBtn, addRecipeGenerateBtn, addRecipePromptBtn, addRecipeBtn].forEach((b) => b.addEventListener("click", closeAddMenu));

  // ---------- Recipe detail "⋯ More" menu ----------
  // A single shared floating menu (same fixed-position pattern as #add-menu),
  // repopulated per recipe each time a row's "More" button is clicked — there
  // can be several expanded recipe rows on screen at once, each with its own
  // trigger button, but only ever one menu instance.
  let detailMoreMenuTrigger = null;
  function closeDetailMoreMenu() {
    detailMoreMenu.hidden = true;
    if (detailMoreMenuTrigger) detailMoreMenuTrigger.setAttribute("aria-expanded", "false");
    detailMoreMenuTrigger = null;
  }
  function openDetailMoreMenu(triggerBtn, it, mine) {
    detailMoreMenu.innerHTML = mine ? `
      <button class="dm-item send-recipe-btn" data-id="${esc(it.id)}" role="menuitem">
        <span class="am-ico">📤</span><span>Send</span>
      </button>
      <button class="dm-item edit-recipe" data-id="${esc(it.id)}" role="menuitem">
        <span class="am-ico">✏️</span><span>Edit</span>
      </button>
      <button class="dm-item share-toggle-btn${openShareIds.has(it.id) ? " is-on" : ""}" data-id="${esc(it.id)}" role="menuitem">
        <span class="am-ico">🔗</span><span>${esc(shareButtonLabel(it))}</span>
      </button>
      <button class="dm-item delete-recipe-btn" data-id="${esc(it.id)}" role="menuitem">
        <span class="am-ico">🗑</span><span>Delete</span>
      </button>` : `
      <button class="dm-item send-recipe-btn" data-id="${esc(it.id)}" role="menuitem">
        <span class="am-ico">📤</span><span>Send</span>
      </button>
      <button class="dm-item copy-to-book-btn" data-id="${esc(it.id)}" role="menuitem">
        <span class="am-ico">📋</span><span>Copy to my book</span>
      </button>
      <button class="dm-item remove-shared-btn" data-id="${esc(it.id)}" role="menuitem">
        <span class="am-ico">✕</span><span>Remove</span>
      </button>`;
    detailMoreMenu.hidden = false;
    detailMoreMenuTrigger = triggerBtn;
    triggerBtn.setAttribute("aria-expanded", "true");
    const r = triggerBtn.getBoundingClientRect();
    if (window.innerWidth > 560) {
      detailMoreMenu.style.top = (r.bottom + 8) + "px";
      detailMoreMenu.style.right = (window.innerWidth - r.right) + "px";
      detailMoreMenu.style.bottom = "";
      detailMoreMenu.style.left = "";
    } else {
      // On a phone the action row wraps and "⋯ More" sits near the LEFT, so the
      // Add menu's right-anchor (its trigger is on the right) pushed this menu
      // off the left edge. Left-align to the trigger and clamp into the viewport
      // so the whole menu is always on screen, wherever the button landed.
      const menuW = detailMoreMenu.offsetWidth;
      const left = Math.max(8, Math.min(r.left, window.innerWidth - menuW - 8));
      detailMoreMenu.style.left = left + "px";
      detailMoreMenu.style.right = "";
      detailMoreMenu.style.bottom = (window.innerHeight - r.top + 8) + "px";
      detailMoreMenu.style.top = "";
    }
  }
  detailMoreMenu.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-id]");
    if (!btn) return;
    const id = btn.dataset.id;
    const it = byId[id];
    if (e.target.closest(".send-recipe-btn")) { shareRecipeFile(it); closeDetailMoreMenu(); return; }
    if (e.target.closest(".edit-recipe")) { openRecipeForm(it); closeDetailMoreMenu(); return; }
    if (e.target.closest(".delete-recipe-btn")) { deleteRecipe(it); closeDetailMoreMenu(); return; }
    if (e.target.closest(".share-toggle-btn")) {
      openShareIds.has(id) ? openShareIds.delete(id) : openShareIds.add(id);
      renderList();
      closeDetailMoreMenu();
      return;
    }
    if (e.target.closest(".copy-to-book-btn")) { copyToMyBook(it); closeDetailMoreMenu(); return; }
    if (e.target.closest(".remove-shared-btn")) { removeSharedWithMe(it); closeDetailMoreMenu(); return; }
  });
  document.addEventListener("click", (e) => {
    if (!detailMoreMenu.hidden && !e.target.closest("#detail-more-menu") && !e.target.closest(".detail-more-btn")) {
      closeDetailMoreMenu();
    }
  });
  // Both menus are position:fixed off the trigger's click-time rect, so they
  // don't track the page on scroll — close them instead of letting them detach.
  // Capture phase catches scrolls on any scrollable ancestor, not just window.
  window.addEventListener("scroll", () => {
    if (!addMenu.hidden) closeAddMenu();
    if (!detailMoreMenu.hidden) closeDetailMoreMenu();
  }, { capture: true, passive: true });

  // ---------- Feature guide ----------
  $("#open-guide").addEventListener("click", () => {
    guidePanel.querySelector(".grocery-panel-inner").scrollTop = 0;
    guidePanel.hidden = false;
  });
  $("#close-guide").addEventListener("click", () => (guidePanel.hidden = true));
  guidePanel.addEventListener("click", (e) => {
    if (e.target === guidePanel) guidePanel.hidden = true;
  });

  $("#copy-backup").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(exportRecipesJSON());
      toast("Backup JSON copied — paste it somewhere safe");
    } catch {
      toast("Couldn’t copy — try the download button");
    }
  });

  $("#download-backup").addEventListener("click", () => {
    const blob = new Blob([exportRecipesJSON()], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = backupFilename();
    a.click();
    URL.revokeObjectURL(a.href);
  });

  $("#share-backup").addEventListener("click", async () => {
    const json = exportRecipesJSON();
    const name = backupFilename();
    // Prefer sharing an actual file so it arrives as a saveable attachment.
    if (navigator.canShare) {
      try {
        const file = new File([json], name, { type: "application/json" });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: "House Index backup" });
          return;
        }
      } catch { /* fall through to text / copy */ }
    }
    if (navigator.share) {
      try { await navigator.share({ title: "House Index backup", text: json }); return; }
      catch { /* user cancelled or failed — fall through */ }
    }
    try {
      await navigator.clipboard.writeText(json);
      toast("Sharing isn’t available here — backup copied instead");
    } catch {
      toast("Use Copy or Download on this device");
    }
  });

  // Escape closes the grocery / backup panel / meal plan / recipe form / AI import.
  // Cook mode sits on top of everything and has its own Escape handler —
  // don't also close the panels underneath it on the same keypress.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !cookPanel.hidden) return;
    if (!addMenu.hidden) { closeAddMenu(); return; }
    if (!detailMoreMenu.hidden) { closeDetailMoreMenu(); return; }
    if (!groceryPanel.hidden) closeGroceryPanel();
    if (!backupPanel.hidden) backupPanel.hidden = true;
    if (!guidePanel.hidden) guidePanel.hidden = true;
    if (!accountPanel.hidden) accountPanel.hidden = true;
    if (!placeSheet.hidden) closePlaceSheet();
    if (!recipeFormPanel.hidden) closeRecipeForm();
    if (!aiImportPanel.hidden) closeAiImport();
    if (!coachPanel.hidden) closeCoachPanel();
    if (!inventoryPanel.hidden) inventoryPanel.hidden = true;
    if (!generatePanel.hidden) closeGeneratePanel();
    if (!promptPanel.hidden) closePromptPanel();
  });

  // ---------- Init ----------
  syncScope();
  renderTagFilters();
  renderList();
  renderGroceryBar();
  initAuth();
})();
