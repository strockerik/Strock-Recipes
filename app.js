/* The House Index — app logic (vanilla JS, no build step) */
(function () {
  "use strict";

  // The app's release number, shown quietly in the page footer. Bump it when a
  // release ships (minor for features and fixes, e.g. 1.1; major for a big
  // change). It is a label for people, separate from the service worker's
  // cache VERSION in sw.js, which only needs bumping to retire old caches.
  const APP_VERSION = "1.2";

  // ---------- State ----------
  let section = "recipes"; // "recipes" | "cocktails"
  let viewMode = "recipes"; // "recipes" | "mealplan" | "bottles" (Bar tab only)
  let searchTerm = "";
  let activeTags = new Set();
  let favoritesOnly = false;
  let sharedOnly = false;     // mirrors favoritesOnly — alternate "view mode"
  let sortMode = "name";      // list order: "name" (A–Z) | "newest" | "oldest"; persisted
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
  const pantryKeep = new Set(); // grocery keys the user added back despite having them in the pantry
  let groceryView = "aisle"; // grocery list grouping: "aisle" (shop it) | "recipe" (what's it for)
  const checkedGroceryItems = new Set(); // grocery: combined-item keys checked off
  let shoppingModeOn = false; // big-tap, screen-awake grocery view
  let manualGroceryItems = []; // user-typed items not tied to a recipe: {key,name}; checked state lives in checkedGroceryItems
  let unitSystem = "original"; // recipe-detail display: "original" | "us" | "metric"; persisted
  // Recipes exist, but the first fetch hasn't landed (or has failed). Without
  // this the list rendered its "No recipes yet" invitation while the request
  // was still in flight — and kept it after a failure, so a dropped connection
  // looked exactly like an empty account.
  let dataState = "loading"; // "loading" | "ready" | "error"
  let householdServings = null; // "we usually cook for N" default, applied only when first adding a recipe to the grocery list or meal plan
  let aisleOrder = null; // user-customized store-walk order for grocery categories; set in loadUserLocalState
  let seenPickHint = false; // dismissed the "check recipes to build a grocery list" hint
  let seenIntro = false; // dismissed the first-run Cook/Plan/Shop pointer card
  let seenHomeTip = false; // dismissed the "add to your home screen" tip (iOS Safari only)
  let planView = "dinners"; // meal-plan grid density: "dinners" | "all"
  // King Soopers (Kroger) ordering prefs, profile-backed (cross-device).
  let krogerPrefs = { locationId: null, storeName: "", zip: "", productPref: "best", modality: "PICKUP" };
  // Bar & pantry inventory (Supabase-backed, source of truth): {id,section,category,name,status}
  let inventory = [];
  let invSection = "bar"; // which sub-tab the inventory panel is showing: "bar" | "pantry"
  let collapsedInvCats = new Set(); // "<section>:<category>" keys the user has collapsed; persisted
  let invOutOnly = false; // inventory filter: show only out-of-stock items (resets each open)
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
    // basket / checkedGroceryItems / manualGroceryItems / skipPantryStaples /
    // aisleOrder are Supabase-backed now (loadGroceryList/loadMyGroceryPrefs
    // in loadData) — this only hydrates state that's still per-device.
    loadLocal("mealTray", []).forEach((id) => mealPlanTray.add(id));
    householdServings = loadLocal("household", null);
    seenPickHint = loadLocal("seenPickHint", false);
    seenIntro = loadLocal("seenIntro", false);
    seenHomeTip = loadLocal("seenHomeTip", false);
    planView = loadLocal("planView", "dinners");
    sortMode = ["name", "newest", "oldest"].includes(loadLocal("sortMode", "name")) ? loadLocal("sortMode", "name") : "name";
    loadLocal("pantryKeep", []).forEach((k) => pantryKeep.add(k));
    groceryView = loadLocal("groceryView", "aisle") === "recipe" ? "recipe" : "aisle";
    // A metric household shouldn't have to re-tap Metric on every launch.
    unitSystem = ["original", "us", "metric"].includes(loadLocal("unitSystem", "original"))
      ? loadLocal("unitSystem", "original") : "original";
    collapsedInvCats = new Set(loadLocal("invCollapsed", []));
    const pending = loadLocal("pendingChecks", {});
    pendingChecks = pending && typeof pending === "object" && !Array.isArray(pending) ? pending : {};
    pruneCoachStore(); // one global sweep of expired coach:v1:* threads
  }
  function maybeShowIntro() {
    introCardEl.hidden = seenIntro;
    maybeShowHomeTip();
  }
  // "Add to Home Screen" is a Safari-only flow, so only offer it there — and not
  // when the app is already running from the home screen (nothing to install).
  // iPadOS reports itself as "MacIntel", hence the touch-points check.
  function canInstallToHomeScreen() {
    const ua = navigator.userAgent;
    const isIOS = /iPad|iPhone|iPod/.test(ua) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    const isSafari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
    const standalone = window.navigator.standalone === true ||
      (window.matchMedia && window.matchMedia("(display-mode: standalone)").matches);
    return isIOS && isSafari && !standalone;
  }
  // Shown after the intro card is dismissed so the first screen isn't two stacked
  // cards; own flag, so it still appears for someone who dismissed intro earlier.
  function maybeShowHomeTip() {
    homeTipEl.hidden = seenHomeTip || !seenIntro || !canInstallToHomeScreen();
  }
  // One tip at a time: the intro, then (iPhone Safari only) the home-screen tip,
  // then this one. First launch used to stack the intro and this hint together.
  function syncPickHint(itemCount) {
    const homeTipDone = seenHomeTip || !canInstallToHomeScreen();
    const n = itemCount ?? (viewMode === "recipes" ? currentItems().length : 0);
    pickHintEl.hidden = seenPickHint || !seenIntro || !homeTipDone || viewMode !== "recipes" || n === 0;
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
  // The scope buttons inside the filter sheet are static markup, so their IDs
  // stay live; only this cloud is re-rendered.
  const tagCloudEl = $("#filter-tag-cloud");
  const searchStickyEl = $("#search-sticky");
  const modeTabsEl = $(".mode-tabs");
  const groceryTopBtn = $("#open-grocery-top");
  const groceryTopCountEl = $("#grocery-top-count");
  const toggleFiltersBtn = $("#toggle-filters");
  const sortSelect = $("#sort-by");
  const toggleFavoritesBtn = $("#toggle-favorites");
  const toggleSharedBtn = $("#toggle-shared");
  const activeFiltersEl = $("#active-filters");
  const resultCountEl = $("#result-count");
  const emptyEl = $("#empty-state");
  const groceryHeadCountEl = $("#grocery-head-count");
  const groceryPanel = $("#grocery-panel");
  const groceryContent = $("#grocery-content");
  const groceryProgressEl = $("#grocery-progress");
  const shoppingModeToggle = $("#shopping-mode-toggle");
  const backupPanel = $("#backup-panel");
  const guidePanel = $("#guide-panel");
  const placeSheet = $("#place-sheet");
  const placeSheetTitle = $("#place-sheet-title");
  const placeSheetBody = $("#place-sheet-body");
  const tonightEl = $("#tonight-card");
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
  const modeBottlesBtn = $("#mode-bottles");
  const bottlesView = $("#bottles-view");
  const bottlePanel = $("#bottle-panel");
  const bottleBody = $("#bottle-body");
  const bottleTitle = $("#bottle-title");
  const closeBottleBtn = $("#close-bottle");
  const btPhotoCamera = $("#bt-photo-camera");
  const btPhotoPick = $("#bt-photo-pick");
  const btAddPanel = $("#bt-add-panel");
  const btAddForm = $("#bt-add-form");
  const btAddName = $("#bt-add-name");
  const btAddCat = $("#bt-add-cat");
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
  const homeTipEl = $("#home-tip");
  const offlineBannerEl = $("#offline-banner");
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
  const aiPhotoNote = $("#ai-photo-note");
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
  const invOutFilterBtn = $("#inv-out-filter");

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
  const genBarPicks = $("#gen-bar-picks");
  const genBarPicksRow = $("#gen-bar-picks-row");
  const genChipsHead = $("#gen-chips-head");
  const genClearBtn = $("#gen-clear");
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

  const pairPanel = $("#pair-panel");
  const pairRecipeName = $("#pair-recipe-name");
  const pairKindCocktailBtn = $("#pair-kind-cocktail");
  const pairKindWineBtn = $("#pair-kind-wine");
  const pairKindBeerBtn = $("#pair-kind-beer");
  const pairLoading = $("#pair-loading");
  const pairStatus = $("#pair-status");
  const pairOptionsEl = $("#pair-options");

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
  const cookDoneEl = $("#cook-done");
  const cookDoneSub = $("#cook-done-sub");

  // ---------- Helpers ----------
  // Save a Blob as a file via a temporary link. The object URL is revoked on a
  // later tick rather than straight after click(), which some browsers have
  // been known to treat as cancelling the download.
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  // A recipe's source rendered for display: a URL (an imported link — the
  // TikTok, the blog) becomes a clickable link so a cook can jump back to the
  // original and re-watch the technique; anything else is plain escaped text.
  function sourceDisplayHtml(source) {
    const s = String(source || "").trim();
    if (/^https?:\/\/\S+$/i.test(s)) {
      return `<a href="${esc(s)}" target="_blank" rel="noopener noreferrer">${esc(s)}</a>`;
    }
    return esc(s);
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

  function ingLine(ing, useScaled, system, isBar) {
    const rawAmt = useScaled ? ing.scaled : ing.amount;
    const conv = convertForDisplay(rawAmt, ing.unit, system || "original", isBar);
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
  const ML_PER_FL_OZ = 29.5735;
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

  // Canonical SHORT display form for any unit spelling — so a recipe saved with
  // a verbose unit ("fluid ounces", "milliliters", "tablespoons") always renders
  // as its compact abbreviation ("fl oz", "ml", "tbsp") and never overruns the
  // ingredient line. Keys are punctuation-free + lowercased (see displayUnit).
  // Units not in this map (custom ones like "dash", "sprig", "splash") pass
  // through untouched, preserving their original text and case.
  const UNIT_ABBREV = {
    gram: "g", grams: "g", g: "g",
    kilogram: "kg", kilograms: "kg", kg: "kg",
    ounce: "oz", ounces: "oz", oz: "oz",
    pound: "lb", pounds: "lb", lb: "lb", lbs: "lb",
    "fluid ounce": "fl oz", "fluid ounces": "fl oz", "fluid oz": "fl oz", "fl oz": "fl oz", floz: "fl oz",
    milliliter: "ml", milliliters: "ml", millilitre: "ml", millilitres: "ml", ml: "ml",
    liter: "l", liters: "l", litre: "l", litres: "l", l: "l",
    teaspoon: "tsp", teaspoons: "tsp", tsp: "tsp",
    tablespoon: "tbsp", tablespoons: "tbsp", tbsp: "tbsp"
  };
  // Abbreviate a unit for display/storage: drop periods, collapse spacing, and
  // map known long spellings to their short form. Unknown units return trimmed
  // and otherwise unchanged.
  function displayUnit(unit) {
    if (!unit) return unit;
    const key = String(unit).trim().toLowerCase().replace(/\./g, "").replace(/\s+/g, " ");
    return UNIT_ABBREV[key] || String(unit).trim();
  }

  // "fl oz" is always a liquid measure, and in a BAR recipe so is a bare "oz" —
  // bartenders write "2 oz gin" meaning fluid ounces. Treating it as a weight
  // showed "56.7 g gin" in Metric and put "1 lb gin" on the grocery list.
  const FL_OZ_UNITS = new Set(["fl oz", "floz", "fluid ounce", "fluid ounces", "fluid oz"]);
  const BARE_OZ_UNITS = new Set(["oz", "ounce", "ounces"]);
  function isFluidOunce(unit, isBar) {
    const u = String(unit || "").trim().toLowerCase().replace(/\./g, "").replace(/\s+/g, " ");
    return FL_OZ_UNITS.has(u) || (!!isBar && BARE_OZ_UNITS.has(u));
  }

  // Convert (amount, unit) to a canonical form for combining across recipes:
  // weights -> grams, volumes -> milliliters, everything else is just
  // spelling-normalized (e.g. "cloves" -> "clove"). Fluid ounces stay in fl oz
  // so a bar restock reads "16 fl oz gin", not cups.
  function canonicalQuantity(amount, unit, isBar) {
    if (!unit) return { amount, family: null, unit: null };
    if (isFluidOunce(unit, isBar)) return { amount, family: null, unit: "fl oz" };
    const u = unit.trim().toLowerCase();
    if (WEIGHT_TO_G[u] != null) {
      return { amount: amount == null ? null : amount * WEIGHT_TO_G[u], family: "weight", unit: null };
    }
    if (VOLUME_TO_ML[u] != null) {
      return { amount: amount == null ? null : amount * VOLUME_TO_ML[u], family: "volume", unit: null };
    }
    // A garlic "clove" is a loose count — treat it as a bare count so "8 clove
    // garlic" and "8 garlic cloves" land on the same line (you buy bulbs anyway).
    if (u === "clove" || u === "cloves") return { amount, family: null, unit: null };
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
      // Round up like every other unit, keeping a decimal under 1 g so a pinch
      // of saffron reads "0.3 g" instead of "0 g".
      if (amount < MIN_SHOPPABLE_GRAMS) {
        return { amount: amount < 1 ? Math.ceil(amount * 10) / 10 : Math.ceil(amount - 1e-9), unit: "g" };
      }
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

  // Produce you buy whole even though recipes measure it in pieces — a garlic
  // bulb has ~10 cloves, a tomato ~8 slices. Loose pieces fold into an
  // approximate purchase count ("8 clove + 20" -> "≈ 3 bulbs"; "8 slice ripe
  // tomato" -> "≈ 1 tomato"). `loose` matches only the piece units to convert,
  // so a real count/weight ("2 tomatoes", "1½ cup cherry tomatoes") is left alone.
  const PRODUCE_PACK = {
    garlic: { loose: /^(?:|clove|cloves|ct|count|head|heads|bulb|bulbs|piece|pieces|each)$/i, per: 10, unit: "bulb", units: "bulbs" },
    tomato: { loose: /^(?:slice|slices)$/i, per: 8, unit: "tomato", units: "tomatoes" }
  };
  function producePackKey(name) {
    const n = String(name || "").toLowerCase();
    return Object.keys(PRODUCE_PACK).find((k) => new RegExp(`\\b${k}\\b`).test(n)) || null;
  }
  // Turn one or more {amount, unit} rows into a shopper-facing quantity string.
  // Bulk produce converts to purchase units; otherwise amounts in the same unit
  // sum and different units join with " + " ("5 ct + 1 ½ cup"). Empty when
  // nothing has a quantity. Shared: the grocery list passes a single row, the
  // King Soopers sheet passes every row folded onto one store product.
  function purchaseQtyStr(rows, name) {
    const pack = PRODUCE_PACK[producePackKey(name)];
    if (pack) {
      const pieces = rows.reduce((s, r) => s + (r.amount != null && pack.loose.test(r.unit || "") ? r.amount : 0), 0);
      if (pieces > 0) { const n = Math.ceil(pieces / pack.per); return `≈ ${n} ${n === 1 ? pack.unit : pack.units}`; }
    }
    const byUnit = new Map();
    rows.forEach((r) => {
      if (r.amount == null) return;
      const u = r.unit || "";
      byUnit.set(u, (byUnit.get(u) || 0) + r.amount);
    });
    return [...byUnit.entries()]
      .map(([u, amt]) => fmtAmount(amt) + (u ? " " + displayUnit(u) : ""))
      .join(" + ");
  }

  // Convert an ingredient amount into a target unit system for the per-recipe
  // toggle. "original" leaves it untouched; "metric" gives weights in g/kg and
  // volumes in ml/l; "us" gives weights in oz/lb and volumes in tsp/tbsp/cup.
  // Units that are neither weight nor volume (cloves, cans, slices, plain
  // counts) and blank "to taste" amounts pass through unchanged — there's no
  // sensible metric form of "2 cloves garlic".
  function convertForDisplay(amount, unit, system, isBar) {
    if (system === "original" || amount == null || !unit) return { amount, unit: displayUnit(unit) };
    if (isFluidOunce(unit, isBar)) {
      if (system !== "metric") return { amount, unit: displayUnit(unit) }; // oz is already the US bar measure
      const ml = amount * ML_PER_FL_OZ;
      return ml >= 1000 ? { amount: ml / 1000, unit: "l" } : { amount: ml, unit: "ml" };
    }
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
    return { amount, unit: displayUnit(unit) }; // not a convertible unit (still abbreviated)
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
      // Specialty flours are their own product, not the "flour" staple.
      .replace(/\b(?:almond|coconut|oat|rice|chickpea|nut|cake|bread|pastry|potato|corn|semolina|tapioca|spelt|rye|00|high[-\s]?gluten|pizza)\s+flour/g, " ")
      // "butter" as a modifier isn't the butter staple (puff pastry, nut butters).
      .replace(/\bpuff pastry\b/g, " ")
      .replace(/\ball[-\s]?butter\b/g, " ")
      .replace(/\b(?:peanut|almond|apple|cocoa|shea|nut|cashew)\s+butter\b/g, " ")
      // Canned packing liquid isn't the "water"/"oil" staple.
      .replace(/\b(?:packed\s+)?in\s+(?:water|brine|oil|juice)\b/g, " ");
    return PANTRY_STAPLE_RE.test(n);
  }

  // ---- Generalized ingredient synonym database ----------------------------
  // One shared table of "worded differently, same store product" so the grocery
  // combine, the King Soopers search, and extract-recipe (on import) all land on
  // the same canonical name. Ordered [pattern, replacement]; applied in sequence
  // to a plain ingredient name, case-insensitively. SOURCE OF TRUTH — mirror any
  // change into supabase/functions/extract-recipe/index.ts (INGREDIENT_ALIASES).
  const INGREDIENT_ALIASES = [
    // Chicken: the cut is the product. Drop butcher descriptors; fold a flexible
    // "breast or thigh" to breast (the common default); singularize.
    [/\b(?:boneless|skinless)\b/gi, " "],
    [/\b(?:breasts?|thighs?)\s+or\s+(?:breasts?|thighs?)\b/gi, "breast"],
    [/\bchicken\s+breasts\b/gi, "chicken breast"],
    // Yeast: instant / rapid-rise / bread-machine are one product (active-dry and
    // fresh yeast are genuinely different and are left alone).
    [/\b(?:instant\s+dry|rapid[-\s]?rise|quick[-\s]?rise|bread\s+machine)\s+yeast\b/gi, "instant yeast"],
    // Onion: size and raw-prep adjectives ("thinly sliced", "diced", "medium") are
    // the same onion, but a named VARIETY (red/yellow/white/sweet/…) is kept as
    // written — "finely diced red onion" -> "red onion". "Green onion", "pearl
    // onion", "onion powder" and dried/frozen onion products are left alone.
    [/(?<!\b(?:dried|dehydrated|instant|frozen)\s)\b(?:(?:(?:(?:finely|thinly|thickly|roughly|coarsely|freshly)\s+)?(?:chopped|diced|minced|sliced|grated|shredded|slivered|julienned|halved|quartered|cubed|peeled|trimmed|crushed|pureed)|small|medium|large|extra[-\s]?large|whole|raw),?\s+)+((?:red|yellow|white|sweet|spanish|vidalia|walla\s+walla|brown|purple)\s+)?onions?\b/gi, "$1onion"],
    // Milk: fat-content / temperature phrasings are one carton (nut milks keep
    // their qualifier — "almond milk" stays distinct). The negative lookbehind
    // leaves a trailing fat qualifier alone ("Greek yogurt, whole milk" is not a
    // milk purchase), which a later rule strips as a descriptor.
    [/(?<!,\s)\b(?:(?:whole|warm|hot|cold|lukewarm|2\s*%|1\s*%|skim|nonfat|reduced[-\s]?fat)\s+)+milk\b/gi, "milk"],
    // Scallion == green onion.
    [/\bscallions?\b/gi, "green onion"],
    // Pasta wording: "spaghetti pasta" is just spaghetti.
    [/\bspaghetti\s+pasta\b/gi, "spaghetti"],
    // Garlic is bought by the bulb — "garlic cloves" / "cloves of garlic" is just
    // garlic (the clove *unit* is normalized to a count in canonicalQuantity).
    [/\bgarlic\s+cloves?\b/gi, "garlic"],
    [/\bcloves?\s+of\s+garlic\b/gi, "garlic"],
    // Mozzarella descriptors in either order are the same product.
    [/\b(?:low[-\s]?moisture\s+whole[-\s]?milk|whole[-\s]?milk\s+low[-\s]?moisture)\s+mozzarella\b/gi, "low-moisture whole-milk mozzarella"],
    // Parmesan and Parmigiano(-Reggiano) are the same cheese. (Pecorino stays.)
    [/\bparmigiano(?:[-\s]?reggiano)?\b/gi, "parmesan"],
    [/\bparmesan\s+cheese\b/gi, "parmesan"],
    // A recipe that zests, peels, or hand-squeezes a citrus buys the whole fruit
    // — "lime peel", "fresh-squeezed lime juice", "lemon juice and zest" all mean
    // the fruit itself. (Plain "lemon juice" stays bottled — see normalizeItemName.)
    [/\bfresh(?:ly)?[-\s]squeezed\s+(lemon|lime|orange|grapefruit)\s+juice\b/gi, "$1"],
    [/\b(lemon|lime|orange|grapefruit)\s+(?:juice\s+and\s+)?zest\b/gi, "$1"],
    [/\b(lemon|lime|orange|grapefruit)\s+peel\b/gi, "$1"],
    // Culinary acids are sold as a powder, so "citric acid powder" is just citric
    // acid (lets it match a pantry "citric acid"); malic stays distinct from citric.
    [/\b(citric|malic|ascorbic|lactic|tartaric)\s+acid\s+powder\b/gi, "$1 acid"],
  ];
  // Long/thin pasta shapes — used only to spot a "flexible pasta" line.
  const PASTA_SHAPE_RE = /\b(?:spaghetti|bucatini|vermicelli|angel\s*hair|linguine|fettuccine|tagliatelle|pappardelle|penne|rigatoni|macaroni|fusilli|rotini|orzo|ziti|farfalle|cavatappi|cellentani|lasagn[ae]|noodles?)\b/i;
  function canonicalizeItem(name) {
    // Drop typographic double-quotes ("“00” flour" -> "00 flour"); keep
    // apostrophes. Slash only between letters ("boneless/skinless" -> spaces);
    // leave numeric fractions intact ("1/4 to 1/3 stick").
    let s = String(name || "").replace(/["“”]/g, "").replace(/([a-z])\/([a-z])/gi, "$1 $2");
    // A flexible pasta line ("bucatini (or any pasta)", "pasta (spaghetti or
    // bucatini)", "vermicelli, angel hair, or spaghetti") is interchangeable —
    // fold to plain "pasta" so those lines combine. A standalone shape with no
    // "or" ("spaghetti") is left as-is.
    if (/\bor\b/i.test(s) && (/\bpasta\b/i.test(s) || PASTA_SHAPE_RE.test(s))) return "pasta";
    for (const [re, to] of INGREDIENT_ALIASES) s = s.replace(re, to);
    // Tidy leftovers from dropped descriptors: normalize comma spacing, collapse
    // doubled commas, and trim stray edge commas ("chicken breast, ,", ", onion").
    return s.replace(/\s+/g, " ").replace(/\s*,\s*/g, ", ")
      .replace(/,\s*,/g, ",").replace(/(^[\s,]+)|([\s,]+$)/g, "").trim();
  }

  // Normalize an ingredient name for COMBINING and CATEGORIZING only — the name
  // shown in the list keeps its original wording. Strips prep notes and folds
  // common descriptor synonyms so e.g. "Salt and Black Pepper, to taste" and
  // "salt and pepper", or "guanciale, diced" and "guanciale", land on one line.
  const PREP_WORDS ="to taste|diced|finely diced|roughly diced|chopped|finely chopped|roughly chopped|minced|finely minced|grated|finely grated|freshly grated|shredded|sliced|thinly sliced|finely sliced|cubed|crushed|melted|softened|room temperature|at room temperature|very cold|sifted|divided|drained|rinsed|optional|peeled|seeded|deseeded|halved|quartered|crumbled|beaten|packed|cooked|uncooked|toasted|warmed|chilled|slivered|julienned|thickly sliced|coarsely chopped|coarsely grated|trimmed|cut into";
  const PREP_CLAUSE_RE = new RegExp(`,\\s*(?:${PREP_WORDS}|plus more\\b.*|for\\b.*|to top\\b.*|to serve\\b.*|to garnish\\b.*)[^,]*`, "gi");
  function normalizeItemName(name) {
    let s = canonicalizeItem(String(name)).toLowerCase().trim(); // shared synonym folds first
    s = s.replace(/\([^)]*\)/g, " ");        // drop parentheticals "(sauce)", "(⅔ cup)"
    s = s.split(/\s[—–-]\s/)[0];             // drop a trailing dash note ("olive oil — a splash")
    s = s.replace(PREP_CLAUSE_RE, " ");      // drop known prep clauses (keeps "boneless, skinless …")
    // Fat/milk-content qualifiers describe the same shelf product — drop a
    // trailing ", whole milk" / ", full-fat" / ", 2%" so e.g. "Greek yogurt,
    // whole milk" and "Greek yogurt, full-fat" land on one line.
    s = s.replace(/,\s*(?:whole[-\s]?milk|full[-\s]?fat|low[-\s]?fat|reduced[-\s]?fat|non[-\s]?fat|fat[-\s]?free|part[-\s]?skim|2\s*%|1\s*%|skim)\s*$/, "");
    s = s
      .replace(/\b(?:black|white|freshly ground|ground)\s+pepper\b/g, "pepper")
      .replace(/\b(?:kosher|sea|maldon|flaky|fine|table)\s+salt\b/g, "salt")
      .replace(/\bextra[-\s]?virgin\s+olive oil\b/g, "olive oil")
      .replace(/\bevoo\b/g, "olive oil")
      .replace(/\bconfectioners'?\s+sugar\b/g, "powdered sugar")
      .replace(/\bgarbanzos?\b/g, "chickpea")
      // "fresh" / "freshly squeezed" is a freshness note, not a product — drop it
      // so "fresh lemon juice" and "lemon juice" combine (and both match cleanly).
      .replace(/\bfreshly\s+squeezed\b/g, " ")
      .replace(/\bfresh\b/g, " ")
      // Singularize "cloves" so "1 garlic clove" and "3 garlic cloves" combine.
      .replace(/\bcloves\b/g, "clove")
      // You buy eggs for yolks/whites — so they combine with an "eggs" line.
      .replace(/\begg\s+(?:yolks?|whites?)\b/g, "eggs")
      // Singularize "eggs" so "1 egg" and "12 eggs" land on one line (leaves
      // "eggplant"/"egg noodles" alone — those have no standalone "eggs").
      .replace(/\beggs\b/g, "egg")
      // Whipping-cream variants are one product (bare "cream" left separate).
      .replace(/\b(?:heavy\s+)?whipping cream\b/g, "heavy cream")
      // Singularize common produce plurals so "carrot" and "carrots" combine.
      .replace(/\b(carrot|onion|shallot|pepper|mushroom)s\b/g, "$1")
      .replace(/\b(potato|tomato)es\b/g, "$1");
    // Commas only separated descriptors ("boneless, skinless") — drop them so a
    // comma alone can't split two otherwise-identical items onto two lines.
    return s.replace(/,/g, " ").replace(/\s+/g, " ").trim();
  }

  // The name shown on the grocery list: keep the original wording, casing, and
  // product adjectives ("peeled tomatoes", "floury potatoes"), but drop prep
  // instructions the shopper doesn't need ("carrots, diced" -> "carrots",
  // "potatoes, peeled and chopped" -> "potatoes", "olive oil — a splash" ->
  // "olive oil"). Comma clauses that aren't prep ("boneless, skinless chicken")
  // are left intact.
  function displayGroceryName(item) {
    let s = canonicalizeItem(String(item)); // shared synonym folds (same as combine)
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
  // user can customize this via "Reorder aisles" — see aisleOrder/mergeAisleOrder.
  const GROCERY_CATEGORY_ORDER = ["Produce", "Bakery", "Meat & Seafood", "Dairy & Eggs", "Frozen", "Canned & Jarred", "Dry Goods & Baking", "Condiments, Sauces & Spices", "Beverages", "Alcohol", OTHER_CATEGORY];

  // Merge a stored aisle order with the current category list, so a category
  // added to the app after the user last reordered still shows up (appended,
  // before "Other") instead of silently vanishing from the grocery panel.
  function mergeAisleOrder(stored) {
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
    const tags = row.tags || [];
    const ingredients = row.ingredients || [];
    const it = {
      id: row.id,
      section: row.section,
      name: row.name,
      subtitle: row.subtitle,
      source: row.source,
      tags,
      baseServings: row.base_servings,
      servingsLabel: row.servings_label,
      createdAt: row.created_at || null, // drives the newest/oldest sort
      ingredients,
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
    // Precompute the lowercased search haystack once at load, so filtering on
    // each keystroke is a plain substring test rather than rebuilding this
    // string per recipe per keypress.
    it.searchHay = [
      it.name, it.subtitle || "", it.source || "",
      tags.join(" "),
      ingredients.map((i) => i.item).join(" ")
    ].join(" ").toLowerCase();
    return it;
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
    if (error) toast("Couldn’t save dietary preferences — try again.", true);
  }

  // ---------- Grocery settings (profile-backed, cross-device) ----------
  // Skip-staples + aisle order aren't list *contents*, just preferences —
  // same jsonb-on-profile shape as dietPrefs above, not part of the
  // basket/manual/checked tables.
  function normalizeGroceryPrefs(raw) {
    return {
      skipStaples: !!raw?.skipStaples,
      aisleOrder: Array.isArray(raw?.aisleOrder) ? raw.aisleOrder : null
    };
  }
  async function loadMyGroceryPrefs() {
    if (!session) { skipPantryStaples = false; aisleOrder = mergeAisleOrder(null); return; }
    const { data, error } = await supabaseClient
      .from("profiles").select("grocery_prefs").eq("id", session.user.id).single();
    const prefs = error ? { skipStaples: false, aisleOrder: null } : normalizeGroceryPrefs(data?.grocery_prefs);
    skipPantryStaples = prefs.skipStaples;
    aisleOrder = mergeAisleOrder(prefs.aisleOrder);
  }
  let groceryPrefsSaveTimer = null;
  async function saveGroceryPrefs() {
    if (!session) return;
    await ensureProfile();
    const { error } = await supabaseClient.from("profiles")
      .upsert({ id: session.user.id, grocery_prefs: { skipStaples: skipPantryStaples, aisleOrder } }, { onConflict: "id" });
    if (error) toast("Couldn’t save grocery preferences — try again.", true);
  }
  function scheduleGroceryPrefsSave() {
    clearTimeout(groceryPrefsSaveTimer);
    groceryPrefsSaveTimer = setTimeout(saveGroceryPrefs, 400);
  }

  // ---------- King Soopers (Kroger) prefs (profile-backed, cross-device) ----------
  // Same jsonb-on-profile shape as dietPrefs/groceryPrefs: the chosen store +
  // how to pick among product options. Not list contents.
  function normalizeKrogerPrefs(raw) {
    const pref = ["organic", "cheapest", "best"].includes(raw?.productPref) ? raw.productPref : "best";
    const modality = raw?.modality === "DELIVERY" ? "DELIVERY" : "PICKUP";
    return {
      locationId: raw?.locationId || null,
      storeName: typeof raw?.storeName === "string" ? raw.storeName : "",
      zip: typeof raw?.zip === "string" ? raw.zip : "",
      productPref: pref,
      modality
    };
  }
  async function loadMyKrogerPrefs() {
    if (!session) { krogerPrefs = normalizeKrogerPrefs(null); return; }
    const { data, error } = await supabaseClient
      .from("profiles").select("kroger_prefs").eq("id", session.user.id).single();
    krogerPrefs = normalizeKrogerPrefs(error ? null : data?.kroger_prefs);
  }
  async function saveKrogerPrefs() {
    if (!session) return;
    await ensureProfile();
    const { error } = await supabaseClient.from("profiles")
      .upsert({ id: session.user.id, kroger_prefs: krogerPrefs }, { onConflict: "id" });
    if (error) toast("Couldn’t save King Soopers settings — try again.", true);
  }

  // ---------- Bar & pantry inventory (Supabase-backed) ----------
  function mapInventoryRow(r) {
    return { id: r.id, section: r.section, category: r.category, name: r.name, status: r.status, product_id: r.product_id || null };
  }
  async function loadInventory() {
    if (!session) { inventory = []; return; }
    const { data, error } = await supabaseClient
      .from("inventory_items").select("*").order("section").order("category");
    inventory = error ? [] : (data || []).map(mapInventoryRow);
    loadOwnedScores();
    // A bottle that wasn't in the catalog when it was added (a lookup that found
    // nothing, a typed name) gets linked once the catalog has it — tried once
    // per bottle per session; a free catalog search each, no AI.
    inventory.filter((i) => i.section === "bar" && i.name && !i.product_id && i.category !== "mixer" && !bottles.linkTried.has(i.id))
      .slice(0, 20).forEach((i) => { bottles.linkTried.add(i.id); linkInventoryToCatalog(i); });
  }
  // Returns the new item (or null). A bar bottle from the score card arrives
  // already linked to its catalog entry; one typed in by hand is linked when
  // its name is a clear catalog match (linkInventoryToCatalog).
  async function addInventoryItem({ section: sec, category, name, status, product_id }) {
    if (!session) { toast("You've been signed out — sign in again."); return null; }
    const row = { section: sec, category: category || null, name: name || null, status: status || "in" };
    if (product_id) row.product_id = product_id;
    const { data, error } = await supabaseClient
      .from("inventory_items").insert(row).select().single();
    if (error) { toastError("Couldn\u2019t add that", error); return null; }
    const item = mapInventoryRow(data);
    inventory.push(item);
    renderInventoryPanel();
    if (item.section === "bar" && !item.product_id) linkInventoryToCatalog(item);
    else if (item.product_id) loadOwnedScores();
    return item;
  }
  async function updateInventoryStatus(id, status) {
    const item = inventory.find((i) => i.id === id);
    if (!item) return;
    const prev = item.status;
    item.status = status; // optimistic
    renderInventoryPanel();
    const { error } = await supabaseClient.from("inventory_items").update({ status }).eq("id", id);
    if (error) { item.status = prev; renderInventoryPanel(); toastError("Couldn\u2019t update that", error); }
  }
  async function removeInventoryItem(id) {
    const { error } = await supabaseClient.from("inventory_items").delete().eq("id", id);
    if (error) { toastError("Couldn\u2019t remove that", error); return; }
    inventory = inventory.filter((i) => i.id !== id);
    renderInventoryPanel();
  }

  // ---------- Grocery list (Supabase-backed, cross-device) ----------
  // Three tables: basket (recipe_id + servings, one row per recipe),
  // manual items (freeform + optional inventory-restock provenance), and
  // checked-off state (a pure membership set over opaque item keys — see
  // combinedGroceryItems() for how those keys are derived; they're never
  // stored anywhere else). skipPantryStaples/aisleOrder live on the profile
  // (see loadMyGroceryPrefs above) since they're settings, not list contents.
  async function loadGroceryList() {
    if (!session) { basket.clear(); manualGroceryItems = []; checkedGroceryItems.clear(); return; }
    const [basketRes, manualRes, checkedRes] = await Promise.all([
      supabaseClient.from("grocery_basket_items").select("*"),
      supabaseClient.from("grocery_manual_items").select("*").order("created_at"),
      supabaseClient.from("grocery_checked_items").select("item_key")
    ]);
    basket.clear();
    if (!basketRes.error) (basketRes.data || []).forEach((r) => basket.set(r.recipe_id, { servings: r.servings }));
    manualGroceryItems = manualRes.error ? [] : (manualRes.data || []).map((r) => ({ key: r.id, name: r.name, sourceInventoryId: r.source_inventory_id }));
    checkedGroceryItems.clear();
    if (!checkedRes.error) (checkedRes.data || []).forEach((r) => checkedGroceryItems.add(r.item_key));
    applyPendingChecks(); // ticks made offline outrank the last-synced copy
  }

  // Optimistic: mirrors updateInventoryStatus's mutate-then-rollback shape,
  // since a checkbox needs to feel instant. Unifies the two call sites that
  // used to duplicate this (list-row .pick and the detail-view button).
  async function setBasketMembership(id, on) {
    const it = byId[id];
    if (!it) return;
    const prev = basket.has(id) ? { ...basket.get(id) } : null;
    if (on) basket.set(id, { servings: defaultAddServings(it) }); else basket.delete(id);
    // Only this row's button (and its open detail) changes; the other forty
    // don't need to lose their focus and open state over it.
    rerenderRow(id);
    renderGroceryCount();
    if (!groceryPanel.hidden) renderGroceryPanel();
    // The bottom bar used to be the proof it worked; now it's a moment's toast
    // with the way in, and the header badge keeps the count.
    else if (on) toastAction("Added to your grocery list", "View", openGroceryPanel);
    if (!session) return;
    const { error } = on
      ? await supabaseClient.from("grocery_basket_items")
          .upsert({ recipe_id: id, servings: basket.get(id).servings }, { onConflict: "user_id,recipe_id" })
      : await supabaseClient.from("grocery_basket_items").delete().eq("recipe_id", id);
    if (error) {
      if (prev) basket.set(id, prev); else basket.delete(id);
      rerenderRow(id);
      renderGroceryCount();
      if (!groceryPanel.hidden) renderGroceryPanel();
      toastError("Couldn\u2019t update your grocery list", error);
    }
  }

  // Non-optimistic (mirrors addInventoryItem/removeInventoryItem) — a manual
  // item has no natural key, so add waits for the server-generated id before
  // it can be referenced (e.g. checked off) at all.
  async function addManualGroceryItem(name, sourceInventoryId = null) {
    if (!session) { toast("You've been signed out — sign in again."); return null; }
    const { data, error } = await supabaseClient
      .from("grocery_manual_items").insert({ name, source_inventory_id: sourceInventoryId }).select().single();
    if (error) { toastError("Couldn\u2019t add that", error); return null; }
    const item = { key: data.id, name: data.name, sourceInventoryId: data.source_inventory_id };
    manualGroceryItems.push(item);
    renderGroceryCount();
    if (!groceryPanel.hidden) renderGroceryPanel();
    return item;
  }
  async function removeManualGroceryItem(key) {
    const [{ error }] = await Promise.all([
      supabaseClient.from("grocery_manual_items").delete().eq("id", key),
      supabaseClient.from("grocery_checked_items").delete().eq("item_key", key)
    ]);
    if (error) { toastError("Couldn\u2019t remove that", error); return; }
    manualGroceryItems = manualGroceryItems.filter((m) => m.key !== key);
    checkedGroceryItems.delete(key);
    renderGroceryCount();
    if (!groceryPanel.hidden) renderGroceryPanel();
  }

  // Optimistic check/uncheck. On a successful CHECK (not uncheck) of an item
  // that came from the pantry/bar restock bridge, also flip that inventory
  // row back to "in" — closing the loop between "bought it" and "back in
  // stock." Unchecking deliberately does NOT reverse this; that stays a
  // manual call in the Bar & Pantry panel.
  async function syncCheckedItem(key, checked) {
    if (!session) return;
    // Offline, keep the tick and sync it later — see "Offline" below.
    if (session.offline) { queuePendingCheck(key, checked); return; }
    const { error } = checked
      ? await supabaseClient.from("grocery_checked_items").upsert({ item_key: key }, { onConflict: "user_id,item_key" })
      : await supabaseClient.from("grocery_checked_items").delete().eq("item_key", key);
    if (error && isOfflineError(error)) { queuePendingCheck(key, checked); return; }
    if (error) {
      if (checked) checkedGroceryItems.delete(key); else checkedGroceryItems.add(key);
      renderGroceryProgress();
      if (!groceryPanel.hidden) renderGroceryPanel();
      toastError("Couldn\u2019t save that check-off", error);
      return;
    }
    if (checked) {
      const manual = manualGroceryItems.find((m) => m.key === key);
      if (manual?.sourceInventoryId) {
        const invItem = inventory.find((i) => i.id === manual.sourceInventoryId);
        if (invItem && invItem.status !== "in") await updateInventoryStatus(invItem.id, "in");
      }
    }
  }

  // One-time per-browser migration from the old localStorage-only grocery
  // list to the new synced tables, so shipping this doesn't silently drop
  // whatever's currently on someone's list. Only acts if the server-side
  // list is empty and a legacy local one isn't; sets the flag either way so
  // it's never attempted twice.
  async function migrateLegacyGroceryLocalStorage() {
    if (!session || loadLocal("groceryMigratedV2", false)) return;
    const legacyBasket = loadLocal("basket", []);
    const legacyManual = loadLocal("manualItems", []);
    const legacyChecked = new Set(loadLocal("checked", []));
    const legacySkip = loadLocal("skipStaples", null);
    const legacyAisle = loadLocal("aisleOrder", null);
    const hasLegacy = legacyBasket.length > 0 || legacyManual.length > 0;
    const serverEmpty = basket.size === 0 && manualGroceryItems.length === 0;
    if (hasLegacy && serverEmpty) {
      try {
        const basketRows = legacyBasket.filter(([id]) => byId[id]).map(([id, v]) => ({ recipe_id: id, servings: v.servings }));
        if (basketRows.length) await supabaseClient.from("grocery_basket_items").upsert(basketRows, { onConflict: "user_id,recipe_id" });
        const checkedRows = [];
        for (const m of legacyManual) {
          const { data, error } = await supabaseClient.from("grocery_manual_items").insert({ name: m.name }).select().single();
          if (!error && data && legacyChecked.has(m.key)) checkedRows.push({ item_key: data.id });
        }
        for (const key of legacyChecked) {
          if (!key.startsWith("manual:")) checkedRows.push({ item_key: key }); // combined-item keys carry over as-is
        }
        if (checkedRows.length) await supabaseClient.from("grocery_checked_items").upsert(checkedRows, { onConflict: "user_id,item_key" });
        if (legacySkip != null || legacyAisle != null) {
          skipPantryStaples = !!legacySkip;
          aisleOrder = mergeAisleOrder(legacyAisle);
          await saveGroceryPrefs();
        }
        await loadGroceryList();
      } catch (e) { /* best-effort — the flag below still prevents retrying every load */ }
    }
    saveLocal("groceryMigratedV2", true);
    // These legacy keys are read once above and never written again — drop the
    // dead bytes now that grocery data lives in Supabase.
    ["basket", "manualItems", "checked", "skipStaples", "aisleOrder"].forEach((k) => {
      try { localStorage.removeItem(userKey(k)); } catch {}
    });
  }

  // Re-render every view that depends on data / filters / basket state.
  function refreshViews() {
    if (sortSelect.value !== sortMode) sortSelect.value = sortMode; // restore the saved order
    renderTagFilters();
    renderActiveFilters();
    renderList();
    renderGroceryCount();
    updateMealplanBadge();
    renderTonight();
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
    try {
      await loadDataInner();
    } catch (err) {
      console.error("loadData failed:", err);
      dataState = "error";
      renderList();
    }
  }

  async function loadDataInner() {
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
    // Grocery list needs to be ready as soon as the app loads (the grocery bar
    // shows a count on the main view), same urgency as inventory — unlike the
    // meal plan, which only loads lazily when its tab opens.
    const groceryPromise = loadGroceryList();
    const groceryPrefsPromise = loadMyGroceryPrefs();
    const krogerPrefsPromise = loadMyKrogerPrefs();
    // The meal plan used to load only when its tab was opened, which meant the
    // tab's badge was wrong until you went looking — and we now decide whether
    // to show that tab at all from this data, so it has to be here.
    const mealPlanPromise = loadMealPlan();
    const sharesPromise = supabaseClient
      .from("recipe_shares")
      .select("recipe_id, shared_with_user_id")
      .eq("shared_by_user_id", me);

    const { data, error } = await recipesPromise;

    if (error) {
      // These reads are still in flight and nothing is going to await them now;
      // mark them handled so a failure in one can't surface as an unhandled
      // rejection against the window.
      [profilesPromise, inventoryPromise, dietPrefsPromise, groceryPromise,
       groceryPrefsPromise, krogerPrefsPromise, mealPlanPromise, sharesPromise]
        .forEach((pr) => { if (pr && pr.catch) pr.catch(() => {}); });
      // Not the same thing as an empty book: renderList paints a failure state
      // with a Try again button rather than the first-run invitation.
      dataState = "error";
      renderList();
      return;
    }
    dataState = "ready";

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
    await groceryPromise;
    await groceryPrefsPromise;
    await krogerPrefsPromise;
    await mealPlanPromise;
    await migrateLegacyGroceryLocalStorage(); // one-time, no-ops after the first run

    // Note: we deliberately do NOT blanket-clear basket / activeTags / openItems
    // here, so adding/editing/deleting a recipe doesn't wipe the user's grocery
    // list, filters, or expanded rows. We only prune references that went stale.
    pruneStaleState();
    reconcileBatchServings();
    refreshViews();
    flushPendingChecks(); // no-op offline; otherwise sends any ticks made offline
  }

  // One-time heal for the serving-size fixes: a recipe that shouldn't scale to the
  // household (a batch/yield food like "1 tart", or a bar cocktail) but whose basket
  // servings was auto-defaulted to the household count is really making N of them.
  // Reset those to the recipe's base. Only touches entries that look auto-defaulted
  // (servings === household and ≠ base), never a count the user set on purpose.
  function reconcileBatchServings() {
    if (!householdServings) return;
    const fixes = [];
    basket.forEach((entry, id) => {
      const it = byId[id];
      if (!it || scalesToHousehold(it)) return;
      if (entry.servings === householdServings && householdServings !== it.baseServings) {
        entry.servings = it.baseServings;
        fixes.push({ recipe_id: id, servings: it.baseServings });
      }
    });
    if (fixes.length && session) {
      supabaseClient.from("grocery_basket_items")
        .upsert(fixes, { onConflict: "user_id,recipe_id" })
        .then(({ error }) => { if (error) console.error("batch-servings reconcile failed:", error); });
    }
  }

  function clearData() {
    dataState = "loading"; // so signing back in shows placeholders, not "no recipes yet"
    pendingChecks = {};
    // A signed-out device keeps no copy of anyone's recipes.
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({ type: "clear-data" });
    }
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
    pantryKeep.clear();          // in-memory only — localStorage survives for the next sign-in
    groceryView = "aisle";
    shoppingModeOn = false;
    manualGroceryItems = [];
    householdServings = null;
    aisleOrder = GROCERY_CATEGORY_ORDER.slice();
    seenPickHint = false;
    seenIntro = false;
    introCardEl.hidden = true;
    seenHomeTip = false;
    homeTipEl.hidden = true;
    planView = "dinners";
    inventory = [];
    collapsedInvCats = new Set();
    bottles.owned = new Map();
    bottlesInvalidate();
    if (bottlesView) { bottlesView.innerHTML = ""; delete bottlesView.dataset.built; }
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

  // ---------- Offline ----------
  // sw.js serves the app and the last-synced data with no connection; this half
  // keeps the page honest about it. Reads come from that copy. Grocery check-offs
  // — the one change worth making with no signal, standing in a store — are kept
  // and replayed when the connection returns; every other write needs a network
  // and says so through its usual "couldn't save" message.
  if ("serviceWorker" in navigator && window.isSecureContext) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch((err) => console.error("Service worker registration failed:", err));
    });
  }

  // supabase-js's own storage key for the session (sb-<project ref>-auth-token).
  // Never let a malformed URL stop the app from starting — offline open is a nicety.
  const AUTH_STORAGE_KEY = (() => {
    try { return `sb-${new URL(SUPABASE_URL).hostname.split(".")[0]}-auth-token`; } catch { return ""; }
  })();
  // The user of a session supabase-js still holds in storage, or null.
  function storedSessionUser() {
    try {
      const stored = AUTH_STORAGE_KEY ? JSON.parse(localStorage.getItem(AUTH_STORAGE_KEY) || "null") : null;
      if (!stored || !stored.refresh_token) return null;
      if (stored.user && stored.user.id) return stored.user;
      const claims = JSON.parse(atob(stored.access_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
      return claims.sub ? { id: claims.sub, email: claims.email || "" } : null;
    } catch { return null; }
  }

  function renderOfflineBanner() {
    offlineBannerEl.hidden = !(session && (session.offline || navigator.onLine === false));
  }
  window.addEventListener("offline", renderOfflineBanner);
  window.addEventListener("online", () => {
    renderOfflineBanner();
    if (!session) return;
    // An offline session has no live token yet: refreshing it fires
    // TOKEN_REFRESHED, which reloads the data (see initAuth).
    if (session.offline) { supabaseClient.auth.refreshSession().catch(() => {}); return; }
    loadData(); // fresh data, and loadData replays any queued check-offs
  });

  // Check-offs made offline: item key -> checked (the latest tap wins), kept
  // per user in localStorage until they reach the server.
  let pendingChecks = {};
  function isOfflineError(error) {
    return navigator.onLine === false ||
      /failed to fetch|load failed|networkerror|network request failed/i.test(String((error && error.message) || error || ""));
  }
  function queuePendingCheck(key, checked) {
    pendingChecks[key] = checked;
    saveLocal("pendingChecks", pendingChecks);
  }
  function applyPendingChecks() {
    Object.entries(pendingChecks).forEach(([key, checked]) => {
      if (checked) checkedGroceryItems.add(key); else checkedGroceryItems.delete(key);
    });
  }
  let flushingChecks = false;
  async function flushPendingChecks() {
    if (flushingChecks || !session || session.offline) return;
    const entries = Object.entries(pendingChecks);
    if (!entries.length) return;
    flushingChecks = true;
    try {
      for (const [key, checked] of entries) {
        const { error } = checked
          ? await supabaseClient.from("grocery_checked_items").upsert({ item_key: key }, { onConflict: "user_id,item_key" })
          : await supabaseClient.from("grocery_checked_items").delete().eq("item_key", key);
        if (error && isOfflineError(error)) break; // still no connection — keep the rest
        if (error) console.error("Dropping a queued check-off the server refused:", key, error.message);
        // Synced (or refused for good — the server's list wins on the next load).
        // A newer tap on the same item while this was in flight stays queued.
        if (pendingChecks[key] === checked) delete pendingChecks[key];
      }
      saveLocal("pendingChecks", pendingChecks);
    } finally {
      flushingChecks = false;
    }
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
      const wasOffline = !!(session && session.offline);
      // Opened with no connection after the access token expired (tokens last an
      // hour): supabase-js reports no session, but keeps the stored one — it only
      // deletes that on a real auth rejection. So a stored session here means
      // "offline", not "signed out": carry on read-only as that user while the
      // service worker serves their last-synced data. The real session replaces
      // this one as soon as a refresh gets through.
      if (!newSession && event === "INITIAL_SESSION") {
        const user = storedSessionUser();
        if (user) newSession = { user, offline: true };
      }
      session = newSession;
      updateAuthUI();
      renderOfflineBanner();
      if (session) {
        if (window.location.hash) history.replaceState(null, "", window.location.pathname + window.location.search);
        // TOKEN_REFRESHED fires roughly hourly — no need to refetch and
        // re-render everything when the same user's token rotates.
        const userChanged = session.user.id !== loadedUserId;
        loadedUserId = session.user.id;
        if (userChanged) loadUserLocalState();
        if (userChanged && event !== "PASSWORD_RECOVERY") setTimeout(maybeShowIntro, 0);
        // Coming back from an offline session, the first real token is the cue to
        // swap the cached copy for live data.
        if (userChanged || event !== "TOKEN_REFRESHED" || wasOffline) setTimeout(loadData, 0);
        // Returning from a Kroger "Connect King Soopers" login (?code=…&state=…).
        if (/[?&]code=/.test(window.location.search) && /[?&]state=/.test(window.location.search)) {
          setTimeout(handleKrogerOAuthReturn, 0);
        }
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
    renderKrogerPrefs();
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
    maybeShowHomeTip(); // the install tip follows the intro rather than stacking with it
    syncPickHint();
  });
  $("#home-tip-dismiss").addEventListener("click", () => {
    seenHomeTip = true;
    saveLocal("seenHomeTip", true);
    homeTipEl.hidden = true;
    syncPickHint();
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
  // Pantry asks for the item first and guesses its shelf the way the grocery
  // list guesses an aisle; the guess stays editable. (The bar keeps the spirit
  // first: there, the type is the thing and the brand is optional.)
  const PANTRY_FROM_AISLE = {
    "Frozen": "Frozen", "Meat & Seafood": "Frozen", "Canned & Jarred": "Canned & Jarred",
    "Dry Goods & Baking": "Dry Goods & Baking", "Condiments, Sauces & Spices": "Condiments, Sauces & Spices",
    "Beverages": "Beverages", "Alcohol": "Beverages"
  };
  function guessPantryCategory(name) {
    const n = normalizeItemName(name || "");
    if (!n) return null;
    return /\bfrozen\b/i.test(name) ? "Frozen" : PANTRY_FROM_AISLE[categorizeGrocery(n)] || OTHER_CATEGORY;
  }
  let invCatTouched = false; // a category picked by hand outranks the guess
  function renderInvAddForm() {
    const prev = invCategorySelect.value;
    const cats = invCategoriesFor(invSection);
    invCategorySelect.innerHTML = cats
      .map((c) => `<option value="${esc(c)}">${invSection === "bar" ? invCap(c) : esc(c)}</option>`).join("");
    if (cats.includes(prev)) invCategorySelect.value = prev;
    invNameInput.placeholder = invSection === "bar" ? "Brand (optional)" : "Item (e.g. olive oil)";
    invCategorySelect.setAttribute("aria-label", invSection === "bar" ? "Spirit" : "Shelf (guessed from the item)");
    invAddForm.classList.toggle("is-pantry", invSection === "pantry");
  }
  function renderInventoryPanel() {
    renderBottlesMine();
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
    // The bridge back to the generator: bar only — your spirits ARE the
    // cocktail's ingredients, so it's a natural one-tap handoff. Pantry
    // items don't map onto a recipe the same direct way, so no bridge there.
    const avail = items.filter((i) => i.status !== "out");
    invGenerateBtn.hidden = invSection !== "bar" || avail.length === 0;
    invGenerateBtn.textContent = "🪄 Generate a cocktail from your bar";
    // "Only what's out" — a restock view, so you can see everything to buy
    // without scrolling past what you already have.
    const outCount = items.filter((i) => i.status === "out").length;
    invOutFilterBtn.hidden = !items.length;
    invOutFilterBtn.disabled = outCount === 0 && !invOutOnly;
    invOutFilterBtn.textContent = `🛒 Only what's out${outCount ? ` · ${outCount}` : ""}`;
    invOutFilterBtn.setAttribute("aria-pressed", String(invOutOnly));
    if (!items.length) {
      inventoryContent.innerHTML = `<p class="inv-empty">Nothing here yet — add what you have on hand above.</p>`;
      return;
    }
    const shown = invOutOnly ? items.filter((i) => i.status === "out") : items;
    if (!shown.length) {
      inventoryContent.innerHTML = `<p class="inv-empty">Nothing's out — you're fully stocked.</p>`;
      return;
    }
    const groups = {};
    shown.forEach((i) => { (groups[i.category || "other"] || (groups[i.category || "other"] = [])).push(i); });
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
        const owned = i.section === "bar" && i.product_id ? bottles.owned.get(i.product_id) : null;
        const scoreChip = owned
          ? `<button type="button" class="inv-score" data-inv-score="${esc(i.product_id)}" aria-label="Expert score ${scoreText(owned.score_10)} out of 10 for ${esc(i.name || "")} — see where it comes from">${scoreText(owned.score_10)}</button>`
          : "";
        return `<li class="inv-row">
          <span class="inv-row-name">${label}</span>
          ${scoreChip}
          <span class="inv-status">${statusBtns}</span>
          ${restock}
          <button type="button" class="inv-remove" data-inv-remove="${i.id}" aria-label="Remove ${esc(label)}">×</button>
        </li>`;
      }).join("");
      const heading = esc(invSection === "bar" ? invCap(cat) : cat);
      // While filtering, always expand — a collapsed category would hide the very
      // out-of-stock rows the filter exists to surface.
      const collapsed = !invOutOnly && collapsedInvCats.has(invSection + ":" + cat);
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
    invOutOnly = false; // always open on the full list — a sticky filter reads as "my inventory vanished"
    renderInventoryPanel();
    inventoryPanel.hidden = false;
  }
  async function restockToGrocery(id) {
    const item = inventory.find((i) => i.id === id);
    if (!item) return;
    const name = invGroceryLabel(item);
    if (!name) return;
    // Exact (case-insensitive) match, not normalizeItemName: its "drop the part
    // after ' - '" rule (meant for prep notes like "olive oil — a splash") would
    // otherwise treat "Tequila - Cimmaron" and "Tequila - Don Julio" as the same
    // item and block the second brand from ever being added.
    if (manualGroceryItems.some((m) => m.name.toLowerCase() === name.toLowerCase())) { toast("Already on your grocery list."); return; }
    // sourceInventoryId records provenance — checking this item off later
    // auto-restocks it (see syncCheckedItem).
    const added = await addManualGroceryItem(name, id);
    if (added) toast(`Added ${name} to grocery list`);
  }
  openInventoryBtn.addEventListener("click", openInventoryPanel);
  closeInventoryBtn.addEventListener("click", () => (inventoryPanel.hidden = true));
  inventoryPanel.addEventListener("click", (e) => { if (e.target === inventoryPanel) inventoryPanel.hidden = true; });
  invTabBar.addEventListener("click", () => setInvSection("bar"));
  invTabPantry.addEventListener("click", () => setInvSection("pantry"));
  invOutFilterBtn.addEventListener("click", () => {
    invOutOnly = !invOutOnly;
    renderInventoryPanel();
  });
  invAddForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const category = invCategorySelect.value;
    const name = invNameInput.value.trim();
    if (invSection === "pantry" && !name) { toast("Type an item name."); return; }
    addInventoryItem({ section: invSection, category, name });
    invNameInput.value = "";
    invCatTouched = false;
    invNameInput.focus();
  });
  invNameInput.addEventListener("input", () => {
    if (invSection !== "pantry" || invCatTouched) return;
    const guess = guessPantryCategory(invNameInput.value);
    if (guess) invCategorySelect.value = guess;
  });
  invCategorySelect.addEventListener("change", () => { invCatTouched = true; });
  inventoryContent.addEventListener("click", (e) => {
    const scoreBtn = e.target.closest("[data-inv-score]");
    if (scoreBtn) { if (openBottlePanel()) { btToken++; btShowResult(scoreBtn.dataset.invScore, null, false); } return; }
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
  // The inventory -> generator bridge: bar only. Opens the generator in bar
  // mode (regardless of which main Kitchen/Bar tab is selected) and lets the
  // "From your bar" pick row choose which spirits to use — so you can generate
  // from just rum + campari instead of your whole shelf.
  invGenerateBtn.addEventListener("click", () => {
    const avail = inventory.filter((i) => i.section === "bar" && i.status !== "out");
    if (!avail.length) return;
    inventoryPanel.hidden = true;
    openGeneratePanel("bar");
  });


  // ---------- Bottles: the spirits ratings catalog ----------
  // Bar tab → Bottles. Look a bottle up by label photo (identify-bottle reads it)
  // or by name (free: normName + spirit_candidates), see its blended expert score
  // and every review behind it, or have research-bottle look it up on the web —
  // which saves what it finds to the shared catalog (README "Bottles").

  // ==== NORMALIZE: port of scripts/ratings/normalize.py ====
  // Same rules as the Python reference and research-bottle's copy, so a typed
  // name, a label read and a ratings.py import all land on one catalog key.
  // testing-skills/bottle_normalize_parity_test.py runs all three side by side.
  const NORM_FOLD = { "ø": "o", "Ø": "O", "æ": "ae", "Æ": "Ae", "œ": "oe", "Œ": "Oe", "ß": "ss", "ł": "l", "Ł": "L", "đ": "d", "Đ": "D", "þ": "th", "Þ": "Th", "ð": "d", "Ð": "D" };
  function stripMarks(text) {
    return String(text ?? "").normalize("NFKD").replace(/\p{M}/gu, "")
      .replace(/[øØæÆœŒßłŁđĐþÞðÐ]/g, (c) => NORM_FOLD[c]).replace(/[®™©]/g, "");
  }
  const NORM_ABBREV = [
    [/\by\.?\s?o\.?\b/g, "year old"],
    [/\byrs?\b/g, "year"],
    [/\byears?\s+old\b/g, "year old"],
    [/\byear\b(?!\s+old)/g, "year old"],
    [/\bb\.?i\.?b\.?\b/g, "bottled in bond"],
    [/\bs\.?i\.?b\.?\b/g, "single barrel"],
    [/\bcs\b/g, "cask strength"],
    [/\bst\b\.?/g, "saint"],
    [/&/g, " and "]
  ];
  function normName(text) {
    let t = stripMarks(text).toLowerCase();
    t = t.replace(/(\d)\s*(yo|y\.o\.|yr|yrs)\b/g, "$1 $2");
    for (const [re, rep] of NORM_ABBREV) t = t.replace(re, rep);
    t = t.replace(/['’`]/g, "");
    t = t.replace(/\b(?:[a-z]\.)+[a-z]\b\.?/g, (m) => m.replace(/\./g, ""));
    t = t.replace(/(?<!\d)\.|\.(?!\d)/g, " ");
    t = t.replace(/[^a-z0-9.%]+/g, " ");
    t = t.replace(/\b(the|kentucky straight|straight|whiskey|whisky|liqueur)\b/g, " ");
    t = t.replace(/\byear old year old\b/g, "year old");
    return t.replace(/\s+/g, " ").trim();
  }
  function parseAttrs(text) {
    const t = stripMarks(text).toLowerCase();
    const out = {
      age_years: null, abv: null, proof: null, batch: null,
      single_barrel: /single\s+barrel|\bsib\b/.test(t),
      store_pick: /store pick|selected by|private (barrel|selection)/.test(t)
    };
    let m = t.match(/\b(\d{1,2})\s*(?:-|\s)?(?:years?\s*old|years?|yrs?|y\.?o\.?)\b/);
    if (m) out.age_years = parseInt(m[1], 10);
    m = t.match(/(\d{2}(?:\.\d{1,2})?)\s*%\s*(?:abv|alc|vol)?/);
    if (m) out.abv = parseFloat(m[1]);
    m = t.match(/\b(\d{2,3}(?:\.\d)?)\s*proof\b/);
    if (m) {
      out.proof = parseFloat(m[1]);
      if (out.abv === null) out.abv = Math.round((out.proof / 2) * 100) / 100;
    }
    m = t.match(/\bbatch\s*(?:no\.?|#)?\s*([a-z]?\d[\w-]*)/) || t.match(/\b([abc]\d{3})\b/);
    if (m) out.batch = m[1].toUpperCase();
    return out;
  }
  function attrsCompatible(a, b) {
    if (a.age_years != null && b.age_years != null && a.age_years !== b.age_years) return false;
    if (a.abv != null && b.abv != null && Math.abs(a.abv - b.abv) > 0.3) return false;
    if (a.batch && b.batch && a.batch !== b.batch) return false;
    return true;
  }
  const GENERIC_BOTTLE_WORDS = ["single malt scotch", "single malt", "single village", "london dry", "blended scotch",
    "kentucky", "tennessee", "american", "irish", "canadian", "japanese", "scotch", "bourbon",
    "gin", "rum", "rhum", "tequila", "vodka", "mezcal", "brandy", "cognac", "amaro", "spirits",
    "distillery", "distilling", "company", "co", "and", "of"];
  const GENERIC_BOTTLE_RE = new RegExp("\\b(" + GENERIC_BOTTLE_WORDS.map((g) => g.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")\\b", "g");
  function bottleWords(key) {
    return new Set(String(key || "").replace(GENERIC_BOTTLE_RE, " ").split(/\s+/).filter(Boolean));
  }
  // A spirit type both names state has to agree ("Cutwater Gin" ≠ "Cutwater
  // Vodka"); rum/rhum and brandy/cognac are one type each.
  const TYPE_GROUPS = { gin: "gin", vodka: "vodka", rum: "rum", rhum: "rum", tequila: "tequila", mezcal: "mezcal",
    brandy: "brandy", cognac: "brandy", bourbon: "bourbon", scotch: "scotch", tennessee: "tennessee" };
  function spiritTypes(key) {
    return new Set(String(key || "").split(/\s+/).filter((w) => TYPE_GROUPS[w]).map((w) => TYPE_GROUPS[w]));
  }
  function sameBottle(keyA, keyB) {
    const a = bottleWords(keyA), b = bottleWords(keyB);
    if (!(a.size > 0 && a.size === b.size && [...a].every((w) => b.has(w)))) return false;
    const ta = spiritTypes(keyA), tb = spiritTypes(keyB);
    return !(ta.size && tb.size && ![...ta].some((t) => tb.has(t)));
  }
  // ==== END NORMALIZE ====

  const BT_LOOKUP_LIMIT = 20;   // KEEP IN SYNC with research-bottle DAILY_LOOKUP_LIMIT
  const BT_FILTERS = [
    ["all", "All", null], ["whiskey", "Whiskey", ["whiskey", "bourbon", "rye", "scotch"]],
    ["rum", "Rum", ["rum"]], ["agave", "Agave", ["tequila", "mezcal"]], ["gin", "Gin", ["gin"]],
    ["liqueur", "Liqueur", ["liqueur"]], ["amaro", "Amaro", ["amaro"]]
  ];
  const bottles = { filter: "all", list: null, best: new Map(), total: null, owned: new Map(), sources: null, linkTried: new Set() };
  const pendingLookups = new Map();          // lookup id -> what was being looked up
  let btToken = 0;                           // bumped on close / new action: stale replies are ignored
  let btScreen = { name: "start", lookupId: null };

  const scoreText = (n) => (n == null ? "" : Number(n).toFixed(1));
  const CONF_LABEL = { high: "High confidence", medium: "Medium confidence", low: "Low confidence" };
  const utcDay = () => new Date().toISOString().slice(0, 10);

  function bottlesInvalidate() { bottles.best.clear(); bottles.total = null; }

  // Scores for a handful of bottles (candidates, owned bottles), keyed by product id.
  async function btScoresFor(ids) {
    const want = [...new Set(ids.filter(Boolean))];
    const out = new Map();
    for (let i = 0; i < want.length; i += 100) {
      const { data, error } = await supabaseClient.from("spirit_consensus")
        .select("product_id,canonical_name,category,n_reviews,n_sources,score_10,confidence")
        .in("product_id", want.slice(i, i + 100));
      if (error) { console.error("Couldn't load bottle scores:", error.message); continue; }
      (data || []).forEach((r) => out.set(r.product_id, r));
    }
    return out;
  }
  async function btSources() {
    if (bottles.sources) return bottles.sources;
    const { data } = await supabaseClient.from("rating_sources").select("id,name,scale");
    bottles.sources = new Map((data || []).map((s) => [s.id, s]));
    return bottles.sources;
  }
  // Bar bottles linked to the catalog get their score beside them in Bar & Pantry.
  async function loadOwnedScores() {
    const ids = inventory.filter((i) => i.section === "bar" && i.product_id).map((i) => i.product_id);
    if (!ids.length) { bottles.owned = new Map(); renderBottlesMine(); return; }
    bottles.owned = await btScoresFor(ids);
    if (!inventoryPanel.hidden) renderInventoryPanel();
    renderBottlesMine();
  }
  const ownedProduct = (pid) => inventory.some((i) => i.section === "bar" && i.product_id === pid);

  // A bar bottle added by hand gets linked to its catalog entry when the name
  // is a clear match, so its score shows up without anyone doing anything.
  async function linkInventoryToCatalog(item) {
    if (!item || item.section !== "bar" || !item.name || item.product_id) return;
    const key = normName(item.name);
    if (!key) return;
    const { data, error } = await supabaseClient.rpc("spirit_candidates", { q: key, max_results: 5 });
    if (error || !data) return;
    const hits = data.filter((c) => Number(c.score) >= 0.99 || sameBottle(key, normName(c.canonical_name)));
    if (hits.length !== 1) return;
    const pid = hits[0].product_id;
    const { error: upErr } = await supabaseClient.from("inventory_items").update({ product_id: pid }).eq("id", item.id);
    if (upErr) return;
    item.product_id = pid;
    loadOwnedScores();
  }

  // ---- The Bottles view ----
  function renderBottlesView() {
    if (!bottlesView.dataset.built) {
      // In a store aisle the list used to start 500px down, under a button, a
      // second search field, a switch and two rows of chips. Now: one field
      // (type, or tap the camera inside it), one scrolling row of chips, and the
      // list's own heading is the Your bottles | Best rated switch.
      bottlesView.innerHTML = `
        <form id="bt-view-search" class="bt-one-search" role="search">
          <input id="bt-view-q" class="bt-one-q" type="search" placeholder="Search or scan a bottle" aria-label="Search for a bottle by name" autocomplete="off" enterkeyhint="search">
          <button type="button" id="bt-open" class="bt-cam" aria-label="Scan a label with the camera">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"></path><circle cx="12" cy="13" r="3.5"></circle></svg>
          </button>
        </form>
        <div class="bt-filter" role="group" aria-label="Category">
          ${BT_FILTERS.map(([id, label]) => `<button type="button" class="bt-chip" data-bt-filter="${id}" aria-pressed="false">${label}</button>`).join("")}
        </div>
        <div class="bt-best-head">
          <h2 class="sr-only" id="bt-list-title">Best rated</h2>
          <div class="bt-lists" role="group" aria-label="Which bottles">
            <button type="button" class="bt-list-tab" data-bt-list="mine" aria-pressed="false">Your bottles</button>
            <button type="button" class="bt-list-tab" data-bt-list="best" aria-pressed="false">Best rated</button>
          </div>
          <span id="bt-total" class="bt-total"></span>
        </div>
        <ul id="bt-mine" class="bt-list" aria-live="polite" hidden></ul>
        <p class="bt-foot" id="bt-mine-foot" hidden>Your bar bottles from Bar &amp; Pantry, best score first; the ones you’re out of are last, a tap from the grocery list. Tap a bottle for its reviews.</p>
        <ul id="bt-best" class="bt-list" aria-live="polite"></ul>
        <p class="bt-foot" id="bt-best-foot">Ranked by score and by how many reviews back it up. Listed: bottles with a critic’s review or three or more competition results. Any bottle’s score shows when you look it up.</p>`;
      bottlesView.dataset.built = "1";
    }
    if (!bottles.list) bottles.list = loadLocal("bottleList", "mine") === "best" ? "best" : "mine";
    const mine = bottles.list === "mine";
    bottlesView.querySelectorAll("[data-bt-filter]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.btFilter === bottles.filter)));
    bottlesView.querySelectorAll("[data-bt-list]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.btList === bottles.list)));
    $("#bt-list-title").textContent = mine ? "Your bottles" : "Best rated";
    $("#bt-mine").hidden = !mine; $("#bt-mine-foot").hidden = !mine;
    $("#bt-best").hidden = mine; $("#bt-best-foot").hidden = mine;
    if (mine) renderBottlesMine(); else renderBottlesBest();
  }
  // Your bottles: the bar's bottles (not mixers), scored ones first and the
  // ones you're out of last, each with "+ List" so the restock is one tap.
  // All local — the scores come from loadOwnedScores; nothing is fetched here.
  function renderBottlesMine() {
    const listEl3 = $("#bt-mine");
    if (!listEl3 || bottlesView.hidden || bottles.list !== "mine") return;
    const cats = (BT_FILTERS.find((f) => f[0] === bottles.filter) || [])[2];
    const bar = inventory.filter((i) => i.section === "bar" && i.name && i.category !== "mixer");
    const rows = bar.filter((i) => !cats || cats.includes(i.category))
      .map((i) => ({ item: i, s: (i.product_id && bottles.owned.get(i.product_id)) || null }))
      .sort((a, b) => ((a.item.status === "out") - (b.item.status === "out")) ||
        ((b.s ? Number(b.s.score_10) : -1) - (a.s ? Number(a.s.score_10) : -1)) || a.item.name.localeCompare(b.item.name));
    const scored = rows.filter((r) => r.s).length;
    $("#bt-total").textContent = rows.length ? `${rows.length} bottle${rows.length === 1 ? "" : "s"} · ${scored} scored` : "";
    listEl3.innerHTML = rows.length ? rows.map(btMineRowHtml).join("")
      : `<li class="bt-empty">${bar.length ? "None of your bottles in this category." : "No bottles on your bar yet — add one from a score card, or in Bar &amp; Pantry."}</li>`;
  }
  const reviewsWord = (n) => `based on ${n} review${n === 1 ? "" : "s"}`;
  // Already on the grocery list as this bottle's restock?
  const restockListed = (item) => manualGroceryItems.some((m) => m.sourceInventoryId === item.id);
  function btRestockBtnHtml(item) {
    const on = restockListed(item);
    return `<button type="button" class="list-btn bt-restock${on ? " is-on" : ""}" data-bt-restock="${esc(item.id)}" aria-pressed="${on}"${on ? " disabled" : ""}>` +
      `${on ? "\u2713 On list" : "+ List"}<span class="sr-only">: ${esc(item.name)}</span></button>`;
  }
  function btMineRowHtml({ item, s }) {
    const cat = invCap(item.category || "other");
    const out = item.status === "out";
    const restock = out ? btRestockBtnHtml(item) : "";
    if (s) {
      const meta = [cat, out ? "out" : reviewsWord(s.n_reviews)].join(" · ");
      return `<li class="bt-mine-li${out ? " is-out" : ""}"><button type="button" class="bt-row" data-bt-product="${esc(item.product_id)}">
        <span class="bt-score" aria-hidden="true">${scoreText(s.score_10)}</span>
        <span class="bt-row-main"><span class="bt-row-name">${esc(item.name)}</span><span class="bt-row-meta">${esc(meta)}</span></span>
        <span class="sr-only">Score ${scoreText(s.score_10)} out of 10</span>
      </button>${restock}</li>`;
    }
    // In the catalog with no reviews yet → its card (which offers a lookup);
    // not in the catalog → a free catalog search for the name.
    const attr = item.product_id ? `data-bt-product="${esc(item.product_id)}"` : `data-bt-find="${esc(item.name)}"`;
    const meta = out ? `${cat} · out`
      : item.product_id ? `${cat} · No scores yet` : `${cat} · Not in the catalog yet — tap to look it up`;
    return `<li class="bt-mine-li${out ? " is-out" : ""}"><button type="button" class="bt-row" ${attr}>
      <span class="bt-score is-none" aria-hidden="true">–</span>
      <span class="bt-row-main"><span class="bt-row-name">${esc(item.name)}</span><span class="bt-row-meta">${esc(meta)}</span></span>
    </button>${restock}</li>`;
  }
  async function renderBottlesBest() {
    const listEl2 = $("#bt-best");
    const totalEl = $("#bt-total");
    if (!listEl2) return;
    const filter = bottles.filter;
    if (!bottles.best.has(filter)) {
      listEl2.innerHTML = `<li class="bt-empty">Loading…</li>`;
      const cats = (BT_FILTERS.find((f) => f[0] === filter) || [])[2];
      // Medium or high confidence only: a bottle known from one competition medal
      // (half weight) would otherwise tie a well-reviewed bottle, and there are
      // hundreds of them. They still have a score when looked up, and join the
      // list once a lookup adds a review.
      let query = supabaseClient.from("spirit_consensus")
        .select("product_id,canonical_name,category,n_reviews,n_sources,score_10,confidence,rank_score")
        .in("confidence", ["medium", "high"])
        .order("rank_score", { ascending: false }).limit(60);
      if (cats) query = query.in("category", cats);
      const { data, error } = await query;
      if (error) {
        console.error("Couldn't load the bottle catalog:", error.message);
        if (filter === bottles.filter) listEl2.innerHTML = `<li class="bt-empty">Couldn’t load the catalog — check your connection and try again.</li>`;
        return;
      }
      bottles.best.set(filter, data || []);
    }
    if (bottles.total == null) {
      const { count } = await supabaseClient.from("spirit_consensus").select("product_id", { count: "exact", head: true });
      bottles.total = count ?? null;
    }
    if (filter !== bottles.filter || bottles.list !== "best") return;    // the filter or list changed while loading
    if (totalEl) totalEl.textContent = bottles.total != null ? `${bottles.total.toLocaleString()} bottles scored` : "";
    const rows = bottles.best.get(filter);
    listEl2.innerHTML = rows.length ? rows.map(btRowHtml).join("")
      : `<li class="bt-empty">No well-reviewed bottles here yet — look one up to add its reviews.</li>`;
  }
  function btRowHtml(r) {
    const meta = [invCap(r.category || "other"), reviewsWord(r.n_reviews)].join(" · ");
    return `<li><button type="button" class="bt-row" data-bt-product="${esc(r.product_id)}">
      <span class="bt-score" aria-hidden="true">${scoreText(r.score_10)}</span>
      <span class="bt-row-main"><span class="bt-row-name">${esc(r.canonical_name)}</span><span class="bt-row-meta">${esc(meta)}</span></span>
      ${ownedProduct(r.product_id) ? `<span class="bt-own">In your bar</span>` : ""}
      <span class="sr-only">Score ${scoreText(r.score_10)} out of 10</span>
    </button></li>`;
  }

  // ---- The lookup sheet ----
  function openBottlePanel() {
    if (!session) { toast("Sign in to look up bottles."); return false; }
    bottlePanel.hidden = false;
    return true;
  }
  function closeBottlePanel() {
    btToken++;
    if (!btAddPanel.hidden) closeBtAdd(null);   // a pending add is cancelled, never left hanging
    bottlePanel.hidden = true;
  }
  function btSet(name, html, extra) {
    btScreen = { name, lookupId: null, ...(extra || {}) };
    bottleBody.innerHTML = html;
  }
  function btRecent() { return loadLocal("bottleRecent", []).filter((r) => r && r.id && r.name); }
  function btRemember(id, name) {
    saveLocal("bottleRecent", [{ id, name }, ...btRecent().filter((r) => r.id !== id)].slice(0, 5));
  }
  function renderBtStart(message) {
    bottleTitle.textContent = "Look up a bottle";
    const recent = btRecent();
    btSet("start", `
      <button type="button" class="bt-photo-target" data-bt="camera">
        <span class="bt-photo-icon" aria-hidden="true">📷</span>
        <span class="bt-photo-title">Photograph the label</span>
        <span class="bt-photo-hint">Front label, straight on, so the name, age and proof can be read.</span>
      </button>
      <button type="button" class="ghost-btn bt-wide" data-bt="pick">Choose a photo instead</button>
      ${message ? `<p class="bt-msg" role="alert">${esc(message)}</p>` : ""}
      <div class="bt-or"><span>or type it</span></div>
      <form class="bt-search" data-bt-form>
        <input class="search" type="search" name="q" placeholder="e.g. Buffalo Trace" aria-label="Bottle name" autocomplete="off" required>
        <button type="submit" class="solid-btn">Search</button>
      </form>
      <p class="bt-note">Snap the label or type the name. A bottle whose reviews haven’t been checked this week gets a fresh look.</p>
      ${recent.length ? `<h3 class="bt-sub">Recent</h3><ul class="bt-list">${recent.map((r) =>
        `<li><button type="button" class="bt-row bt-row-compact" data-bt-product="${esc(r.id)}"><span class="bt-row-main"><span class="bt-row-name">${esc(r.name)}</span></span></button></li>`).join("")}</ul>` : ""}`);
  }
  function renderBtBusy(text) {
    btSet("busy", `<div class="bt-busy" role="status"><span class="spinner" aria-hidden="true"></span><span>${esc(text)}</span></div>`);
  }

  // What we know about the bottle being looked up: the label's facts if it was
  // photographed, else whatever the typed name says (age, proof, batch).
  function btWant(ctx) {
    const p = parseAttrs(ctx.text);
    const l = ctx.label || {};
    return { age_years: l.age_years ?? p.age_years, abv: l.abv ?? p.abv, batch: l.batch ?? p.batch };
  }
  async function btFromPhoto(file) {
    if (!file) return;
    if (!openBottlePanel()) return;
    const token = ++btToken;
    renderBtBusy("Reading the label…");
    let image;
    try { image = await processImage(file); } catch (e) { renderBtStart(e.message); return; }
    const { data, error } = await supabaseClient.functions.invoke("identify-bottle", { body: { image, media_type: "image/jpeg" } })
      .catch((err) => ({ error: err }));
    if (token !== btToken || bottlePanel.hidden) return;
    if (error || data?.error || !data?.label) { renderBtStart(aiErrorText(data, error)); return; }
    data.label.misread = labelMisread(data.label);
    btMatch({ text: data.label.full_name, label: data.label, fromPhoto: true }, token);
  }
  // The label reader transcribes the printed words and builds a name from them;
  // a name using words that aren't on the label ("Barbancourt" off a label that
  // says BANKS) is a misread — the person checks it before anything is spent.
  // Age wording varies ("12 YEARS" printed, "12 Year Old" named) and a plural
  // or a clipped word still counts — what's caught is a word that isn't there.
  const LABEL_FILLER = new Set(["year", "years", "old", "aged", "age", "yo", "no", "brand"]);
  function labelMisread(label) {
    if (!label || !label.printed_words) return false;
    const printed = normName(label.printed_words).split(" ").filter(Boolean);
    const onLabel = (w) => printed.some((p) => p === w ||
      (w.length >= 4 && p.length >= 4 && (p.startsWith(w) || w.startsWith(p))));
    return [...bottleWords(normName(label.full_name))].some((w) => !LABEL_FILLER.has(w) && !onLabel(w));
  }
  function btFromText(text) {
    const q = String(text || "").trim();
    if (q.length < 2) return;
    if (bottlePanel.hidden && !openBottlePanel()) return;
    btMatch({ text: q, label: null, fromPhoto: false }, ++btToken);
  }
  async function btMatch(ctx, token) {
    renderBtBusy("Searching the catalog…");
    const key = normName(ctx.text);
    const { data, error } = await supabaseClient.rpc("spirit_candidates", { q: key, max_results: 6 });
    if (token !== btToken || bottlePanel.hidden) return;
    if (error) { renderBtStart("Couldn’t search the catalog — check your connection and try again."); return; }
    const want = btWant(ctx);
    const cands = (data || []).filter((c) => attrsCompatible(want, { age_years: c.age_years, abv: c.abv != null ? Number(c.abv) : null, batch: c.batch }));
    const scores = await btScoresFor(cands.map((c) => c.product_id));
    if (token !== btToken || bottlePanel.hidden) return;
    ctx.cands = cands.map((c) => ({ ...c, consensus: scores.get(c.product_id) || null }));
    // Straight to the score card only on a sure match: an exact alias, or the
    // same distinguishing words ("Elijah Craig Small Batch Bourbon" = "… Small
    // Batch", but "Reposado" ≠ "Plata").
    const sure = ctx.cands.filter((c) => Number(c.score) >= 0.99 || sameBottle(key, normName(c.canonical_name)));
    if (sure.length === 1 && !(ctx.label && ctx.label.misread)) { btShowResult(sure[0].product_id, ctx, false, { verify: true }); return; }
    if (ctx.cands.length) { renderBtMatch(ctx); return; }
    renderBtLookup(ctx);
  }
  function btLabelCard(ctx) {
    const l = ctx.label;
    if (!l) return `<div class="bt-label-card"><span class="bt-kicker">You searched</span><span class="bt-label-name">${esc(ctx.text)}</span></div>`;
    const facts = [invCap(l.category && l.category !== "other" ? l.category : ""), l.country, l.age_years ? `${l.age_years} years` : "",
      l.abv ? `${scoreText(l.abv).replace(/\.0$/, "")}% ABV` : "", l.batch ? `batch ${l.batch}` : ""].filter(Boolean).join(" · ");
    return `<div class="bt-label-card${l.misread ? " is-misread" : ""}"><span class="bt-kicker">The label reads</span><span class="bt-label-name">${esc(l.full_name)}</span>${facts ? `<span class="bt-label-facts">${esc(facts)}</span>` : ""}
      ${l.misread ? `<p class="bt-msg" role="alert">The label’s printed words — “${esc(l.printed_words)}” — don’t match that name. Fix it below before looking it up.</p>` : ""}
      <details class="bt-fix"${l.misread ? " open" : ""}><summary>${l.misread ? "Fix the name" : "Not right? Fix the name"}</summary>
        <form class="bt-search" data-bt-fix>
          <input class="search" type="text" name="q" value="${esc(l.full_name)}" aria-label="Bottle name" autocomplete="off" required>
          <button type="submit" class="solid-btn">Search</button>
        </form>
      </details></div>`;
  }
  function renderBtMatch(ctx) {
    bottleTitle.textContent = "Which one is it?";
    btSet("match", `
      ${btLabelCard(ctx)}
      <ul class="bt-cands">${ctx.cands.map((c, i) => {
        const s = c.consensus;
        const meta = s ? `${s.n_reviews} review${s.n_reviews === 1 ? "" : "s"}${ownedProduct(c.product_id) ? " · in your bar" : ""}`
          : `No scores yet${ownedProduct(c.product_id) ? " · in your bar" : ""}`;
        return `<li><button type="button" class="bt-cand" data-bt-pick="${i}">
          <span class="bt-score${s ? "" : " is-none"}" aria-hidden="true">${s ? scoreText(s.score_10) : "–"}</span>
          <span class="bt-row-main"><span class="bt-row-name">${esc(c.canonical_name)}</span><span class="bt-row-meta">${esc(meta)}</span></span>
        </button></li>`;
      }).join("")}</ul>
      <button type="button" class="ghost-btn bt-wide bt-accent" data-bt="neither">Neither — look this bottle up</button>`, { ctx });
  }

  // opts.verify: a lookup landed here — show the score now, then check it is
  // still current (research-bottle, skipped server-side if checked this week).
  // opts.status: a line to show where the check status goes.
  async function btShowResult(pid, ctx, picked, opts) {
    opts = opts || {};
    const token = btToken;
    if (picked && ctx) {
      // The person said which bottle this label is: remember that spelling.
      const key = normName(ctx.text);
      if (key) supabaseClient.rpc("spirit_confirm_alias", { p_product: pid, p_alias_norm: key }).then(({ error }) => {
        if (error) console.error("Couldn't save the label's spelling:", error.message);
      });
    }
    renderBtBusy("Loading the score…");
    const [prodRes, consRes, revRes, sources] = await Promise.all([
      supabaseClient.from("spirit_products").select("id,canonical_name,category,producer,country,age_years,abv,researched_at").eq("id", pid).maybeSingle(),
      supabaseClient.from("spirit_consensus").select("product_id,n_reviews,n_sources,score_10,confidence").eq("product_id", pid).maybeSingle(),
      supabaseClient.from("spirit_reviews").select("id,source_id,score_raw,score_10,medal,review_year,url,reviewer,origin,verified").eq("product_id", pid),
      btSources()
    ]);
    if (token !== btToken || bottlePanel.hidden) return;
    const prod = prodRes.data;
    if (prodRes.error || !prod) { renderBtStart("Couldn’t load that bottle — try again."); return; }
    btRemember(prod.id, prod.canonical_name);
    renderBtResult(prod, consRes.data || null, revRes.data || [], sources, ctx, opts);
    if (opts.verify && consRes.data) btVerify(prod, ctx);
  }
  function btAgo(iso) {
    if (!iso) return "";
    const days = Math.floor((Date.now() - Date.parse(iso)) / 864e5);
    if (days <= 0) return "today";
    if (days === 1) return "yesterday";
    if (days < 30) return `${days} days ago`;
    return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }
  const btShowing = (pid) => !bottlePanel.hidden && btScreen.name === "result" && btScreen.prod && btScreen.prod.id === pid;
  function btCheckLine(pid, html) {
    if (!btShowing(pid)) return;
    const el = $("#bt-check");
    if (el) el.innerHTML = html;
  }
  // The check behind every lookup of a known bottle: are the scores still what
  // their pages say, and is there anything new? The card updates in place.
  async function btVerify(prod, ctx) {
    const pid = prod.id;
    const name = prod.canonical_name;
    btCheckLine(pid, `<span class="spinner" aria-hidden="true"></span> Checking for newer reviews…`);
    const body = { name, product_id: pid, label: (ctx && ctx.label) || {} };
    const { data, error } = await supabaseClient.functions.invoke("research-bottle", { body }).catch((err) => ({ error: err }));
    if (error || data?.error) { btCheckLine(pid, `Couldn’t check for newer reviews: ${esc(aiErrorText(data, error))}`); return; }
    if (data.status === "fresh") { btCheckLine(pid, `Up to date — reviews checked ${esc(btAgo(data.checked_at))}.`); return; }
    if (data.status !== "running" || !data.lookup_id) { btCheckLine(pid, "Couldn’t check for newer reviews right now."); return; }
    watchLookup(data.lookup_id, ctx, (row) => {
      bottlesInvalidate();
      if (viewMode === "bottles") renderBottlesBest();
      if (ownedProduct(pid)) loadOwnedScores();
      const n = row.added || 0;
      if (row.status !== "found") { btCheckLine(pid, "The check didn’t finish — try again later."); return; }
      const status = n ? `Updated — ${n} new review${n === 1 ? "" : "s"} found just now.` : "Up to date — checked just now.";
      if (btShowing(pid)) { btToken++; btShowResult(pid, ctx, false, { status }); }
      else if (n) toast(`${name}: ${n} new review${n === 1 ? "" : "s"} added.`);
    });
  }
  function btReviewDetail(r, src) {
    const raw = r.score_raw != null ? Number(r.score_raw) : null;
    const scale = src ? src.scale : "";
    let what = r.medal || "";
    if (!what && raw != null) {
      if (scale === "drinkhacker" || (scale === "ten" && raw <= 10)) what = `${raw}/10`;
      else if (scale === "stars5") what = `${raw} of 5 stars`;
      else if (scale === "barrels5") what = `${raw} of 5 barrels`;
      else what = `${raw} points`;
    }
    return [what, r.review_year].filter(Boolean).join(" · ");
  }
  function renderBtResult(prod, cons, reviews, sources, ctx, opts) {
    opts = opts || {};
    bottleTitle.textContent = "Expert score";
    const checkLine = !cons ? (opts.status ? `<p class="bt-check" id="bt-check">${esc(opts.status)}</p>` : "")
      : opts.status ? `<p class="bt-check" id="bt-check" role="status">${esc(opts.status)}</p>`
      : opts.verify ? `<p class="bt-check" id="bt-check" role="status"><span class="spinner" aria-hidden="true"></span> Checking for newer reviews…</p>`
      : `<p class="bt-check" id="bt-check">Last checked: ${prod.researched_at ? esc(btAgo(prod.researched_at)) : "never"}.
          <button type="button" class="link-inline" data-bt="verify">Check for newer reviews</button></p>`;
    const facts = [invCap(prod.category && prod.category !== "other" ? prod.category : ""), prod.producer,
      prod.age_years ? `${prod.age_years} years` : "", prod.abv ? `${Number(prod.abv).toString()}% ABV` : ""].filter(Boolean).join(" · ");
    const owned = ownedProduct(prod.id);
    const outItem = owned ? inventory.find((i) => i.section === "bar" && i.product_id === prod.id && i.status === "out") : null;
    const makes = barRecipesFor(prod);
    const sorted = reviews.slice().sort((a, b) => (b.review_year || 0) - (a.review_year || 0) || Number(b.score_10) - Number(a.score_10));
    const anyField = reviews.some((r) => r.origin === "field" && !r.verified);
    const scoreBlock = cons
      ? `<div class="bt-scorecard">
          <span class="bt-big"><span class="bt-big-num">${scoreText(cons.score_10)}</span><span class="bt-big-of">/10</span></span>
          <span class="bt-score-side">
            <span class="bt-conf is-${esc(cons.confidence)}">${CONF_LABEL[cons.confidence] || ""}</span>
            <span class="bt-score-why">Based on ${cons.n_reviews} review${cons.n_reviews === 1 ? "" : "s"} from ${cons.n_sources} source${cons.n_sources === 1 ? "" : "s"}.</span>
          </span>
        </div>`
      : `<div class="bt-scorecard is-empty">
          <span class="bt-score-why"><b>No expert scores yet.</b> A lookup searches critic reviews and competition results and saves what it finds.</span>
          <button type="button" class="solid-btn bt-wide" data-bt="research-product">Look it up</button>
        </div>`;
    btSet("result", `
      <div class="bt-result-head">
        <h3 class="bt-result-name">${esc(prod.canonical_name)}</h3>
        ${facts ? `<span class="bt-result-facts">${esc(facts)}</span>` : ""}
      </div>
      ${scoreBlock}
      ${checkLine}
      <div class="bt-actions">
        ${outItem ? (restockListed(outItem) ? `<span class="bt-owned">Out \u00B7 \u2713 on your grocery list</span>`
            : `<button type="button" class="solid-btn" data-bt="restock">Out? Add to grocery list</button>`)
          : owned ? `<span class="bt-owned">✓ In your bar</span>` : `<button type="button" class="solid-btn bt-add-btn" data-bt="add">＋ Add to my bar</button>`}
        <button type="button" class="ghost-btn" data-bt="again">Look up another</button>
      </div>
      ${makes.length ? `<div class="bt-makes"><span class="bt-makes-label">Make with it:</span>${makes.map((r) =>
        `<button type="button" class="bt-make-chip" data-bt-make="${esc(r.id)}">${esc(r.name)}</button>`).join("")}</div>` : ""}
      ${sorted.length ? `<h3 class="bt-sub">Where the score comes from</h3>
      <ul class="bt-sources">${sorted.map((r) => {
        const src = sources.get(r.source_id);
        const name = r.source_id.startsWith("other_") && r.reviewer ? r.reviewer : (src ? src.name : r.source_id);
        const tag = r.origin === "field" && !r.verified ? `<span class="bt-tag" title="Found by an in-app lookup; counts ¾ until confirmed">AI-found</span>` : "";
        const inner = `<span class="bt-row-main"><span class="bt-src-name">${esc(name)} ${tag}</span><span class="bt-row-meta">${esc(btReviewDetail(r, src))}</span></span>
          <span class="bt-src-ten">${scoreText(r.score_10)}</span>`;
        return `<li>${r.url ? `<a class="bt-src" href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${inner}<span class="bt-src-go" aria-hidden="true">↗</span></a>` : `<span class="bt-src">${inner}</span>`}</li>`;
      }).join("")}</ul>
      <p class="bt-note">Every review is put on the same 10-point scale. A competition medal counts for less than a critic’s review, and older reviews count less.${anyField ? " Scores an in-app lookup found count a little less until they’re confirmed." : ""}</p>` : ""}
      <button type="button" class="link-inline bt-report" data-bt="report">Wrong bottle?</button>`, { prod, ctx });
  }

  // "Make with it": your cocktails that call for this bottle — by its name
  // ("Green Chartreuse" → Last Word) or, for a base spirit, by its type
  // ("white rum" → Daiquiri). A generic liqueur or amaro only matches by name,
  // or every "orange liqueur" drink would claim every liqueur.
  const BT_MAKE_TERMS = {
    gin: ["gin"], vodka: ["vodka"], rum: ["rum"], tequila: ["tequila"], mezcal: ["mezcal"],
    whiskey: ["whiskey", "whisky", "bourbon", "rye"], bourbon: ["bourbon", "whiskey", "whisky"],
    rye: ["rye", "whiskey", "whisky"], scotch: ["scotch"], brandy: ["brandy", "cognac", "armagnac"]
  };
  function barRecipesFor(prod) {
    const name = normName(prod.canonical_name || "");
    const words = name.split(" ").filter(Boolean);
    const short = words.length > 2 ? words.slice(0, 2).join(" ") : "";
    const terms = BT_MAKE_TERMS[prod.category] || [];
    const typeRe = terms.length ? new RegExp(`\\b(?:${terms.join("|")})\\b`, "i") : null;
    const hits = [];
    [...DATA.cocktails, ...DATA.sharedCocktails].forEach((it) => {
      const items = (it.ingredients || []).map((i) => normName(i.item || ""));
      const byName = name && items.some((x) => x.includes(name) || (short && x.includes(short)));
      const byType = !byName && typeRe && items.some((x) => typeRe.test(x));
      if (byName || byType) hits.push({ id: it.id, name: it.name, rank: byName ? 0 : 1 });
    });
    return hits.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name)).slice(0, 4);
  }

  async function btLookupsLeft() {
    const { data, error } = await supabaseClient.from("bottle_usage").select("count").eq("kind", "lookup").eq("usage_date", utcDay()).maybeSingle();
    if (error) return null;
    return Math.max(0, BT_LOOKUP_LIMIT - (data ? data.count : 0));
  }
  async function renderBtLookup(ctx, message, productId) {
    bottleTitle.textContent = "Not in the catalog yet";
    const name = ctx.label ? ctx.label.full_name : ctx.text;
    btSet("lookup", `
      ${btLabelCard(ctx)}
      <div class="bt-lookup-card">
        <b>Not in the catalog yet</b>
        <span>A lookup searches critic reviews and competition results, keeps only what it can link to, and saves it, so this bottle is instant next time.</span>
        <button type="button" class="solid-btn bt-wide bt-tall" data-bt="research">Look it up</button>
        <span class="bt-note bt-center" id="bt-left">Takes about 20–30 seconds</span>
      </div>
      ${message ? `<p class="bt-msg" role="alert">${esc(message)}</p>` : ""}
      <button type="button" class="ghost-btn bt-wide bt-add-outline" data-bt="add-unscored">＋ Add “${esc(name)}” to my bar without a score</button>`, { ctx, productId: productId || null });
    const left = await btLookupsLeft();
    const el = $("#bt-left");
    if (el && left != null && btScreen.name === "lookup") {
      el.textContent = `Takes about 20–30 seconds · ${left} of ${BT_LOOKUP_LIMIT} lookups left today`;
    }
  }
  function renderBtResearching(ctx, lookupId) {
    bottleTitle.textContent = "Looking it up";
    btSet("researching", `
      ${btLabelCard(ctx)}
      <div class="bt-busy bt-researching" role="status">
        <span class="spinner" aria-hidden="true"></span>
        <span><b>Searching critics, then competition results, then the producer…</b><br>Usually 20–30 seconds.</span>
      </div>
      <p class="bt-note">You can close this — the lookup keeps going, and the score will be waiting under Bottles.</p>`, { ctx, lookupId });
  }
  function renderBtNone(ctx) {
    bottleTitle.textContent = "No expert scores found";
    const name = ctx.label ? ctx.label.full_name : ctx.text;
    btSet("none", `
      ${btLabelCard(ctx)}
      <div class="bt-lookup-card">
        <b>No expert scores found for this one</b>
        <span>Nothing turned up that could be linked to a critic’s or competition’s own page. That’s common for new, local or store-only bottles.</span>
      </div>
      <button type="button" class="ghost-btn bt-wide bt-add-outline" data-bt="add-unscored">＋ Add “${esc(name)}” to my bar without a score</button>
      <button type="button" class="ghost-btn bt-wide" data-bt="again">Look up another</button>`, { ctx });
  }
  async function btResearch(ctx, productId) {
    const token = ++btToken;
    renderBtResearching(ctx, null);
    const body = { name: ctx.label ? ctx.label.full_name : ctx.text, label: ctx.label || {} };
    if (productId) body.product_id = productId;
    const { data, error } = await supabaseClient.functions.invoke("research-bottle", { body }).catch((err) => ({ error: err }));
    // Closing the sheet (or starting something else) doesn't cancel a lookup —
    // it's already paid for and running server-side — so a running one is
    // always watched, and a finished one reported by toast if nobody's looking.
    const here = token === btToken && !bottlePanel.hidden;
    const name = ctx.label ? ctx.label.full_name : ctx.text;
    if (error || data?.error) {
      if (here) renderBtLookup(ctx, aiErrorText(data, error), productId); else toast(aiErrorText(data, error), true);
      return;
    }
    if (data.status === "running" && data.lookup_id) {
      if (here) btScreen.lookupId = data.lookup_id;
      watchLookup(data.lookup_id, ctx);
      return;
    }
    if (data.status === "found") {
      bottlesInvalidate();
      if (here) btShowResult(data.product_id, ctx, false, { status: "Looked up just now." });
      else toastAction(`${name}: expert scores found`, "View", () => { if (openBottlePanel()) { btToken++; btShowResult(data.product_id, ctx, false); } });
      return;
    }
    if (data.status === "fresh") {
      if (here) btShowResult(data.product_id, ctx, false, { status: `Up to date — reviews checked ${btAgo(data.checked_at)}.` });
      return;
    }
    if (data.status === "none") { if (here) renderBtNone(ctx); else toast(`${name}: no expert scores found.`); return; }
    if (here) renderBtLookup(ctx, "That didn’t go through — try again.", productId);
  }
  // Polls the lookup row; keeps going after the sheet closes and reports by toast.
  // onDone(row), when given, decides what the ending looks like (the check of a
  // known bottle); otherwise it's a first lookup and lands on its score card.
  function watchLookup(id, ctx, onDone) {
    if (pendingLookups.has(id)) return;
    pendingLookups.set(id, ctx);
    const started = Date.now();
    const showing = () => !bottlePanel.hidden && btScreen.name === "researching" && btScreen.lookupId === id;
    const tick = async () => {
      const { data } = await supabaseClient.from("spirit_lookups").select("status,product_id,added").eq("id", id).maybeSingle();
      const st = data ? data.status : "running";
      if (st === "running") {
        if (Date.now() - started < 240_000) { setTimeout(tick, 3000); return; }
        pendingLookups.delete(id);
        if (onDone) onDone({ status: "timeout" });
        else if (showing()) renderBtLookup(ctx, "That lookup is taking too long — try again in a few minutes.");
        return;
      }
      pendingLookups.delete(id);
      if (onDone) { onDone(data); return; }
      bottlesInvalidate();
      if (viewMode === "bottles") renderBottlesBest();
      const name = ctx.label ? ctx.label.full_name : ctx.text;
      if (st === "found" && data.product_id) {
        if (showing()) { btToken++; btShowResult(data.product_id, ctx, false, { status: "Looked up just now." }); }
        else toastAction(`${name}: expert scores found`, "View", () => { if (openBottlePanel()) { btToken++; btShowResult(data.product_id, ctx, false); } });
      } else if (st === "none") {
        if (showing()) renderBtNone(ctx); else toast(`${name}: no expert scores found.`);
      } else if (showing()) {
        renderBtLookup(ctx, "The lookup didn’t finish — try again.");
      } else {
        toast(`${name}: the lookup didn’t finish — try again.`, true);
      }
    };
    setTimeout(tick, 4000);
  }

  // Every add is confirmed in a sheet (name and category editable) — a native
  // confirm() gets dismissed on reflex, and a misread name is fixable here.
  let btAddResolve = null;
  function btConfirmAdd(name, category) {
    return new Promise((resolve) => {
      btAddResolve = resolve;
      btAddName.value = name;
      btAddCat.innerHTML = BAR_CATEGORIES.map((c) => `<option value="${esc(c)}">${esc(invCap(c))}</option>`).join("");
      btAddCat.value = BAR_CATEGORIES.includes(category) ? category : "other";
      btAddPanel.hidden = false;
      btAddName.focus();
    });
  }
  function closeBtAdd(choice) {
    btAddPanel.hidden = true;
    const resolve = btAddResolve;
    btAddResolve = null;
    if (resolve) resolve(choice);
  }
  btAddForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = btAddName.value.replace(/\s+/g, " ").trim();
    if (!name) { btAddName.focus(); return; }
    closeBtAdd({ name, category: btAddCat.value });
  });
  $("#bt-add-cancel").addEventListener("click", () => closeBtAdd(null));
  btAddPanel.addEventListener("click", (e) => { if (e.target === btAddPanel) closeBtAdd(null); });
  async function btAddToBar(name, category, productId) {
    const choice = await btConfirmAdd(name, category);
    if (!choice) return false;
    // Renamed to a different bottle? Then it isn't this catalog entry any more
    // (the add's own auto-link will find the right one, if it's in the catalog).
    const keepLink = productId && sameBottle(normName(choice.name), normName(name));
    const added = await addInventoryItem({ section: "bar", category: choice.category, name: choice.name, status: "in", product_id: keepLink ? productId : null });
    if (!added) return false;
    toast(`Added ${choice.name} to your bar`);
    return { name: choice.name, linked: !!keepLink };
  }
  async function btReport(prod) {
    const { error } = await supabaseClient.from("spirit_reports").insert({ product_id: prod.id, kind: "wrong_bottle" });
    if (error) { toastError("Couldn’t send that", error); return; }
    toast("Thanks — flagged for a fix.");
  }

  bottleBody.addEventListener("click", async (e) => {
    const act = e.target.closest("[data-bt]");
    const productBtn = e.target.closest("[data-bt-product]");
    const pickBtn = e.target.closest("[data-bt-pick]");
    if (productBtn) { btToken++; btShowResult(productBtn.dataset.btProduct, null, false); return; }
    if (pickBtn && btScreen.ctx) { const c = btScreen.ctx.cands[Number(pickBtn.dataset.btPick)]; if (c) { btToken++; btShowResult(c.product_id, btScreen.ctx, true, { verify: true }); } return; }
    if (!act) return;
    const what = act.dataset.bt;
    if (what === "camera") { btPhotoCamera.value = ""; btPhotoCamera.click(); return; }
    if (what === "pick") { btPhotoPick.value = ""; btPhotoPick.click(); return; }
    if (what === "again") { btToken++; renderBtStart(); return; }
    if (what === "neither" && btScreen.ctx) { renderBtLookup(btScreen.ctx); return; }
    if (what === "research" && btScreen.ctx) { btResearch(btScreen.ctx, btScreen.productId); return; }
    if (what === "research-product" && btScreen.prod) {
      const p = btScreen.prod;
      btResearch(btScreen.ctx || { text: p.canonical_name, label: null }, p.id);
      return;
    }
    if (what === "add" && btScreen.prod) {
      act.disabled = true;
      const added = await btAddToBar(btScreen.prod.canonical_name, btScreen.prod.category, btScreen.prod.id);
      if (added) {
        act.outerHTML = `<span class="bt-owned">✓ ${added.linked ? "In your bar" : `Added “${esc(added.name)}”`}</span>`;
        loadOwnedScores();
      } else act.disabled = false;
      return;
    }
    if (what === "add-unscored" && btScreen.ctx) {
      const ctx = btScreen.ctx;
      const name = ctx.label ? ctx.label.full_name : ctx.text;
      act.disabled = true;
      if (await btAddToBar(name, ctx.label ? ctx.label.category : "other", btScreen.productId)) act.textContent = "✓ Added to your bar";
      else act.disabled = false;
      return;
    }
    if (what === "report" && btScreen.prod) { act.disabled = true; btReport(btScreen.prod); return; }
    if (what === "restock" && btScreen.prod) {
      const item = inventory.find((i) => i.section === "bar" && i.product_id === btScreen.prod.id && i.status === "out");
      if (!item) return;
      act.disabled = true;
      await restockToGrocery(item.id);
      act.outerHTML = `<span class="bt-owned">Out \u00B7 \u2713 on your grocery list</span>`;
      return;
    }
    if (what === "verify" && btScreen.prod) { btVerify(btScreen.prod, btScreen.ctx); }
  });
  bottleBody.addEventListener("submit", (e) => {
    const fix = e.target.closest("[data-bt-fix]");
    if (fix && btScreen.ctx) {
      e.preventDefault();
      const name = fix.elements.q.value.trim();
      if (name.length < 2) return;
      // A corrected name keeps what else the label said (age, proof, batch).
      const label = btScreen.ctx.label ? { ...btScreen.ctx.label, full_name: name, misread: false } : null;
      btMatch({ text: name, label, fromPhoto: !!label }, ++btToken);
      return;
    }
    const form = e.target.closest("[data-bt-form]");
    if (!form) return;
    e.preventDefault();
    btFromText(form.elements.q.value);
  });
  btPhotoCamera.addEventListener("change", () => btFromPhoto(btPhotoCamera.files[0]));
  btPhotoPick.addEventListener("change", () => btFromPhoto(btPhotoPick.files[0]));
  bottleBody.addEventListener("click", (e) => {
    const make = e.target.closest("[data-bt-make]");
    if (!make) return;
    closeBottlePanel();
    openExistingRecipe(make.dataset.btMake);
  });
  closeBottleBtn.addEventListener("click", closeBottlePanel);
  bottlePanel.addEventListener("click", (e) => { if (e.target === bottlePanel) closeBottlePanel(); });
  bottlesView.addEventListener("click", (e) => {
    // The camera in the search field goes straight to the camera.
    if (e.target.closest("#bt-open")) {
      if (!session) { toast("Sign in to look up bottles."); return; }
      btPhotoCamera.value = ""; btPhotoCamera.click(); return;
    }
    const restock = e.target.closest("[data-bt-restock]");
    if (restock) {
      restock.disabled = true;
      restockToGrocery(restock.dataset.btRestock).then(renderBottlesMine);
      return;
    }
    const f = e.target.closest("[data-bt-filter]");
    if (f) { bottles.filter = f.dataset.btFilter; renderBottlesView(); return; }
    const tab = e.target.closest("[data-bt-list]");
    if (tab) { bottles.list = tab.dataset.btList; saveLocal("bottleList", bottles.list); renderBottlesView(); return; }
    const find = e.target.closest("[data-bt-find]");
    if (find) { btFromText(find.dataset.btFind); return; }
    const row = e.target.closest("[data-bt-product]");
    if (row && openBottlePanel()) { btToken++; btShowResult(row.dataset.btProduct, null, false); }
  });
  bottlesView.addEventListener("submit", (e) => {
    if (!e.target.closest("#bt-view-search")) return;
    e.preventDefault();
    const input = $("#bt-view-q");
    if (input && input.value.trim().length >= 2) btFromText(input.value);
  });
  modeBottlesBtn.addEventListener("click", () => setViewMode("bottles"));

  setAuthMode("signin"); // default the gate to sign-in

  // ---------- Filtering ----------
  function activePool() {
    return sharedOnly ? DATA[SHARED_POOL_KEY[section]] : DATA[POOL_KEY[section]];
  }

  function currentItems() {
    const items = activePool();
    const q = searchTerm.trim().toLowerCase();
    const matched = items.filter((it) => {
      if (!sharedOnly && favoritesOnly && !it.isFavorite) return false;
      if (activeTags.size && ![...activeTags].every((t) => it.tags.includes(t))) return false;
      if (!q) return true;
      return (it.searchHay || "").includes(q);
    });
    // The pool already arrives A–Z from the query, so "name" needs no work.
    // For date sorts, anything missing a created_at (very old rows) sorts last
    // rather than jumping to the top as an epoch-0 date.
    if (sortMode === "name") return matched;
    const dir = sortMode === "newest" ? -1 : 1;
    return matched.slice().sort((a, b) => {
      const ta = a.createdAt ? Date.parse(a.createdAt) : NaN;
      const tb = b.createdAt ? Date.parse(b.createdAt) : NaN;
      const aBad = Number.isNaN(ta), bBad = Number.isNaN(tb);
      if (aBad && bBad) return a.name.localeCompare(b.name);
      if (aBad) return 1;
      if (bBad) return -1;
      return ta === tb ? a.name.localeCompare(b.name) : (ta - tb) * dir;
    });
  }

  // ---------- Rendering ----------
  function renderTagFilters() {
    // Count tags only over items that ALREADY match the current selection, so a
    // tag that would yield zero results if added (an "impossible" combo like two
    // cuisines on one recipe) drops out of the list instead of leading to an
    // empty result set. With no active tags this is the whole section pool.
    const base = activePool().filter((it) => [...activeTags].every((t) => it.tags.includes(t)));
    const counts = {};
    base.forEach((it) => it.tags.forEach((t) => (counts[t] = (counts[t] || 0) + 1)));
    const tags = Object.keys(counts).sort();
    tagCloudEl.innerHTML = tags.map((t) =>
      `<button class="tag-chip${activeTags.has(t) ? " is-on" : ""}" data-tag="${esc(t)}">${esc(t)} \u00B7 ${counts[t]}</button>`
    ).join("");
  }

  // Everything narrowing the list surfaces here, so nothing the filter sheet
  // holds is invisible once that sheet is closed \u2014 including the scope, which
  // used to have a permanent row of its own above the list.
  function renderActiveFilters() {
    const scopeChip = favoritesOnly
      ? `<button class="tag-chip is-on" data-scope-off="favorites">\u2605 Favorites \u2715</button>`
      : sharedOnly
        ? `<button class="tag-chip is-on" data-scope-off="shared">\uD83D\uDC65 Shared \u2715</button>`
        : "";
    // A dot on the 🏷 button, so a narrowed list is obvious even if the chip row
    // has scrolled out of sight.
    toggleFiltersBtn.classList.toggle("has-filters", !!(activeTags.size || scopeChip));
    if (!activeTags.size && !scopeChip) { activeFiltersEl.hidden = true; return; }
    activeFiltersEl.hidden = false;
    activeFiltersEl.innerHTML =
      "Showing: " + scopeChip +
      [...activeTags].map((t) => `<button class="tag-chip is-on" data-tag="${esc(t)}">${esc(t)} \u2715</button>`).join("") +
      ` <button class="ghost-btn small" id="clear-tags">Clear all</button>`;
  }

  // Does a recipe's servings label count *people* (so it should scale to the
  // household), or a *batch/yield* ("tart", "batch", "pizza", "loaf", "cookies")
  // that already feeds the household regardless of size? A blank label is treated
  // as people, matching how plain food recipes have always behaved.
  const PEOPLE_SERVING_RE = /\b(?:serving|servings|portion|portions|serves|person|people|drink|drinks|glass|glasses|bowl|bowls|cocktail|cocktails)\b/i;
  function servesPeople(label) {
    const l = (label || "").trim();
    return !l || PEOPLE_SERVING_RE.test(l);
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
    if (servingsByRecipe.has(it.id)) return servingsByRecipe.get(it.id);
    // Household scaling only makes sense when base_servings counts *food* people.
    // Cocktails / bar recipes default to their own base (1 drink) — the household
    // number is a food setting — and a batch/yield food recipe ("1 tart", "1
    // pizza pan") already feeds the household, so those keep their base too.
    if (scalesToHousehold(it)) return householdServings;
    return it.baseServings;
  }
  // A recipe scales to the household default only if it's food AND measured in
  // people-servings (not a bar cocktail, not a batch/yield yield unit).
  function scalesToHousehold(it) {
    return !!householdServings && it.section !== "bar" && servesPeople(it.servingsLabel);
  }

  // Set a recipe's servings from any +/- control, keeping the grocery basket in
  // sync so the combined shopping list reflects the new scale immediately.
  const basketServingsTimers = new Map(); // recipeId -> timeout handle, debounces rapid +/- taps
  let servingsRenderTimer = null;          // debounces the heavy re-render across a tap burst
  function setRecipeServings(id, n) {
    const v = Math.max(1, n);
    servingsByRecipe.set(id, v); // session-only override, never synced
    if (basket.has(id)) basket.get(id).servings = v;
    // Immediate feedback: bump the visible number(s) for this row/detail now,
    // then debounce the heavy full re-render (list + grocery panel, which
    // re-scale every ingredient) so mashing +/- a dozen times settles into one
    // repaint instead of one per tap.
    const li = document.querySelector(`.item[data-id="${CSS.escape(id)}"]`);
    if (li) {
      const detailNum = li.querySelector(".detail-serv-num");
      if (detailNum) detailNum.textContent = `${v} ${byId[id]?.servingsLabel ?? ""}`.trim();
    }
    clearTimeout(servingsRenderTimer);
    servingsRenderTimer = setTimeout(() => {
      renderList();
      renderGroceryCount();
      if (!groceryPanel.hidden) renderGroceryPanel();
    }, 140);
    if (!session || !basket.has(id)) return;
    clearTimeout(basketServingsTimers.get(id));
    basketServingsTimers.set(id, setTimeout(async () => {
      basketServingsTimers.delete(id);
      if (!basket.has(id)) return; // removed while the debounce was pending
      const { error } = await supabaseClient.from("grocery_basket_items")
        .upsert({ recipe_id: id, servings: basket.get(id).servings }, { onConflict: "user_id,recipe_id" });
      if (error) toastError("Couldn\u2019t save those servings", error);
    }, 500));
  }

  // One row's markup, lifted out of renderList so a single row can be redrawn on
  // its own (see rerenderRow). Toggling a star or the list button used to
  // rebuild every row in the list, which dropped keyboard focus to <body> each
  // time — adding five recipes meant five trips back through the Tab order.
  // A row is for scanning: name, subtitle and tags, the star, and one "+ List".
  // It used to carry six controls (a checkbox and a cart glyph for the same
  // thing, a servings stepper, a calendar box, the star and a chevron); the
  // servings and the plan live in the open recipe now.
  function itemHtml(it) {
    const picked = basket.has(it.id);
    const servings = chosenServings(it);
    const open = openItems.has(it.id);
    const mine = it.userId === session?.user?.id;
    return `
    <li class="item${open ? " is-open" : ""}" data-id="${esc(it.id)}">
      <div class="item-row">
        <button class="item-head" aria-expanded="${open}">
          <span class="item-name">${esc(it.name)}</span>
          ${it.subtitle ? `<span class="item-sub">${esc(it.subtitle)}</span>` : ""}
          ${!mine ? `<span class="item-owner">Shared by ${esc(profileNames[it.userId] || "someone")}</span>` : ""}
          <span class="item-tags">${it.tags.map((t) => `<span class="mini-tag">${esc(t)}</span>`).join("")}</span>
        </button>
        ${mine ? `<button class="star-btn${it.isFavorite ? " is-on" : ""}" aria-label="${it.isFavorite ? "Remove from favorites" : "Add to favorites"}" aria-pressed="${it.isFavorite}">${it.isFavorite ? "\u2605" : "\u2606"}</button>` : ""}
        ${listBtnHtml(it.name, picked)}
      </div>
      ${open ? renderDetail(it, servings) : ""}
    </li>`;
  }

  // "+ List" / "✓ On list" — the row's one action. The recipe's name rides along
  // for screen readers, since "List" alone doesn't say which recipe.
  function listBtnHtml(name, on) {
    return `<button type="button" class="list-btn${on ? " is-on" : ""}" aria-pressed="${on}">` +
      `${on ? "\u2713 On list" : "+ List"}<span class="sr-only">: ${esc(name)}</span></button>`;
  }

  // Redraw ONE row and put focus back where it was. For the toggles that
  // restructure a row (the list button rewrites the open detail's grocery
  // button; the unit toggle rewrites the open detail) this is both cheaper than
  // renderList and, more to the point, it doesn't throw away the other forty
  // rows' focus.
  const ROW_FOCUS_SELECTORS = [
    ".list-btn", ".star-btn", ".item-head", ".detail-grocery-btn",
    ".plan-night-btn", ".coach-btn", ".pair-btn", ".cook-btn", ".detail-more-btn"
  ];
  function rowFocusSelector(el) {
    const direct = ROW_FOCUS_SELECTORS.find((s) => el.matches(s));
    if (direct) return direct;
    // Siblings that only differ by a data attribute need it to be told apart.
    if (el.matches(".detail-serv-btn")) return `.detail-serv-btn[data-step="${el.dataset.step}"]`;
    if (el.matches(".unit-toggle-btn")) return `.unit-toggle-btn[data-unit="${el.dataset.unit}"]`;
    return null;
  }
  function rerenderRow(id) {
    const li = listEl.querySelector(`.item[data-id="${CSS.escape(id)}"]`);
    const it = byId[id];
    if (!li || !it) { renderList(); return; }
    const active = document.activeElement;
    const focusSel = active && li.contains(active) ? rowFocusSelector(active) : null;
    li.outerHTML = itemHtml(it);
    if (focusSel) {
      const next = listEl.querySelector(`.item[data-id="${CSS.escape(id)}"] ${focusSel}`);
      if (next) next.focus({ preventScroll: true });
    }
  }

  function renderList() {
    // Before the first fetch lands, show placeholder rows rather than the
    // first-run invitation: a returning user on a slow connection was being
    // told they had no recipes, and a failed load said the same thing.
    if (dataState !== "ready" && !Object.keys(byId).length) {
      pickHintEl.hidden = true;
      emptyEl.classList.toggle("is-error", dataState === "error");
      if (dataState === "error") {
        // Hide the whole count/sort row: a lone "A–Z" dropdown floating over an
        // error message is just noise.
        resultCountEl.textContent = "";
        resultRowEl.hidden = true;
        listEl.innerHTML = "";
        emptyEl.hidden = false;
        emptyEl.innerHTML =
          "<strong>Couldn\u2019t reach your recipes.</strong>" +
          "They\u2019re safe in your account \u2014 this is the connection, not your book." +
          '<button type="button" class="ghost-btn small empty-retry" id="empty-retry">Try again</button>';
      } else {
        resultCountEl.textContent = "Loading\u2026";
        emptyEl.hidden = true;
        listEl.innerHTML = '<li class="list-skeleton-wrap" aria-hidden="true"><ul class="list-skeleton">' +
          "<li><span></span><span></span></li>".repeat(3) + "</ul></li>";
      }
      renderStagedCount();
      return;
    }
    emptyEl.classList.remove("is-error");
    resultRowEl.hidden = viewMode !== "recipes";

    const items = currentItems();
    resultCountEl.textContent =
      `${items.length} ${section === "recipes" ? "recipe" : "cocktail"}${items.length === 1 ? "" : "s"}`;
    emptyEl.hidden = items.length > 0;
    syncPickHint(items.length);
    if (items.length === 0) {
      const noun = section === "recipes" ? "recipes" : "cocktails";
      const hasFilter = !!(searchTerm.trim() || activeTags.size);
      emptyEl.textContent = sharedOnly && !hasFilter
        ? "Nothing's been shared with you yet \u2014 when someone shares a recipe with you, it'll show up here."
        : favoritesOnly && !hasFilter
          ? `No favorite ${noun} yet \u2014 tap the \u2606 on a recipe to star it.`
          : (hasFilter || favoritesOnly || sharedOnly)
            ? "Nothing matches that search. Clear a tag or try a different word."
            : `No ${noun} yet \u2014 tap \u201c+ Add recipe\u201d or \u201c\u2728 Add with AI\u201d to get started.`;
    }

    listEl.innerHTML = items.map(itemHtml).join("");
    renderStagedCount();
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
      ? `<p class="detail-meta">${it.source ? `Source: ${sourceDisplayHtml(it.source)}` : ""}${ownerNote}</p>`
      : "";
    // Three tiers, so the everyday jobs don't look like the occasional ones:
    // cook it (primary), shop for it / plan it (the pair), and a quiet line for
    // Ask AI, Pair a drink and the rest. They used to be six equal buttons
    // under the method, a long scroll down on a phone.
    const kitchen = it.section === "kitchen";
    const onList = basket.has(it.id);
    const actions = `
      <div class="detail-actions">
        ${it.method && it.method.length ? `<button class="solid-btn cook-btn" data-id="${esc(it.id)}">\u25B6 Start cooking</button>` : ""}
        <div class="detail-actions-pair">
          <button class="ghost-btn detail-grocery-btn${onList ? " is-on" : ""}" data-id="${esc(it.id)}">${onList ? "\u2713 On grocery list" : "Add to grocery list"}</button>
          ${kitchen ? `<button class="ghost-btn plan-night-btn${plannedEntry(it.id) ? " is-on" : ""}" data-id="${esc(it.id)}" aria-haspopup="dialog">${esc(planBtnLabel(it.id))}</button>` : ""}
        </div>
        <p class="detail-quiet">
          <span>Need a hand?</span>
          <button class="link-btn coach-btn" data-id="${esc(it.id)}">Ask AI</button>
          ${kitchen ? `<span aria-hidden="true">\u00B7</span><button class="link-btn pair-btn" data-id="${esc(it.id)}">Pair a drink</button>` : ""}
          <span aria-hidden="true">\u00B7</span>
          <button class="link-btn detail-more-btn" data-id="${esc(it.id)}" aria-haspopup="true" aria-expanded="false">More</button>
        </p>
      </div>`;
    return `
    <div class="item-detail">
      ${sourceLine}
      ${actions}
      ${mine && openShareIds.has(it.id) ? renderSharePanel(it) : ""}
      ${servControl}
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
                const l = ingLine(ing, true, unitSystem, it.section === "bar");
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

    const ingHtml = shareIngredientsHtml(it, servings, system);
    const specHtml = shareSpecsHtml(it);

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
        const l = ingLine(ing, true, system, it.section === "bar");
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

  // Hand a generated page to the native share sheet as an .html file, so it
  // lands as a saveable attachment; fall back to plain text for targets that
  // can't take a file, and on desktop to a download. A cancelled share sheet is
  // the user's answer, not a failure: it used to fall through to the next tier
  // and pop a second sheet (or, with no gesture left, a surprise download).
  // `text` is a function so the long plain-text version is only built if needed.
  async function shareHtmlFile({ html, filename, title, text, savedMsg }) {
    const cancelled = (err) => err && err.name === "AbortError";
    if (navigator.canShare) {
      try {
        const file = new File([html], filename, { type: "text/html" });
        if (navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title });
          return;
        }
      } catch (err) { if (cancelled(err)) return; /* else fall through to text / download */ }
    }
    if (navigator.share) {
      try { await navigator.share({ title, text: text() }); return; }
      catch (err) { if (cancelled(err)) return; /* unsupported — fall through */ }
    }
    try {
      downloadBlob(new Blob([html], { type: "text/html" }), filename);
      toast(savedMsg);
    } catch {
      toast("Sharing isn’t available on this device");
    }
  }

  function shareRecipeFile(it) {
    const servings = chosenServings(it);
    return shareHtmlFile({
      html: recipeShareHtml(it, servings, unitSystem),
      filename: recipeFilename(it),
      title: it.name,
      text: () => recipeShareText(it, servings, unitSystem),
      savedMsg: "Saved the recipe file — attach it to a text or email"
    });
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
  // One number with one meaning everywhere: the lines on the list to buy. The
  // header badge used to count recipes + added items while a bottom bar said
  // "2 recipes in your grocery list" — two counts on one screen, and neither
  // was what you'd be shopping for. The bar itself is gone too: it sat over the
  // end of every list. Adding a recipe toasts with a View button instead.
  // Counting lines means re-scaling the basket recipes, which is a few hundred
  // ingredient rows at most; this runs on list changes, not on every render.
  const itemsWord = (n) => `${n} item${n === 1 ? "" : "s"}`;
  // An emptied list no longer slams the panel shut (Clear lives inside it now);
  // it says the list is empty and how to fill it.
  function renderGroceryCount(toBuy) {
    const added = basket.size + manualGroceryItems.length;
    const n = !added ? 0 : (toBuy || partitionPantry(allGroceryItems()).toBuy).length;
    if (groceryTopCountEl) {
      groceryTopCountEl.hidden = n === 0;
      groceryTopCountEl.textContent = n > 99 ? "99+" : String(n);
      groceryTopBtn.setAttribute("aria-label", n === 0
        ? "Open grocery list"
        : `Open grocery list, ${itemsWord(n)}`);
    }
    if (groceryHeadCountEl) groceryHeadCountEl.textContent = n ? itemsWord(n) : "";
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

  // Rule-of-thumb yield per whole citrus fruit — juice in ml, peel/zest in g.
  // Deliberately generous (a fruit gives a bit less than this) so a peel-heavy
  // recipe never leaves you short. Used to turn peel + juice into "(N) limes".
  const CITRUS_YIELD = {
    lime: { juice: 24, peel: 6 }, lemon: { juice: 36, peel: 10 },
    orange: { juice: 90, peel: 20 }, grapefruit: { juice: 150, peel: 32 }
  };

  // Merge ingredients across every recipe in the basket into one shopping
  // list: matching item + unit gets summed, units are converted to what a US
  // grocery store sells, and pantry staples can be hidden. `source` is any
  // iterable of [recipeId, { servings }] — the basket by default; the meal-plan
  // page passes the week's totals so it never touches the real basket.
  function combinedGroceryItems(source = basket) {
    const map = new Map();
    // Citrus is counted in whole fruit, not summed by weight/volume: one lime
    // gives both its juice AND its peel, so within a recipe we take the max of
    // the juice-need and peel-need (plus any whole/garnish fruit) and sum that
    // across recipes. fruit -> { count, recipes:Set }.
    const citrus = new Map();
    for (const [id, { servings }] of source) {
      const it = byId[id];
      if (!it) continue;
      const recipeCitrus = new Map(); // fruit -> { juiceMl, peelG, whole }
      // Ingredients the recipe MAKES itself carry a component `group` label and
      // are then used under another group by that same name (e.g. a "Dry Pancake
      // Mix" group feeds a "dry pancake mix" ingredient). Those aren't bought —
      // the group's real inputs (flour, sugar…) already are. Skip any ingredient
      // whose name matches one of the recipe's group labels.
      const groupLabels = new Set((it.ingredients || [])
        .map((i) => i.group && normalizeItemName(i.group)).filter(Boolean));
      scaledIngredients(it, servings).forEach((ing) => {
        if (!ing.item) return;
        // A fallback option ("fatty ground pork, alternative to pancetta") isn't a
        // separate thing to buy — the primary ingredient is already on the list.
        if (/\b(?:alternative to|substitute for|instead of|in place of|as a substitute)\b/i.test(ing.item)) return;
        const nameKey = normalizeItemName(ing.item);
        if (groupLabels.has(nameKey)) return; // made by the recipe, not bought
        // Plain tap water and a bare "liquid" placeholder ("liquid (water, beer,
        // or milk)") are never shopped — drop them (a named water like
        // "distilled"/"coconut water" normalizes to that, not bare "water").
        if (nameKey === "water" || nameKey === "liquid") return;
        if (skipPantryStaples && isPantryStaple(nameKey)) return;
        const { amount, family, unit } = canonicalQuantity(ing.scaled, ing.unit, it.section === "bar");
        // Citrus that folded to a bare fruit (peel / zest / fresh-squeezed juice /
        // whole) is counted in fruit, not summed by weight/volume. Plain bottled
        // "lime juice" keeps its name (nameKey stays "lime juice") and is untouched.
        if (CITRUS_YIELD[nameKey]) {
          const raw = String(ing.item).toLowerCase();
          const rc = recipeCitrus.get(nameKey) || { juiceMl: 0, peelG: 0, whole: 0 };
          if (/\bjuice\b/.test(raw) && amount != null && (family === "volume" || unit === "fl oz")) rc.juiceMl += family === "volume" ? amount : amount * ML_PER_FL_OZ;
          else if (/\b(?:peel|zest|rind)\b/.test(raw) && family === "weight" && amount != null) rc.peelG += amount;
          else rc.whole += (family == null && amount != null ? amount : 1);
          recipeCitrus.set(nameKey, rc);
          return;
        }
        const key = `${nameKey}__${family || unit || ""}`;
        const existing = map.get(key);
        if (existing) {
          if (amount != null) existing.amount = (existing.amount || 0) + amount;
          if (it.name) existing.recipes.add(it.name);
        } else {
          map.set(key, { key, item: displayGroceryName(ing.item), family, unit, amount, recipes: new Set(it.name ? [it.name] : []) });
        }
      });
      // One fruit covers this recipe's juice AND peel, so take the max of the two
      // needs (plus whole/garnish fruit); sum that into the basket-wide tally.
      recipeCitrus.forEach((rc, fruit) => {
        const Y = CITRUS_YIELD[fruit];
        const n = rc.whole + Math.max(Math.ceil(rc.juiceMl / Y.juice), Math.ceil(rc.peelG / Y.peel));
        if (n <= 0) return;
        const c = citrus.get(fruit) || { count: 0, recipes: new Set() };
        c.count += n;
        if (it.name) c.recipes.add(it.name);
        citrus.set(fruit, c);
      });
    }
    const citrusItems = [...citrus.entries()].map(([fruit, c]) => ({
      key: `citrus__${fruit}`, item: c.count === 1 ? fruit : fruit + "s",
      amount: c.count, unit: null, recipes: [...c.recipes]
    }));
    return [...[...map.values()]
      .map((entry) => {
        const { amount, unit } = shoppableQuantity(entry.amount, entry.family, entry.unit);
        return { key: entry.key, item: entry.item, amount, unit, recipes: [...entry.recipes] };
      }), ...citrusItems]
      .sort((a, b) => a.item.localeCompare(b.item));
  }

  // Manual (non-recipe) items, shaped to slot into the same category buckets
  // and checked-off tracking as recipe-derived items.
  function manualAsGroceryItems() {
    return manualGroceryItems.map((m) => ({ key: m.key, item: m.name, amount: null, unit: null, manual: true, recipes: [] }));
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

  // Split the combined list into what you still need to buy vs. what your pantry
  // inventory already covers. Manual (typed) items are never auto-held \u2014 you added
  // them deliberately \u2014 and anything you tapped "Add back" on stays on the list.
  // Staples are a separate concern, handled by the skip-staples toggle inside
  // combinedGroceryItems. Same isInPantryStock check the King Soopers sheet uses.
  function partitionPantry(items) {
    const toBuy = [], heldInPantry = [];
    const stockKeys = inventory.length ? inStockKeys() : null;
    items.forEach((it) => {
      const held = !it.manual && !pantryKeep.has(it.key) && isInPantryStock(it.item, stockKeys);
      (held ? heldInPantry : toBuy).push(it);
    });
    return { toBuy, heldInPantry };
  }
  // One grocery line's shopper-facing quantity \u2014 the same purchase-unit conversion
  // the King Soopers sheet uses (garlic -> bulbs, tomato slices -> whole fruit).
  function groceryQtyStr(it) {
    return it.amount == null ? "" : purchaseQtyStr([{ amount: it.amount, unit: it.unit }], it.item);
  }
  // "for Fajitas and Tacos" \u2014 credit only on a line two recipes share, which is
  // the one time it tells you something (it explains a big amount). Every line
  // used to say "\u00b7 1 recipe", which repeated itself down the whole list.
  function recipeCredit(it) {
    const r = it.recipes || [];
    if (r.length < 2) return "";
    return r.length === 2 ? `for ${r[0]} and ${r[1]}` : `for ${r.length} recipes`;
  }
  function recipeCountLabel(it) {
    const c = recipeCredit(it);
    return c ? ` \u00b7 ${c}` : "";
  }

  function renderGroceryPanel() {
    // Compute the combined list once; the sections, the pantry group and the
    // progress counter reuse it (each recompute re-scales every basket recipe).
    const combined = allGroceryItems();
    const { toBuy, heldInPantry } = partitionPantry(combined);
    const sections = groceryByCategory(toBuy);
    const itemsHtml = sections.length
      ? sections.map((sec) => `
          <li class="g-category">${esc(sec.category)}</li>
          ${sec.items.map((it) => {
            const checked = checkedGroceryItems.has(it.key);
            const amtStr = groceryQtyStr(it);
            const credit = recipeCredit(it);
            return `<li class="${checked ? "is-checked" : ""}">
              <label class="g-item">
                <input type="checkbox" class="g-item-check" data-key="${esc(it.key)}" ${checked ? "checked" : ""}>
                <span class="ing-amt">${esc(amtStr)}</span><span class="g-item-name">${esc(it.item)}${credit ? `<span class="g-item-recipes">${esc(credit)}</span>` : ""}</span>
              </label>
              ${it.manual ? `<button type="button" class="g-manual-remove" data-key="${esc(it.key)}" aria-label="Remove ${esc(it.item)}">\u00d7</button>` : ""}
            </li>`;
          }).join("")}`).join("")
      : `<p class="g-empty">${heldInPantry.length
            ? "Nothing to buy \u2014 your pantry already covers this list."
            : basket.size || manualGroceryItems.length
              ? "Nothing to buy \u2014 try turning off \u201cSkip salt, oil and other staples\u201d."
              : "Your list is empty. Tap <b>+ List</b> on a recipe, or add an item above."}</p>`;

    // "By recipe" is a reference view \u2014 the same shopping list regrouped under the
    // recipe each line came from, so you can see what an ingredient is *for*.
    // Display-only (no check-off): one ingredient can serve several recipes, so
    // there's no single row to tick. Shopping mode always uses the aisle view.
    const byRecipeHtml = groceryGroups().map((g) => `
      <div class="g-recipe">
        <p class="g-recipe-name">${esc(g.name)}</p>
        <p class="g-recipe-serv">${g.servings} ${esc(g.label)}</p>
        <ul class="g-items">
          ${g.lines.map((l) => `<li><span class="ing-amt">${esc(l.amtStr)}</span><span>${esc(displayGroceryName(l.item))}</span></li>`).join("")}
        </ul>
      </div>`).join("") || `<p class="g-empty">Add a recipe to your list to see it broken out here.</p>`;

    groceryContent.innerHTML = `
      <form id="grocery-add-manual" class="g-add-manual">
        <input type="text" id="grocery-manual-input" placeholder="Add an item\u2026" autocomplete="off">
        <button type="submit" class="ghost-btn small">Add</button>
      </form>
      <label class="g-staples-toggle" title="Salt, pepper, oil, water, sugar, butter and flour">
        <input type="checkbox" id="grocery-skip-staples" ${skipPantryStaples ? "checked" : ""}>
        Skip salt, oil and other staples
      </label>
      <nav class="scope g-view" role="group" aria-label="Group the list by">
        <button type="button" class="scope-btn${groceryView === "aisle" ? " is-on" : ""}" data-g-view="aisle" aria-pressed="${groceryView === "aisle"}">\ud83d\uded2 By aisle</button>
        <button type="button" class="scope-btn${groceryView === "recipe" ? " is-on" : ""}" data-g-view="recipe" aria-pressed="${groceryView === "recipe"}">\ud83c\udf7d By recipe</button>
      </nav>
      ${groceryView === "recipe"
        ? `<div class="g-by-recipe-view">${byRecipeHtml}</div>`
        : `<ul class="g-combined">${itemsHtml}</ul>`}
      ${groceryView === "aisle" && heldInPantry.length ? `
      <details class="g-pantry">
        <summary>Already in your pantry (${heldInPantry.length})</summary>
        <ul class="g-items">
          ${heldInPantry.map((it) => `
            <li class="g-pantry-row">
              <span>${esc(it.item)}</span>
              <button type="button" class="ghost-btn small" data-pantry-keep="${esc(it.key)}">Add back</button>
            </li>`).join("")}
        </ul>
      </details>` : ""}
      ${groceryView === "aisle" ? renderAisleReorder() : ""}`;
    renderGroceryProgress(toBuy);
    renderGroceryCount(toBuy);
  }

  // `items` is optional — renderGroceryPanel passes its already-partitioned
  // to-buy list so the work isn't repeated; standalone callers (check-off) omit
  // it. Pantry-held items never count toward shopping progress.
  function renderGroceryProgress(items) {
    if (!items) items = partitionPantry(allGroceryItems()).toBuy;
    const total = items.length;
    const done = items.filter((it) => checkedGroceryItems.has(it.key)).length;
    groceryProgressEl.hidden = !shoppingModeOn || !total;
    groceryProgressEl.textContent = `✓ ${done} of ${total}`;
  }

  function setShoppingMode(on) {
    shoppingModeOn = on;
    // Shopping mode is for ticking items off, which the reference "by recipe"
    // view can't do — snap back to the aisle list on the way in.
    const snapped = on && groceryView !== "aisle";
    if (snapped) { groceryView = "aisle"; saveLocal("groceryView", groceryView); }
    groceryPanel.classList.toggle("shopping", on);
    shoppingModeToggle.setAttribute("aria-pressed", String(on));
    shoppingModeToggle.textContent = on ? "\u2713 Done shopping" : "Start shopping";
    // renderGroceryPanel re-runs the progress counter itself.
    if (snapped && !groceryPanel.hidden) renderGroceryPanel(); else renderGroceryProgress();
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
    // Mirrors the panel: pantry-held items are left out (you're not buying them)
    // and quantities use the same purchase units shown on screen.
    const remaining = partitionPantry(allGroceryItems())
      .toBuy.filter((it) => !checkedGroceryItems.has(it.key));
    groceryByCategory(remaining).forEach((sec) => {
      out += `\u2014 ${sec.category.toUpperCase()} \u2014\n`;
      sec.items.forEach((it) => {
        const qty = groceryQtyStr(it);
        out += `- ${qty ? qty + " " : ""}${it.item}${recipeCountLabel(it)}\n`;
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

  // The recipe's next planned meal in the coming week, if any \u2014 what the open
  // recipe's "Plan a night" button reports ("\u2713 Planned Fri").
  function plannedEntry(id) {
    const today = isoDate(midnight());
    const end = isoDate(addDays(midnight(), 6));
    return mealPlan
      .filter((e) => e.recipeId === id && e.date >= today && e.date <= end)
      .sort((a, b) => a.date.localeCompare(b.date))[0] || null;
  }
  // "tonight" / "tomorrow" / "Fri" \u2014 how a person says which night.
  function nightName(ds, slot = "dinner") {
    if (ds === isoDate(midnight())) return slot === "dinner" ? "tonight" : "today";
    if (ds === isoDate(addDays(midnight(), 1))) return "tomorrow";
    return parseIsoDate(ds).toLocaleDateString(undefined, { weekday: "short" });
  }
  function planBtnLabel(id) {
    const e = plannedEntry(id);
    return e ? `\u2713 Planned ${nightName(e.date, e.slot)}` : "Plan a night";
  }
  // Same idea as paintStar: the open detail's plan button is the only thing on
  // the list that shows plan state, so touch only that.
  function paintPlanState(id) {
    const btn = listEl.querySelector(`.item[data-id="${CSS.escape(id)}"] .plan-night-btn`);
    if (!btn) return;
    btn.textContent = planBtnLabel(id);
    btn.classList.toggle("is-on", !!plannedEntry(id));
  }
  function setTrayMembership(id, on) {
    if (on) mealPlanTray.add(id); else mealPlanTray.delete(id);
    saveLocal("mealTray", [...mealPlanTray]);
    renderStagedCount();
    renderMealPlan();
  }
  function addToMealPlanTray(id) {
    setTrayMembership(id, true);
    toast("Saved for planning \u2014 it\u2019s waiting under Meal plan");
  }
  function removeFromTray(id) {
    setTrayMembership(id, false);
  }

  function renderStagedCount() {
    const el = $("#staged-count");
    if (!el) return;
    const n = mealPlanTray.size;
    el.hidden = !n || section === "cocktails";   // meal planning lives on the Kitchen tab
    el.textContent = n === 1 ? "1 recipe saved for planning \u2192" : `${n} recipes saved for planning \u2192`;
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
    if (error) { toastError("Couldn\u2019t add that to the plan", error); return false; }
    mealPlan.push({ id: data.id, recipeId, date, slot, servings, purchasedAt: null });
    renderMealPlan();
    paintPlanState(recipeId);
    renderTonight();
    return true;
  }

  async function removeMealEntry(entryId) {
    const { error } = await supabaseClient.from("meal_plan_entries").delete().eq("id", entryId);
    if (error) { toastError("Couldn\u2019t remove that", error); return false; }
    const gone = mealPlan.find((e) => e.id === entryId);
    mealPlan = mealPlan.filter((e) => e.id !== entryId);
    renderMealPlan();
    if (gone) paintPlanState(gone.recipeId);
    renderTonight();
    return true;
  }

  // "Plan a night" from an open recipe: one tap on a night schedules dinner.
  // It used to be Stage for plan \u2192 Meal plan \u2192 tap the recipe \u2192 tap a day;
  // fine for a Sunday session, heavy for "tacos Friday". The tray stays as
  // "Not sure yet \u2014 save it for planning".
  function openPlanNightSheet(recipeId) {
    if (!byId[recipeId]) return;
    if (!session) { toast("Sign in to plan meals."); return; }
    placeSheetState = { mode: "night", recipeId };
    renderPlaceSheet();
    placeSheet.hidden = false;
  }
  async function planNight(recipeId, ds) {
    if (!(await assignMealEntry(recipeId, ds, "dinner"))) return;
    // Planned is no longer "not sure yet".
    if (mealPlanTray.has(recipeId)) setTrayMembership(recipeId, false);
    toast(`Planned for ${nightName(ds)}`);
  }
  function planNightSheetHtml(id) {
    const it = byId[id];
    const days = [0, 1, 2, 3, 4, 5, 6].map((i) => {
      const d = addDays(midnight(), i);
      const ds = isoDate(d);
      const { wd, md } = dayLabel(d);
      const day = i === 0 ? `Tonight \u00B7 ${wd} ${md}` : i === 1 ? `Tomorrow \u00B7 ${wd} ${md}` : `${wd} ${md}`;
      const dinners = mealPlan.filter((e) => e.date === ds && e.slot === "dinner");
      const mine = dinners.find((e) => e.recipeId === id);
      const others = dinners.filter((e) => e.recipeId !== id).map((e) => byId[e.recipeId]?.name).filter(Boolean);
      const note = mine
        ? `Planned${others.length ? ` with ${others.join(", ")}` : ""}`
        : others.length ? `${others.join(", ")} planned` : "Nothing planned";
      const action = mine ? "Remove" : others.length ? "Add too" : "Plan";
      const cls = mine ? " is-mine" : others.length ? " is-taken" : "";
      return `<button type="button" class="ps-night${cls}" ${mine ? `data-night-remove="${esc(mine.id)}"` : `data-night="${ds}"`}>
        <span class="ps-night-text"><span class="ps-night-day">${esc(day)}</span><span class="ps-night-note">${esc(note)}</span></span>
        <span class="ps-night-action">${action}</span>
      </button>`;
    }).join("");
    const later = mealPlanTray.has(id)
      ? `<p class="ps-later-note">\u2713 Saved for planning. <button type="button" class="link-btn" data-later-remove>Take it off</button></p>`
      : `<button type="button" class="link-btn ps-later" data-later>Not sure yet \u2014 save it for planning</button>`;
    return `<p class="ps-sub">${esc(it.name)} \u00B7 ${defaultAddServings(it)} ${esc(it.servingsLabel)}</p>
      <div class="ps-nights">${days}</div>
      ${later}`;
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
    if (placeSheetState.mode === "night") {
      placeSheetTitle.textContent = "Which night?";
      placeSheetBody.innerHTML = planNightSheetHtml(placeSheetState.recipeId);
    } else if (placeSheetState.mode === "slot") {
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
        if (!it) return "";
        // Already scheduled somewhere in the visible window — gray it out so
        // adding it to a second night is a deliberate choice, not a slip.
        const already = mealPlan.some((e) => e.recipeId === id);
        return `<button class="ps-recipe-btn${already ? " is-planned" : ""}" data-recipe="${esc(id)}">${esc(it.name)}${already ? ` <span class="ps-recipe-planned-tag">already planned</span>` : ""}</button>`;
      }).filter(Boolean).join("");
      placeSheetBody.innerHTML = `<div class="ps-recipes">${recipeBtns}</div>`;
    }
  }
  placeSheet.addEventListener("click", async (e) => {
    if (e.target === placeSheet) { closePlaceSheet(); return; }
    const night = e.target.closest("[data-night]");
    if (night) {
      const id = placeSheetState.recipeId;
      closePlaceSheet();
      planNight(id, night.dataset.night);
      return;
    }
    const nightRemove = e.target.closest("[data-night-remove]");
    if (nightRemove) {
      nightRemove.disabled = true;
      if (await removeMealEntry(nightRemove.dataset.nightRemove)) renderPlaceSheet();
      else nightRemove.disabled = false;
      return;
    }
    if (e.target.closest("[data-later]")) {
      const id = placeSheetState.recipeId;
      closePlaceSheet();
      addToMealPlanTray(id);
      return;
    }
    if (e.target.closest("[data-later-remove]")) {
      removeFromTray(placeSheetState.recipeId);
      renderPlaceSheet();
      return;
    }
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
    const totals = planServingTotals(upcoming);
    if (!totals.size) { toast("Those planned recipes aren't available."); return; }
    // Full server-side replace: wipe the existing basket + check-offs, then
    // write the new one — manual items are deliberately left untouched.
    if (session) {
      const [{ error: e1 }, { error: e2 }] = await Promise.all([
        supabaseClient.from("grocery_basket_items").delete().eq("user_id", session.user.id),
        supabaseClient.from("grocery_checked_items").delete().eq("user_id", session.user.id)
      ]);
      const rows = [...totals.entries()].map(([recipe_id, servings]) => ({ recipe_id, servings }));
      const { error: e3 } = await supabaseClient.from("grocery_basket_items").insert(rows);
      if (e1 || e2 || e3) { toast("Couldn't rebuild your grocery list — try again.", true); return; }
    }
    basket.clear();
    checkedGroceryItems.clear();
    totals.forEach((s, id) => basket.set(id, { servings: s }));
    const now = new Date().toISOString();
    const ids = upcoming.map((e) => e.id);
    await supabaseClient.from("meal_plan_entries").update({ purchased_at: now }).in("id", ids);
    upcoming.forEach((e) => { e.purchasedAt = now; });
    setViewMode("recipes");
    renderList();
    renderGroceryCount();
    renderGroceryPanel();
    groceryPanel.hidden = false;
  }

  // ---------- Send the week's plan outside the app ----------
  // The coming 7 days (the same window as Create grocery list) as one
  // self-contained page for the household, in the same design language as a
  // sent recipe. It answers the three things a family asks of a plan:
  //   - what's on each night        -> the week at a glance (gaps shown, so
  //                                    "leftovers night" is visible too);
  //   - what do we need to buy      -> ONE shopping list for the whole week,
  //                                    merged and in the cook's aisle order;
  //   - what goes into tonight's    -> each recipe's ingredients at its planned
  //                                    servings, in the order it's cooked.
  // No methods (it's a plan, not a cookbook); an imported recipe links back to
  // its original for those. No script in the page: the list's checkboxes are
  // plain inputs, so they tick wherever the file opens, and printing gives a
  // fridge copy (the week) and a store copy (the list) on separate pages.

  // Upcoming entries whose recipe still exists, in day-then-meal order.
  function upcomingPlanEntries() {
    const start = isoDate(midnight());
    const end = isoDate(addDays(midnight(), 6));
    return mealPlan
      .filter((e) => e.date >= start && e.date <= end && byId[e.recipeId])
      .sort((a, b) => a.date.localeCompare(b.date) || SLOTS.indexOf(a.slot) - SLOTS.indexOf(b.slot));
  }

  // Servings per recipe across the week: a recipe planned twice is bought twice.
  function planServingTotals(entries) {
    const totals = new Map();
    entries.forEach((e) => {
      const it = byId[e.recipeId];
      if (!it) return;
      totals.set(e.recipeId, (totals.get(e.recipeId) || 0) + (e.servings ?? it.baseServings));
    });
    return totals;
  }

  const SLOT_PLURAL = { breakfast: "breakfasts", lunch: "lunches", dinner: "dinners" };
  // "5 dinners, 2 lunches and 1 breakfast" — dinner first, it's the plan's spine.
  function mealCountPhrase(entries) {
    const parts = [...SLOTS].reverse().map((slot) => {
      const n = entries.filter((e) => e.slot === slot).length;
      return n ? `${n} ${n === 1 ? slot : SLOT_PLURAL[slot]}` : "";
    }).filter(Boolean);
    return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}` : (parts[0] || "");
  }

  function entryWhen(e) {
    return `${dayLabel(parseIsoDate(e.date)).wd} ${e.slot}`;
  }

  // Everything the page and its plain-text twin show, computed once.
  function mealPlanShareModel(entries) {
    const start = midnight();
    const days = [0, 1, 2, 3, 4, 5, 6].map((i) => {
      const d = addDays(start, i);
      const ds = isoDate(d);
      return { ...dayLabel(d), entries: entries.filter((e) => e.date === ds) };
    });
    // One card per recipe, in the order it's first cooked; the week's meals link to it.
    const cardMap = new Map();
    entries.forEach((e) => {
      if (!cardMap.has(e.recipeId)) cardMap.set(e.recipeId, { it: byId[e.recipeId], entries: [] });
      cardMap.get(e.recipeId).entries.push(e);
    });
    const cards = [...cardMap.values()].map((c, i) => {
      // Usually every night uses the same servings; if not, one list per size.
      const bySize = new Map();
      c.entries.forEach((e) => {
        const s = e.servings ?? c.it.baseServings;
        if (!bySize.has(s)) bySize.set(s, []);
        bySize.get(s).push(e);
      });
      return { ...c, anchor: `r${i + 1}`, sizes: [...bySize.entries()].map(([servings, es]) => ({ servings, entries: es })) };
    });
    const anchorFor = new Map(cards.map((c) => [c.it.id, c.anchor]));
    const source = [...planServingTotals(entries)].map(([id, servings]) => [id, { servings }]);
    const { toBuy, heldInPantry } = partitionPantry(combinedGroceryItems(source));
    return {
      startLabel: start.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      rangeLabel: [start, addDays(start, 6)]
        .map((d) => d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })).join(" – "),
      fileDate: isoDate(start),
      days, cards, anchorFor,
      // Slot labels only earn their space when the week mixes meals.
      showSlots: entries.some((e) => e.slot !== "dinner"),
      meals: mealCountPhrase(entries),
      aisles: groceryByCategory(toBuy),
      toBuyCount: toBuy.length,
      heldInPantry,
      skipStaples: skipPantryStaples,
      manyRecipes: cards.length > 1
    };
  }

  // A recipe's ingredient list at a serving size, grouped into its components
  // ("Dough", "Sauce"). Shared by a sent recipe and the sent meal plan.
  function shareIngredientsHtml(it, servings, system, groupTag = "h3") {
    const isBar = it.section === "bar";
    return groupRuns(scaledIngredients(it, servings)).map((run) => {
      const items = run.items.map((ing) => {
        const l = ingLine(ing, true, system, isBar);
        const amt = l.amtStr && l.amtStr !== "—" ? `<b>${esc(l.amtStr)}</b> ` : "";
        return `<li>${amt}${esc(l.item)}</li>`;
      }).join("");
      return `${run.group ? `<${groupTag} class="grp">${esc(run.group)}</${groupTag}>` : ""}<ul class="pts">${items}</ul>`;
    }).join("");
  }
  function shareSpecsHtml(it) {
    return it.specs
      ? Object.entries(it.specs).filter(([, v]) => v)
          .map(([k, v]) => `<li><b>${esc(k[0].toUpperCase() + k.slice(1))}:</b> ${esc(v)}</li>`).join("")
      : "";
  }

  // An imported recipe's original is where its method lives now.
  function sourceUrl(source) {
    const s = String(source || "").trim();
    return /^https?:\/\/\S+$/i.test(s) ? s : "";
  }
  function sourceHost(url) {
    try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; }
  }
  function recipeNamesLabel(names) {
    return names.length <= 2 ? names.join(", ") : `${names.slice(0, 2).join(", ")} +${names.length - 2} more`;
  }

  function mealPlanShareHtml(m, system) {
    const weekHtml = m.days.map((d) => {
      const meals = d.entries.map((e) => {
        const it = byId[e.recipeId];
        return `<li>${m.showSlots ? `<span class="slot">${esc(slotLabel(e.slot))}</span>` : ""}<a href="#${m.anchorFor.get(e.recipeId)}">${esc(it.name)}</a></li>`;
      }).join("");
      return `<li class="day">
        <p class="d"><span class="wd">${esc(d.wd)}</span><span class="md">${esc(d.md)}</span></p>
        ${meals ? `<ul class="meals">${meals}</ul>` : `<p class="none">Nothing planned</p>`}
      </li>`;
    }).join("");

    const aislesHtml = m.aisles.map((sec) => `
      <div class="aisle">
        <h3>${esc(sec.category)}</h3>
        <ul class="shop">${sec.items.map((g) => {
          const qty = groceryQtyStr(g);
          const forLine = m.manyRecipes && g.recipes.length ? `<small>for ${esc(recipeNamesLabel(g.recipes))}</small>` : "";
          return `<li><label><input type="checkbox"><span>${qty ? `<b>${esc(qty)}</b> ` : ""}${esc(g.item)}${forLine}</span></label></li>`;
        }).join("")}</ul>
      </div>`).join("");
    const notes = [
      m.skipStaples ? "Salt, pepper, oil, sugar, butter and flour are left off — check you have enough." : "",
      m.heldInPantry.length ? `<b>Already at home</b> (from the pantry list): ${esc(m.heldInPantry.map((g) => g.item).join(", "))}.` : ""
    ].filter(Boolean);

    const cardsHtml = m.cards.map((c) => {
      const it = c.it;
      const url = sourceUrl(it.source);
      const label = esc(it.servingsLabel || "servings");
      const single = c.sizes.length === 1;
      const meta = [
        single ? `${esc(fmtAmount(c.sizes[0].servings))} ${label}${c.entries.length > 1 ? " each time" : ""}` : "",
        url ? `<a href="${esc(url)}">Full recipe on ${esc(sourceHost(url))} ↗</a>`
          : (it.source ? `Source: ${esc(it.source)}` : "")
      ].filter(Boolean).join("  ·  ");
      const lists = single
        ? shareIngredientsHtml(it, c.sizes[0].servings, system, "h4")
        : c.sizes.map((sz) => `<p class="for">${esc(fmtAmount(sz.servings))} ${label} — ${esc(sz.entries.map(entryWhen).join(", "))}</p>${shareIngredientsHtml(it, sz.servings, system, "h4")}`).join("");
      const specs = shareSpecsHtml(it);
      return `<article class="card" id="${c.anchor}" style="--c:${it.section === "bar" ? "#B5402A" : "#3E6B3A"}">
        <p class="when">${esc(c.entries.map(entryWhen).join("  ·  "))}</p>
        <h3>${esc(it.name)}</h3>
        ${it.subtitle ? `<p class="lede">${esc(it.subtitle)}</p>` : ""}
        ${meta ? `<p class="meta">${meta}</p>` : ""}
        ${lists}
        ${specs ? `<ul class="pts">${specs}</ul>` : ""}
      </article>`;
    }).join("");

    const toBuy = `${m.toBuyCount} ${m.toBuyCount === 1 ? "thing" : "things"} to buy`;
    const recipesN = `${m.cards.length} ${m.cards.length === 1 ? "recipe" : "recipes"}`;
    return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Meal plan, week of ${esc(m.startLabel)} — The House Index</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="${GUIDE_FONTS}" rel="stylesheet">
<style>
  :root { --paper:#FCFBF8; --ink:#2A2520; --lede:#463f37; --faint:#8A8276; --line:#E8E3D9; --accent:#3E6B3A; }
  * { box-sizing:border-box; }
  html { -webkit-text-size-adjust:100%; }
  body { margin:0; background:var(--paper); color:var(--ink);
         font-family:"Public Sans",-apple-system,system-ui,sans-serif; }
  .doc { max-width:46em; margin:0 auto; padding:36px clamp(16px,5vw,40px) 64px; }
  .kicker, .sub, .jump a, h2 .count, .d .wd, .meals .slot, .aisle h3, .card .when, .card .meta, .for, .closer {
    font-family:"IBM Plex Mono",ui-monospace,monospace; }
  .kicker { font-size:11px; font-weight:500; letter-spacing:.14em; text-transform:uppercase; color:var(--accent);
            margin:0 0 10px; display:flex; align-items:center; gap:10px; }
  .kicker::before { content:""; width:22px; height:2px; background:var(--accent); display:inline-block; }
  h1 { font-family:"Fraunces",Georgia,serif; font-weight:700; font-size:34px; line-height:1.05;
       letter-spacing:-.015em; margin:0 0 12px; text-wrap:balance; }
  .lede { font-size:17px; line-height:1.55; color:var(--lede); margin:0 0 8px; }
  .sub { font-size:12px; color:var(--faint); margin:0; }
  .hero { border-bottom:1px solid var(--line); padding-bottom:22px; margin-bottom:8px; }
  .jump { display:flex; flex-wrap:wrap; gap:8px; list-style:none; margin:16px 0 0; padding:0; }
  .jump a { display:inline-block; font-size:12px; color:var(--ink); text-decoration:none; background:#fff;
            border:1px solid var(--line); border-radius:999px; padding:9px 14px; }
  section { scroll-margin-top:12px; }
  h2 { font-family:"Fraunces",Georgia,serif; font-weight:600; font-size:23px; margin:30px 0 12px;
       display:flex; flex-wrap:wrap; align-items:baseline; gap:4px 10px; }
  h2 .count { font-size:12px; font-weight:500; color:var(--faint); }
  .hint { font-size:14px; line-height:1.5; color:var(--faint); margin:-4px 0 16px; }

  .week { list-style:none; margin:0; padding:0; border-top:1px solid var(--line); }
  .day { display:grid; grid-template-columns:4.4em minmax(0,1fr); gap:12px; padding:12px 0; border-bottom:1px solid var(--line); }
  .d { margin:0; line-height:1.3; }
  .d .wd { display:block; font-size:11px; font-weight:500; letter-spacing:.12em; text-transform:uppercase; color:var(--accent); }
  .d .md { font-size:14px; color:var(--lede); }
  .meals { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:8px; justify-content:center; }
  .meals li { font-size:16px; line-height:1.35; overflow-wrap:anywhere; }
  .meals .slot { display:block; font-size:10.5px; letter-spacing:.1em; text-transform:uppercase; color:var(--faint); }
  .meals a { color:var(--ink); font-weight:600; text-decoration:none; border-bottom:1px solid var(--line); }
  .none { margin:0; align-self:center; font-size:14px; font-style:italic; color:var(--faint); }

  .aisle { break-inside:avoid; margin:0 0 20px; }
  .aisle h3 { font-size:11px; font-weight:500; letter-spacing:.14em; text-transform:uppercase; color:var(--accent);
              margin:0; padding-bottom:6px; border-bottom:1px solid var(--line); }
  .shop { list-style:none; margin:0; padding:0; }
  .shop li { border-bottom:1px dashed var(--line); }
  .shop label { display:flex; align-items:flex-start; gap:12px; min-height:44px; padding:11px 0; cursor:pointer;
                font-size:15px; line-height:1.4; color:var(--lede); overflow-wrap:anywhere; }
  .shop input { flex:none; width:20px; height:20px; margin:0; accent-color:var(--accent); }
  .shop b { font-weight:600; color:var(--ink); }
  .shop small { display:block; font-size:12px; color:var(--faint); margin-top:2px; }
  .shop input:checked + span { text-decoration:line-through; opacity:.5; }
  .notes { list-style:none; margin:4px 0 0; padding:12px 14px; background:#fff; border:1px solid var(--line);
           border-radius:12px; font-size:14px; line-height:1.55; color:var(--lede); }
  .notes li + li { margin-top:6px; }
  @media (min-width:720px) { .aisles { columns:2; column-gap:36px; } }

  .card { --c:var(--accent); background:#fff; border:1px solid var(--line); border-radius:14px;
          padding:18px clamp(14px,4vw,22px) 10px; margin:0 0 16px; scroll-margin-top:12px; }
  .card .when { font-size:11px; font-weight:500; letter-spacing:.12em; text-transform:uppercase; color:var(--c); margin:0 0 8px; }
  .card h3 { font-family:"Fraunces",Georgia,serif; font-weight:600; font-size:21px; line-height:1.2; margin:0 0 6px; overflow-wrap:anywhere; }
  .card .lede { font-size:15px; margin:0 0 6px; }
  .card .meta { font-size:12px; color:var(--faint); margin:0 0 14px; overflow-wrap:anywhere; }
  .card .meta a { color:var(--c); text-decoration:none; }
  h4.grp { font-family:"Fraunces",Georgia,serif; font-weight:600; font-size:15px; margin:14px 0 8px; color:var(--lede); }
  .for { font-size:12px; color:var(--lede); margin:14px 0 8px; }
  .pts { list-style:none; margin:0 0 8px; padding:0; }
  .pts li { position:relative; padding-left:20px; font-size:15px; line-height:1.5; margin-bottom:7px; color:var(--lede); overflow-wrap:anywhere; }
  .pts li::before { content:""; position:absolute; left:0; top:8px; width:7px; height:7px; border-radius:50%; background:var(--c); }
  .pts li b { font-weight:600; color:var(--ink); }
  .closer { border-top:1px solid var(--line); margin-top:30px; padding-top:18px; font-size:11px; color:var(--faint); }
  .closer a { color:var(--accent); text-decoration:none; }

  @media print {
    @page { margin:1.3cm; }
    body { background:#fff; }
    .doc { max-width:none; padding:0; }
    .jump { display:none; }
    #shop, #recipes { break-before:page; }
    h2 { margin-top:0; }
    .aisles { columns:2; column-gap:28px; }
    .shop label { min-height:0; padding:5px 0; }
    .card { break-inside:avoid; border-color:#cfcac0; }
    a { color:var(--ink) !important; border:0 !important; }
  }
</style>
</head><body>
<main class="doc">
  <section class="hero">
    <p class="kicker">Meal plan</p>
    <h1>Week of ${esc(m.startLabel)}</h1>
    <p class="lede">${esc(m.meals)} — ${esc(recipesN)}, ${esc(toBuy)}.</p>
    <p class="sub">${esc(m.rangeLabel)}</p>
    <ul class="jump">
      <li><a href="#week">The week</a></li>
      <li><a href="#shop">Shopping list</a></li>
      <li><a href="#recipes">Recipes</a></li>
    </ul>
  </section>
  <section id="week">
    <h2>The week</h2>
    <ol class="week">${weekHtml}</ol>
  </section>
  <section id="shop">
    <h2>Shopping list <span class="count">${esc(toBuy)}</span></h2>
    <p class="hint">Everything for the week in one trip, in aisle order. Tick things off as you go.</p>
    <div class="aisles">${aislesHtml || `<p class="hint">Nothing to buy — it’s all at home already.</p>`}</div>
    ${notes.length ? `<ul class="notes">${notes.map((n) => `<li>${n}</li>`).join("")}</ul>` : ""}
  </section>
  <section id="recipes">
    <h2>Recipes <span class="count">${esc(recipesN)} · ingredients only</span></h2>
    ${cardsHtml}
  </section>
  <p class="closer">Made with <a href="${APP_URL}">The House Index</a></p>
</main>
</body></html>`;
  }

  // Plain-text twin for share targets that can't take a file attachment.
  function mealPlanShareText(m, system) {
    const lines = [`Meal plan — week of ${m.startLabel}`, m.rangeLabel, "", "THE WEEK"];
    m.days.forEach((d) => {
      const meals = d.entries.map((e) => (m.showSlots ? `${slotLabel(e.slot)}: ` : "") + byId[e.recipeId].name);
      lines.push(`${d.wd} ${d.md}: ${meals.length ? meals.join("; ") : "nothing planned"}`);
    });
    lines.push("", "SHOPPING LIST");
    m.aisles.forEach((sec) => {
      lines.push(`— ${sec.category.toUpperCase()} —`);
      sec.items.forEach((g) => {
        const qty = groceryQtyStr(g);
        lines.push(`- ${qty ? qty + " " : ""}${g.item}`);
      });
    });
    if (m.skipStaples) lines.push("(Salt, pepper, oil, sugar, butter and flour left off.)");
    if (m.heldInPantry.length) lines.push(`Already at home: ${m.heldInPantry.map((g) => g.item).join(", ")}`);
    lines.push("", "RECIPES (ingredients only)");
    m.cards.forEach((c) => {
      const it = c.it;
      lines.push("", `${it.name} — ${c.entries.map(entryWhen).join(", ")}`);
      c.sizes.forEach((sz) => {
        lines.push(`[${fmtAmount(sz.servings)} ${it.servingsLabel || "servings"}${c.sizes.length > 1 ? ` — ${sz.entries.map(entryWhen).join(", ")}` : ""}]`);
        groupRuns(scaledIngredients(it, sz.servings)).forEach((run) => {
          if (run.group) lines.push(`${run.group}:`);
          run.items.forEach((ing) => {
            const l = ingLine(ing, true, system, it.section === "bar");
            lines.push(`- ${l.amtStr && l.amtStr !== "—" ? l.amtStr + " " : ""}${l.item}`);
          });
        });
      });
      const url = sourceUrl(it.source);
      if (url) lines.push(`Full recipe: ${url}`);
    });
    lines.push("", `Made with The House Index — ${APP_URL}`);
    return lines.join("\n");
  }

  function shareMealPlan() {
    const entries = upcomingPlanEntries();
    if (!entries.length) { toast("No upcoming meals planned yet."); return; }
    // Built synchronously from what's on screen: the share sheet has to open
    // inside the tap (iOS drops the gesture across an await of the network).
    const model = mealPlanShareModel(entries);
    return shareHtmlFile({
      html: mealPlanShareHtml(model, unitSystem),
      filename: `meal-plan-${model.fileDate}.html`,
      title: `Meal plan — week of ${model.startLabel}`,
      text: () => mealPlanShareText(model, unitSystem),
      savedMsg: "Saved the meal plan page — attach it to a text or email"
    });
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
      : `<p class="mp-empty">Open a recipe and tap <b>Plan a night</b> to put it on a day. Not sure which night yet? Save it for planning and it waits here; tap it and a day below when you\u2019ve decided.</p>`;

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
          <div class="mp-head-actions">
            <button id="mp-send-plan" class="ghost-btn small" title="Send this week's plan as a page: the meals, one shopping list, and each recipe's ingredients"${upcomingCount ? "" : " disabled"}>\ud83d\udce4 Send plan</button>
            <button id="mp-make-grocery" class="solid-btn small"${upcomingCount ? "" : " disabled"}>\ud83d\uded2 Create grocery list</button>
          </div>
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

    updateMealplanBadge();
  }

  // At 5:40 pm the question is "what's for dinner?", and the home screen
  // answered "here are your recipes, A\u2013Z". When tonight has a planned dinner
  // it sits above the list: name, a line about it, Start cooking and Recipe.
  // Nothing otherwise \u2014 no empty "plan tonight?" nag.
  function renderTonight() {
    if (!tonightEl) return;
    const today = isoDate(midnight());
    const entries = section === "recipes" && viewMode === "recipes"
      ? mealPlan.filter((e) => e.date === today && e.slot === "dinner" && byId[e.recipeId])
      : [];
    if (!entries.length) { tonightEl.hidden = true; tonightEl.innerHTML = ""; return; }
    const e = entries[0];
    const it = byId[e.recipeId];
    const serv = e.servings || chosenServings(it);
    const weekday = new Date().toLocaleDateString(undefined, { weekday: "long" });
    const meta = [it.subtitle, `${serv} ${it.servingsLabel}`,
      basket.has(it.id) ? "on your grocery list" : e.purchasedAt ? "shopped for" : ""].filter(Boolean);
    const also = entries.slice(1).map((x) => byId[x.recipeId].name);
    tonightEl.innerHTML = `
      <p class="tonight-kicker">Tonight \u00B7 ${esc(weekday)}</p>
      <h2 class="tonight-name" id="tonight-name">${esc(it.name)}</h2>
      <p class="tonight-meta">${esc(meta.join(" \u00B7 "))}</p>
      <div class="tonight-actions">
        ${it.method && it.method.length ? `<button type="button" class="solid-btn" data-tonight-cook="${esc(it.id)}" data-serv="${serv}">Start cooking</button>` : ""}
        <button type="button" class="ghost-btn" data-tonight-open="${esc(it.id)}">Recipe</button>
      </div>
      ${also.length ? `<p class="tonight-also">Also tonight: ${esc(also.join(", "))}</p>` : ""}`;
    tonightEl.hidden = false;
  }
  tonightEl.addEventListener("click", (ev) => {
    const cook = ev.target.closest("[data-tonight-cook]");
    if (cook) {
      const it = byId[cook.dataset.tonightCook];
      if (it) openCookMode(it, Number(cook.dataset.serv) || chosenServings(it));
      return;
    }
    const open = ev.target.closest("[data-tonight-open]");
    if (open) openExistingRecipe(open.dataset.tonightOpen);
  });

  // Counts what's SCHEDULED in the next 7 days plus what's STAGED in the tray.
  // It used to count scheduled meals only, so staging a recipe left the detail
  // button reading "\u2713 In meal plan" while the badge sat at 0 \u2014 three signals
  // for one piece of state, two of them wrong. Also drives whether the Meal
  // plan tab is shown at all, so it reads from state rather than taking a count
  // from whoever happened to call it.
  function updateMealplanBadge() {
    const todayStr = isoDate(midnight());
    const endStr = isoDate(addDays(midnight(), 6));
    const scheduled = mealPlan.filter((e) => e.date >= todayStr && e.date <= endStr).length;
    const n = scheduled + mealPlanTray.size;
    const b = $("#mealplan-count");
    b.textContent = n;
    b.hidden = !n;
    syncModeTabs(n > 0);
  }

  // The Meal plan tab only earns its 80px of the first screen once there's
  // something in it. Planning a night or saving a recipe for planning (both from
  // "Plan a night" in the open recipe) brings it straight back, and the "N
  // recipes saved for planning" pill under the list is the other way in.
  // Meal planning is Kitchen-only; Bottles is Bar-only. On the Bar tab the row
  // is always there (for Bottles); on Kitchen it shows once something is planned.
  function syncModeTabs(hasPlan) {
    if (!modeTabsEl) return;
    const bar = section === "cocktails";
    modeRecipesBtn.textContent = bar ? "Cocktails" : "Recipes";
    modeBottlesBtn.hidden = !bar;
    modeMealplanBtn.hidden = bar || (!hasPlan && viewMode !== "mealplan");
    modeTabsEl.hidden = !bar && !hasPlan && viewMode === "recipes";
  }

  function setViewMode(mode) {
    if (mode === "bottles" && section !== "cocktails") mode = "recipes";
    if (mode === "mealplan" && section === "cocktails") mode = "recipes";
    viewMode = mode;
    const recipes = mode === "recipes";
    [[modeRecipesBtn, "recipes"], [modeMealplanBtn, "mealplan"], [modeBottlesBtn, "bottles"]].forEach(([btn, m]) => {
      btn.classList.toggle("is-active", mode === m);
      btn.setAttribute("aria-selected", String(mode === m));
    });
    recipesControlsEl.hidden = !recipes;
    // The sticky search bar is full-bleed, so it sits outside #recipes-controls
    // and has to be hidden on its own.
    if (searchStickyEl) searchStickyEl.hidden = !recipes;
    listEl.hidden = !recipes;
    resultRowEl.hidden = !recipes;
    syncPickHint();
    mealPlanView.hidden = mode !== "mealplan";
    bottlesView.hidden = mode !== "bottles";
    // The ＋ adds a recipe, which isn't what anyone is doing in a store aisle.
    addFab.hidden = mode === "bottles";
    renderTonight();
    if (mode === "mealplan") {
      if (!session) { toast("Sign in to plan meals."); setViewMode("recipes"); return; }
      loadMealPlan().then(() => renderMealPlan());
    }
    if (mode === "bottles") {
      if (!session) { toast("Sign in to look up bottles."); setViewMode("recipes"); return; }
      renderBottlesView();
    }
    // Never hide the tabs while the planner is the thing on screen.
    syncModeTabs(mealPlan.length > 0 || mealPlanTray.size > 0);
  }

  function syncScope() {
    const all = !favoritesOnly && !sharedOnly;
    scopeAllBtn.classList.toggle("is-on", all);
    toggleFavoritesBtn.classList.toggle("is-on", favoritesOnly);
    toggleSharedBtn.classList.toggle("is-on", sharedOnly);
    // aria-pressed, not aria-selected: these three are filter toggles in a
    // group, not tabs. The row used to mix both conventions across one set of
    // three buttons, which made "All" an invalid control.
    scopeAllBtn.setAttribute("aria-pressed", String(all));
  }

  // role="status" so a screen reader actually hears these: the toast is this
  // app's main failure channel ("Couldn't update grocery list", "Couldn't load
  // your recipes") and it was announcing to nobody at all. Failures also hold
  // about 3x longer \u2014 2.2s is right for "Recipe added" and far too short to
  // read bad news and work out what to do about it.
  const TOAST_MS = 2200, TOAST_FAIL_MS = 6500;
  function toast(msg, isFailure) {
    let t = document.querySelector(".toast");
    if (!t) {
      t = document.createElement("div");
      t.className = "toast";
      t.setAttribute("role", "status");
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.toggle("is-failure", !!isFailure);
    t.classList.add("show");
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove("show"), isFailure ? TOAST_FAIL_MS : TOAST_MS);
  }

  // An Undo affordance needs a real button, so it's a separate element from the
  // plain toast — that one is pointer-events: none on purpose, so it can never
  // eat a tap meant for the list underneath it.
  let actionToastTimer = null;
  function toastAction(msg, actionLabel, onAction) {
    let t = document.querySelector(".toast-action");
    if (!t) {
      t = document.createElement("div");
      t.className = "toast-action";
      t.setAttribute("role", "status");
      document.body.appendChild(t);
    }
    t.innerHTML = '<span class="toast-action-msg"></span>'
      + '<button type="button" class="toast-action-btn"></button>';
    t.querySelector(".toast-action-msg").textContent = msg;
    const btn = t.querySelector(".toast-action-btn");
    btn.textContent = actionLabel;
    const dismiss = () => { clearTimeout(actionToastTimer); t.classList.remove("show"); };
    btn.addEventListener("click", () => { dismiss(); onAction(); });
    t.classList.add("show");
    clearTimeout(actionToastTimer);
    actionToastTimer = setTimeout(dismiss, 9000);
  }

  // ---------- Error copy ----------
  // Raw PostgREST/Supabase strings ("JWT expired", "duplicate key value
  // violates unique constraint \u2026") are not kitchen language, and they used to
  // go straight into the toast. These three keep the app's own sentence, say
  // what to do about it, and send the provider's text to the console where it
  // belongs \u2014 the same thing friendlyAuthError already does for the sign-in
  // form.

  // A failed save is the error where reassurance matters most: the form is
  // still filled in, nothing was lost, and pressing Save again is safe.
  function saveErrorText(error) {
    if (error && error.message) console.error("Recipe save failed:", error.message);
    const offline = typeof navigator !== "undefined" && navigator.onLine === false;
    return offline
      ? "Couldn\u2019t save \u2014 you look offline. Your recipe is still here; try again when you\u2019re back."
      : "Couldn\u2019t save \u2014 your recipe is still here, so try again.";
  }

  // The Edge Functions author their own user-facing copy \u2014 the daily-cap
  // notice, the "paste the caption instead" guidance for Instagram, the TikTok
  // explanation. Prefixing that with "Error:" turned careful writing into
  // something that reads like a stack trace, so server-authored text is shown
  // as-is and only a transport failure gets a sentence of ours. The functions
  // also say "midnight UTC" because that's where the counter lives \u2014 show
  // the person what that is on their own clock.
  function aiErrorText(data, error) {
    let text = data && data.error ? String(data.error) : "";
    if (!text) {
      if (error && error.message) console.error("AI call failed:", error.message);
      return "That didn\u2019t go through \u2014 check your connection and try again.";
    }
    if (text.includes("midnight UTC")) {
      const reset = new Date();
      reset.setUTCHours(24, 0, 0, 0);
      const local = reset.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      text = text.replace("midnight UTC", `${local} your time`);
    }
    return text;
  }

  // The general one: any failed write that only had a toast to report in.
  function toastError(msg, error) {
    const raw = (error && error.message) || "";
    if (raw) console.error(msg + ":", raw);
    const offline = typeof navigator !== "undefined" && navigator.onLine === false;
    toast(offline ? `${msg} \u2014 you look offline.` : `${msg} \u2014 try again.`, true);
  }

  // ---------- Recipe form (add / edit / delete) ----------
  // The edit field shows at most 3 decimals (2/3 is stored as 0.666…, which is
  // noise in a form); the exact value rides along in data-exact so an untouched
  // row saves back unchanged.
  const roundFormAmount = (n) => Math.round(n * 1000) / 1000;
  function ingredientRow(ing) {
    const exact = ing && typeof ing.amount === "number" && isFinite(ing.amount) ? ing.amount : null;
    const amount = exact != null ? roundFormAmount(exact) : (ing && ing.amount != null ? ing.amount : "");
    const unit = ing && ing.unit != null ? ing.unit : "";
    const item = ing ? ing.item : "";
    // The ▲▼ control only shows in reorder mode (CSS-gated, like the step rows);
    // the save read-back ignores everything but the three inputs, so it's inert.
    return `
      <div class="rf-ing-row">
        <input type="number" step="any" class="rf-ing-amount" placeholder="amt" value="${esc(amount)}"${exact != null ? ` data-exact="${exact}"` : ""}>
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
    recipeFormDirty = false;
    recipeFormPanel.hidden = false;
  }

  // Match a recipe's ingredients against the user's in-stock inventory. Bar
  // rows match on their spirit TYPE (category); pantry rows on their name.
  // Basic staples (salt/pepper/oil…) are assumed on hand and skipped
  // entirely, so the "need" list stays signal, not noise. Returns null when
  // there's no inventory to check against.
  // Compare a grocery-line name to a pantry-stock name — tolerant of spelling and
  // word order, but STRICT about product form. A distinguishing form word
  // (powder/flakes/dried/…) in one but not the other means different products, so
  // "onion" never matches "onion powder"; a misspelling like "tumeric" still
  // matches "turmeric" (edit distance 1). Pure string math — no AI.
  // Distinguishing *processed* forms — "onion powder" is a different product from
  // fresh onion. Note "dried"/"ground" are NOT here: a dried/ground spice IS the
  // pantry form (rule: fresh = buy, dried/ground = pantry), so it should match
  // the base spice ("dried oregano" ↔ "oregano").
  const PANTRY_FORM_RE = /\b(?:powder|flakes?|granulated|dehydrated|paste)\b/;
  // Fresh produce is perishable — always buy it, even if a generic "garlic" or
  // "potato" sits in the inventory. "garlic cloves"/"floury potatoes" -> cart,
  // but a PANTRY_FORM word ("garlic powder") means the shelf-stable version, so
  // that still counts as pantry.
  const FRESH_PRODUCE_RE = /\b(?:garlic|potato|potatoes|onion|shallot|scallion|leek|ginger|celery|carrot)\b/;
  // Non-distinguishing descriptors — the base item with these is the same shelf
  // product, so strip them before comparing words. (fresh is handled earlier as
  // a hard "not pantry" signal, so it never reaches here.)
  const PANTRY_SOFT_RE = /\b(?:ground|dried|whole|large|small|baby|boneless|skinless)\b/g;
  function editDistance(a, b) {
    const m = a.length, n = b.length;
    if (!m) return n; if (!n) return m;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      prev = cur;
    }
    return prev[n];
  }
  function fuzzyWordEq(w1, w2) {
    if (w1 === w2) return true;
    if (w1.length < 5 || w2.length < 5) return false;   // too short to fuzz safely (beef≠beet)
    if (Math.abs(w1.length - w2.length) > 2) return false;
    return editDistance(w1, w2) <= (Math.max(w1.length, w2.length) <= 7 ? 1 : 2);
  }
  function pantryNameMatch(itemNorm, keyNorm) {
    if (!itemNorm || !keyNorm) return false;
    if (itemNorm === keyNorm) return true;
    if (PANTRY_FORM_RE.test(itemNorm) !== PANTRY_FORM_RE.test(keyNorm)) return false;
    const iw = itemNorm.replace(PANTRY_SOFT_RE, " ").split(/\s+/).filter(Boolean);
    const kw = keyNorm.replace(PANTRY_SOFT_RE, " ").split(/\s+/).filter(Boolean);
    if (!iw.length || !kw.length) return false;
    const [short, long] = kw.length <= iw.length ? [kw, iw] : [iw, kw];
    return short.every((w) => long.some((x) => fuzzyWordEq(w, x)));
  }
  // Normalized names of everything in stock — what pantryNameMatch compares a
  // grocery line against. Bar rows match on their spirit TYPE (category).
  // Callers checking many lines compute this once and pass it in: rebuilding it
  // per line was ~90% of a grocery-panel render (every check-off tap).
  function inStockKeys() {
    return inventory
      .filter((i) => i.status === "in")
      .map((i) => normalizeItemName(i.section === "bar" ? i.category : (i.name || i.category)))
      .filter(Boolean);
  }
  function inventoryHaveNeed(ingredients) {
    if (!inventory.length) return null;
    const stockKeys = inStockKeys();
    const have = [], need = [];
    (ingredients || []).forEach((ing) => {
      const raw = flattenText(ing && ing.item != null ? ing.item : ing);
      const norm = normalizeItemName(raw);
      if (!norm || isPantryStaple(norm)) return; // assumed on hand — skip both lists
      if (/\bfresh\b/i.test(raw)) { need.push(displayGroceryName(raw)); return; } // fresh = never pantry
      if (FRESH_PRODUCE_RE.test(norm) && !PANTRY_FORM_RE.test(norm)) { need.push(displayGroceryName(raw)); return; } // fresh produce = buy
      const matched = stockKeys.some((k) => pantryNameMatch(norm, k));
      (matched ? have : need).push(displayGroceryName(raw));
    });
    return { have, need };
  }

  // Is a single grocery-line name something the user already has in stock (bar
  // or pantry, status "in")? Same matching as inventoryHaveNeed; used to skip
  // pantry duplicates from the King Soopers cart. Staples aren't "duplicates" —
  // they're assumed-on-hand and already excluded from the list separately.
  function isInPantryStock(itemName, stockKeys) {
    if (!inventory.length) return false;
    // Fresh produce/herbs are perishable — never pantry stock (rule: fresh = buy,
    // dried/ground = pantry). Checked on the raw name before "fresh" is stripped.
    if (/\bfresh\b/i.test(String(itemName))) return false;
    const norm = normalizeItemName(flattenText(itemName));
    if (!norm || isPantryStaple(norm)) return false;
    // Fresh produce is perishable — buy it even if a generic "garlic"/"potato" is
    // stocked. A PANTRY_FORM word ("garlic powder") means the shelf-stable form.
    if (FRESH_PRODUCE_RE.test(norm) && !PANTRY_FORM_RE.test(norm)) return false;
    return (stockKeys || inStockKeys()).some((k) => pantryNameMatch(norm, k));
  }
  // Why a King Soopers cart line should be skipped by default: a pantry staple
  // (salt/pepper/oil/… — never ordered per recipe, assumed on hand regardless of
  // inventory) or something already stocked in the user's pantry. Returns
  // "staple" | "pantry" | null.
  function krogerSkipReason(itemName, stockKeys) {
    const norm = normalizeItemName(flattenText(itemName));
    if (!norm) return null;
    if (isPantryStaple(norm)) return "staple";
    if (isInPantryStock(itemName, stockKeys)) return "pantry";
    return null;
  }

  // After the generator fills the form, show a quiet "have / need" line
  // against the user's inventory.
  function renderInventoryCheck(recipe) {
    rfInventoryCheck.hidden = true;
    rfInventoryCheck.innerHTML = "";
    const hn = inventoryHaveNeed(recipe.ingredients);
    if (!hn || (!hn.have.length && !hn.need.length)) return;
    const line = (icon, label, items) =>
      items.length ? `<span class="rf-inv-part"><b>${icon} ${label}:</b> ${esc(items.join(", "))}</span>` : "";
    rfInventoryCheck.innerHTML =
      `<p class="rf-inv-lead">Checked against your inventory:</p>` +
      line("✓", "You have", hn.have) + line("🛒", "You'll need", hn.need);
    rfInventoryCheck.hidden = false;
  }

  // THE expensive mistake this form could make: every AI import lands here for
  // review, and both the backdrop tap and Escape used to throw the whole thing
  // away with no question asked. Meanwhile saving was guarded by a busy flag, a
  // disabled button and a duplicate-name check \u2014 all the care was on one side.
  // `force` is the explicit Close button, which stays instant.
  let recipeFormDirty = false;
  function markRecipeFormDirty() { recipeFormDirty = true; }
  function closeRecipeForm(force) {
    if (!force && recipeFormDirty) {
      const name = rfName.value.trim();
      const what = name ? `\u201c${name}\u201d` : "this recipe";
      if (!confirm(`Discard ${what}? Your changes haven\u2019t been saved.`)) return;
    }
    recipeFormDirty = false;
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
    // An AI-filled form is unsaved work even before you touch a field — this is
    // precisely the screen that was being lost to a tap on the dim margin — so
    // it starts dirty rather than waiting for an edit to mark it.
    markRecipeFormDirty();
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

  // This button has been dead: it was only ever shown and hidden, never wired,
  // so tapping "Delete recipe" on an open edit form did nothing at all. Delete
  // was reachable only from the detail row's "⋯ More" menu.
  deleteRecipeBtn.addEventListener("click", async () => {
    const it = byId[rfId.value];
    if (!it) return;
    await deleteRecipe(it);
    if (!byId[it.id]) closeRecipeForm(true); // gone — don't leave its form up
  });

  addRecipeBtn.addEventListener("click", () => openRecipeForm(null));
  // The ✕ Close button is an explicit "I'm done with this" \u2014 no second guess.
  closeRecipeFormBtn.addEventListener("click", () => closeRecipeForm(true));
  recipeFormPanel.addEventListener("click", (e) => {
    if (e.target === recipeFormPanel) closeRecipeForm();
  });
  // One listener on the form catches the static fields and the ingredient/step
  // rows that get added as you go.
  recipeForm.addEventListener("input", markRecipeFormDirty);
  recipeForm.addEventListener("change", markRecipeFormDirty);

  // One save at a time: a double-tap (or Enter + tap) on a slow connection
  // otherwise fires two inserts and saves the recipe twice.
  let recipeSaving = false;
  const recipeFormSubmitBtn = recipeForm.querySelector('button[type="submit"]');
  recipeForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (recipeSaving) return;

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
        const amountInput = row.querySelector(".rf-ing-amount");
        let amount = amountInput.value;
        // Untouched rounded display -> save the exact amount it stands for.
        const exact = amountInput.dataset.exact;
        if (amount !== "" && exact != null && Number(amount) === roundFormAmount(Number(exact))) amount = exact;
        const unit = row.querySelector(".rf-ing-unit").value.trim();
        const itemName = row.querySelector(".rf-ing-item").value.trim();
        // Store the short unit form ("fluid ounces" -> "fl oz") so it's clean at
        // the source going forward; custom units pass through unchanged.
        if (itemName) ingredients.push({ amount: amount === "" ? null : Number(amount), unit: unit ? displayUnit(unit) : null, item: itemName, group: ingGroup });
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
    recipeSaving = true;
    recipeFormSubmitBtn.disabled = true;
    let error, insertedId = null;
    try {
      if (id) {
        ({ error } = await supabaseClient.from("recipes").update(row).eq("id", id));
      } else {
        // .select() so we know which row to open once the list reloads.
        const res = await supabaseClient.from("recipes").insert(row).select("id").single();
        error = res.error;
        insertedId = res.data ? res.data.id : null;
      }
    } finally {
      recipeSaving = false;
      recipeFormSubmitBtn.disabled = false;
    }

    if (error) {
      recipeFormStatus.textContent = saveErrorText(error);
      return;
    }

    recipeFormDirty = false;
    closeRecipeForm(true);
    toast(id ? "Recipe updated" : "Recipe added");
    await loadData();
    // Land on the recipe you just spent five minutes on, rather than dropping
    // back to an unchanged list with it filed somewhere under A\u2013Z.
    // openExistingRecipe already expands a row and scrolls it into view.
    const savedId = id || insertedId;
    if (savedId && byId[savedId]) openExistingRecipe(savedId);
  });

  // Repaint the one star rather than the whole list \u2014 except in Favorites
  // view, where un-starring genuinely takes the row out of the list.
  function paintStar(item) {
    if (favoritesOnly) { renderList(); return; }
    const btn = listEl.querySelector(`.item[data-id="${CSS.escape(item.id)}"] .star-btn`);
    if (!btn) { renderList(); return; }
    btn.classList.toggle("is-on", item.isFavorite);
    btn.setAttribute("aria-pressed", String(item.isFavorite));
    btn.setAttribute("aria-label", item.isFavorite ? "Remove from favorites" : "Add to favorites");
    btn.textContent = item.isFavorite ? "\u2605" : "\u2606";
  }
  async function toggleFavorite(item) {
    const next = !item.isFavorite;
    item.isFavorite = next; // optimistic
    paintStar(item);
    const { error } = await supabaseClient.from("recipes").update({ is_favorite: next }).eq("id", item.id);
    if (error) {
      item.isFavorite = !next;
      paintStar(item);
      toastError("Couldn\u2019t save that favorite", error);
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
    if (error) { statusEl.textContent = aiErrorText(null, error); return; }

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
    if (error) { toastError("That didn\u2019t work", error); return; }
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
    if (error) { toastError("Couldn\u2019t remove that", error); return; }
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
    if (error) { toastError("That didn\u2019t work", error); return; }
    toast("Copied to your book");
    await loadData();
  }

  // Some of these recipes exist nowhere else: photographed off a handwritten
  // card, typed out once from memory, pulled from a video that has since gone
  // private. A native confirm() is the one dialog people dismiss on reflex, so
  // the real protection is keeping the row in hand and offering it back. The
  // confirm can then stop threatening and just say what's about to happen.
  async function deleteRecipe(item) {
    if (!confirm(`Delete \u201c${item.name}\u201d? You\u2019ll have a few seconds to undo.`)) return;
    // toBackupRow omits user_id (it's an export shape), and an insert needs it —
    // copyToMyBook adds it the same way. created_at is carried over too, so an
    // undo puts the recipe back where it was in a "Newest" sort rather than
    // sending it to the top. The id is deliberately NOT reused: this is a fresh
    // row, which is why the message says "restored".
    const restoreRow = {
      ...toBackupRow(item),
      user_id: session.user.id,
      created_at: item.createdAt || undefined
    };
    const { error } = await supabaseClient.from("recipes").delete().eq("id", item.id);
    if (error) {
      toastError("Couldn\u2019t delete that recipe", error);
      return;
    }
    openItems.delete(item.id);
    basket.delete(item.id);
    mealPlanTray.delete(item.id);
    saveLocal("mealTray", [...mealPlanTray]);
    await loadData();
    // Restoring re-inserts the recipe itself. Anything the database cascaded
    // away with it (a grocery-basket entry, a planned meal) doesn't come back,
    // which is why the message is "restored" rather than "undeleted".
    toastAction(`\u201c${item.name}\u201d deleted`, "Undo", async () => {
      const { error: reErr } = await supabaseClient.from("recipes").insert(restoreRow);
      if (reErr) { toastError("Couldn\u2019t put that recipe back", reErr); return; }
      toast("Recipe restored");
      await loadData();
    });
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
    aiPhotoNote.value = "";
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
      aiImportStatus.textContent = aiErrorText(data, error);
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
    // Preserve provenance: if the extraction didn't capture a source, carry the
    // pasted link onto the visible Source field so it saves with the recipe and
    // stays a one-tap route back to the original video/blog.
    if (payload.type === "url" && payload.url && !rfSource.value.trim()) {
      rfSource.value = payload.url;
    }
    // The server reports which tier ran: "structured" = the site's own
    // schema.org recipe data, read directly (no AI call, doesn't count
    // against the daily cap); anything else went through the model.
    recipeFormStatus.textContent = data.extracted_via === "structured"
      ? "Read straight from the site's recipe data (no AI needed) — please review before saving."
      : "AI extracted this recipe — please review before saving.";
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
    // Optional steer for the AI ("only the brownie recipe on the left page").
    const note = aiPhotoNote.value.trim();
    runExtraction({ type: "image", images: aiPhotoQueue.slice(), ...(note ? { note } : {}) });
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
    // "Clear all" only shows when there's something to clear.
    genChipsHead.hidden = genState.ingredients.length === 0;
    renderGenBarPicks();
  }
  // Bar mode only: offer the user's in-stock bar items as tap-to-toggle "quick
  // add" chips, so they can pull just the spirits they want (e.g. rum + campari)
  // into the generator instead of hand-typing them or clearing a full dump.
  // A pick is highlighted when its exact ingredient text is already selected.
  function renderGenBarPicks() {
    if (!genIsBar()) { genBarPicks.hidden = true; return; }
    const seen = new Set();
    const picks = [];
    inventory.forEach((it) => {
      if (it.section !== "bar" || it.status === "out") return;
      const text = genIngredientText(it);
      const key = text.toLowerCase();
      if (!text || seen.has(key)) return;
      seen.add(key);
      picks.push(text);
    });
    if (!picks.length) { genBarPicks.hidden = true; return; }
    const chosen = new Set(genState.ingredients.map((x) => x.toLowerCase()));
    genBarPicksRow.innerHTML = picks.map((text) => {
      const on = chosen.has(text.toLowerCase());
      return `<button type="button" class="tag-chip gen-optchip${on ? " is-on" : ""}" data-gen-barpick="${esc(text)}" aria-pressed="${on}">${esc(text)}</button>`;
    }).join("");
    genBarPicks.hidden = false;
  }
  // ---- The start step ----
  // "Generate" asked twenty questions: five option groups, nothing pre-chosen,
  // for what is usually one sentence. It now opens on three choices; "Dinner
  // from what I have" is one tap (your pantry, about 30 minutes, your
  // household's size), and the options fold under Change.
  let genStep = "start"; // "start" | "custom"
  let genLastOverride = null; // the start-step inputs, so "Different ideas" reruns them
  const GEN_SKIP_PANTRY = new Set(["Condiments, Sauces & Spices", "Beverages"]);
  // What's on hand, as generator ingredients: the bar's bottles, or the
  // pantry minus seasonings and drinks (the generator assumes seasonings, and a
  // list of forty sauces would steer it more than the food does).
  function genOnHand(bar) {
    const seen = new Set();
    return inventory
      .filter((i) => i.status !== "out" && (bar ? i.section === "bar" : i.section === "pantry" && !GEN_SKIP_PANTRY.has(i.category)))
      .map(genIngredientText)
      .filter((t) => { const k = (t || "").toLowerCase(); if (!k || seen.has(k)) return false; seen.add(k); return true; })
      .slice(0, 40);
  }
  const genServesDefault = () => Number(genState.servings) || householdServings || 4;
  function renderGenStart() {
    const bar = genIsBar();
    $("#generate-title").textContent = bar ? "What should we mix?" : "What should we make?";
    $("#gen-quick-title").textContent = bar ? "A drink from my bar" : "Dinner from what I have";
    $("#gen-quick-sub").textContent = bar ? "Your bottles \u00B7 citrus and syrup assumed"
      : `Your pantry \u00B7 ${genState.time === "involved" ? "worth the effort" : "about 30 minutes"} \u00B7 serves ${genServesDefault()}`;
    $("#gen-mind-sub").textContent = bar ? "Start from gin, a lemon, some mint\u2026" : "Start from chicken, a squash, leftover rice\u2026";
    $("#gen-shop-sub").textContent = bar ? "A drink worth one more bottle or mixer" : "Ideas worth a quick grocery run";
    const pick = (v, anyLabel) => (v && v !== "any" ? invCap(v) : anyLabel);
    $("#gen-settings-summary").textContent = [
      pick(genState.cuisine, bar ? "Any style" : "Any cuisine"),
      pick(genState.equipment, "any equipment").replace(/^Any/, "any")
    ].join(" \u00B7 ");
  }
  function showGenStep(step) {
    genStep = step;
    $("#gen-start").hidden = step !== "start";
    $("#gen-custom").hidden = step !== "custom";
    genSubmitBtn.hidden = step !== "custom";
    // On the start step the choice itself says whether to shop.
    generatePanel.querySelector("#gen-opt-grocery").hidden = step === "start";
  }
  function runGenOnHand(shop) {
    const bar = genIsBar();
    const have = genOnHand(bar);
    if (!have.length) {
      // Nothing tracked yet: ask, rather than send an empty list.
      if (shop) genState.groceryRun = "quick";
      showGenStep("custom");
      renderGenOptions();
      generateStatus.textContent = bar
        ? "Your bar list is empty \u2014 add a few bottles you have."
        : "Your pantry list is empty \u2014 add a few things you have.";
      genIngInput.focus();
      return;
    }
    const chips = { groceryRun: shop ? "quick" : "none" };
    if (!bar) {
      chips.time = genState.time || "quick";
      chips.servings = genServesDefault();
    }
    runConcepts({ ingredients: have, chips });
  }
  function renderGenOptions() {
    const bar = genIsBar();
    genCuisineLabel.textContent = bar ? "Style" : "Cuisine";
    // A cocktail is one drink you build in a minute, so the recipe-shaped
    // questions don't apply — hide Time and Servings for the bar. Style,
    // Equipment (shaken/stirred/built) and the grocery-run lever still do.
    // Null the values too, so a pick made on the kitchen side can't leak into
    // the payload (both are omitted entirely when unset).
    generatePanel.querySelector("#gen-opt-time").hidden = bar;
    generatePanel.querySelector("#gen-opt-servings").hidden = bar;
    if (bar) { genState.time = null; genState.servings = null; }
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
    renderGenStart();
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
    genLastOverride = null;
    $("#gen-opts").hidden = true;
    $("#gen-change").setAttribute("aria-expanded", "false");
    showGenStep("start");
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
  // `override` (the start step's one-tap choices) supplies the ingredients and
  // the grocery-run/time/servings; cuisine and equipment still come from Change.
  function buildGenPayload(override) {
    const o = override || {};
    return {
      ingredients: (o.ingredients || genState.ingredients).slice(),
      section: genIsBar() ? "bar" : "kitchen",
      chips: {
        groceryRun: genState.groceryRun || undefined,
        time: genState.time || undefined,
        servings: genState.servings ? Number(genState.servings) : undefined,
        cuisine: genState.cuisine && genState.cuisine !== "any" ? genState.cuisine : undefined,
        equipment: genState.equipment && genState.equipment !== "any" ? genState.equipment : undefined,
        ...(o.chips || {})
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
  async function runConcepts(override) {
    genLastOverride = override || null;
    if (!(override ? override.ingredients : genState.ingredients).length) { generateStatus.textContent = "Add at least one ingredient first."; return; }
    genLastPayload = buildGenPayload(override);
    const token = ++generationToken;
    generateStatus.textContent = "";
    generateLoadingMsg.textContent = "Finding a few ideas…";
    showGenView("loading");
    const result = await genInvoke({ ...genLastPayload, mode: "concepts" });
    if (token !== generationToken || generatePanel.hidden) return; // stale / cancelled
    if (result === GENERATION_TIMEOUT) return genFail("That's taking too long — check your connection and try again.", "form");
    const { data, error } = result;
    if (error || data?.error) return genFail(aiErrorText(data, error), "form");
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
    if (error || data?.error) return genFail(aiErrorText(data, error), "concepts");
    closeGeneratePanel();
    openRecipeForm(null);
    fillRecipeFormFromExtraction(data.recipe);
    recipeFormStatus.textContent = "AI generated this recipe — please review before saving.";
    renderInventoryCheck(data.recipe);
  }

  addRecipeGenerateBtn.addEventListener("click", () => openGeneratePanel());
  closeGenerateBtn.addEventListener("click", closeGeneratePanel);
  generateCancelBtn.addEventListener("click", closeGeneratePanel);
  genSubmitBtn.addEventListener("click", () => runConcepts());
  genConceptsBackBtn.addEventListener("click", () => { generateStatus.textContent = ""; showGenView("form"); });
  genConceptsRerollBtn.addEventListener("click", () => runConcepts(genLastOverride));
  $("#gen-quick").addEventListener("click", () => runGenOnHand(false));
  $("#gen-shop").addEventListener("click", () => runGenOnHand(true));
  $("#gen-mind").addEventListener("click", () => {
    generateStatus.textContent = "";
    showGenStep("custom");
    genIngInput.focus();
  });
  $("#gen-custom-back").addEventListener("click", () => {
    generateStatus.textContent = "";
    showGenStep("start");
  });
  $("#gen-change").addEventListener("click", (e) => {
    const opts = $("#gen-opts");
    opts.hidden = !opts.hidden;
    e.currentTarget.setAttribute("aria-expanded", String(!opts.hidden));
  });
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
  genClearBtn.addEventListener("click", () => {
    genState.ingredients = [];
    renderGenChips();
    genIngInput.focus();
  });
  // Tap a "from your bar" chip to add/remove just that spirit.
  genBarPicksRow.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-gen-barpick]");
    if (!btn) return;
    const text = btn.dataset.genBarpick;
    const norm = text.toLowerCase();
    const idx = genState.ingredients.findIndex((x) => x.toLowerCase() === norm);
    if (idx >= 0) genState.ingredients.splice(idx, 1);
    else genState.ingredients.push(text);
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
    if (error || data?.error) return fail(aiErrorText(data, error));
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
    tweak: "Change it, scale it, or do the math — e.g. “it’s too sweet”, “scale to 8 limes”, or “how much for 12 servings?”"
  };

  // --- 24h conversation persistence (per recipe, per mode) ---
  const COACH_STORE_PREFIX = "coach:v1:";
  const COACH_TTL_MS = 24 * 60 * 60 * 1000;
  const COACH_MAX_STORED_MESSAGES = 40;
  const coachStoreKey = (recipeId) => COACH_STORE_PREFIX + recipeId;

  // Startup sweep: loadCoachStore only prunes a thread when its own recipe's
  // panel reopens, so a thread coached once and never revisited lingers past
  // its 24h TTL. Walk every coach:v1:* key once at sign-in and drop expired
  // modes (removing the key entirely when nothing survives).
  function pruneCoachStore() {
    try {
      const keys = Object.keys(localStorage).filter((k) => k.startsWith(COACH_STORE_PREFIX));
      for (const key of keys) {
        let store;
        try { store = JSON.parse(localStorage.getItem(key) || "") || {}; }
        catch { localStorage.removeItem(key); continue; }
        let changed = false;
        for (const mode of Object.keys(store)) {
          if (!store[mode] || Date.now() - (store[mode].updatedAt || 0) > COACH_TTL_MS) {
            delete store[mode];
            changed = true;
          }
        }
        if (changed) {
          if (Object.keys(store).length) localStorage.setItem(key, JSON.stringify(store));
          else localStorage.removeItem(key);
        }
      }
    } catch { /* storage unavailable (private mode) — nothing to prune */ }
  }

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

  // What the coach knows beyond this recipe: pantry/bar stock and the names of
  // the cook's other recipes (it reads one in full server-side when needed).
  function buildCoachContext(it) {
    const stock = (sec) => inventory.filter((i) => i.section === sec && i.status !== "out").map(genIngredientText).filter(Boolean);
    return {
      pantry: stock("pantry"),
      bar: stock("bar"),
      out: inventory.filter((i) => i.status === "out").map(genIngredientText).filter(Boolean),
      recipes: Object.values(byId)
        .filter((r) => r.id !== it.id && r.name)
        .map((r) => ({ name: r.name, section: r.section === "bar" ? "bar" : "kitchen" }))
    };
  }

  function setCoachMode(mode) {
    coachMode = mode === "tweak" ? "tweak" : "troubleshoot";
    coachModeTroubleshootBtn.classList.toggle("is-active", coachMode === "troubleshoot");
    coachModeTroubleshootBtn.setAttribute("aria-selected", String(coachMode === "troubleshoot"));
    coachModeTweakBtn.classList.toggle("is-active", coachMode === "tweak");
    coachModeTweakBtn.setAttribute("aria-selected", String(coachMode === "tweak"));
    coachInput.placeholder = COACH_PLACEHOLDERS[coachMode];
    // A reply still in flight belongs to the OTHER mode's thread — drop it.
    resetCoachBusy();
    // Restore this mode's saved conversation (within 24h), else start fresh.
    coachStatus.textContent = "";
    restoreCoachState();
    renderCoachThread();
  }

  // Abandon any in-flight turn: sendCoach drops a response whose token is stale,
  // and that early return skips its own UI reset — so restore it here, or Send
  // stays disabled after a close/reopen or a mode switch mid-reply.
  function resetCoachBusy() {
    coachToken++;
    coachBusy = false;
    coachSendBtn.disabled = false;
    coachLoading.hidden = true;
  }

  function openCoachPanel(id) {
    const it = byId[id];
    if (!it) return;
    coachRecipeId = id;
    resetCoachBusy();
    coachInput.value = "";
    coachRecipeName.textContent = `· ${it.name}`;
    setCoachMode("troubleshoot");
    coachPanel.hidden = false;
    coachInput.focus();
  }

  function closeCoachPanel() {
    resetCoachBusy();
    coachPanel.hidden = true;
  }

  // Coach replies arrive with light Markdown ("**Sherry vinegar** is your best
  // bet"). Escape first, then render only **bold** — so the asterisks never show
  // and no model text can inject markup. Line breaks become <br>.
  function coachTextHtml(text) {
    return esc(text).replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>").replace(/\n/g, "<br>");
  }

  function renderCoachThread() {
    const it = coachRecipe();
    const mine = it && it.userId === session?.user?.id;
    if (!coachMessages.length) {
      const hint = coachMode === "tweak"
        ? "Tell me how to adjust it, scale it (to servings or to what you have, like “8 limes”), or a quantity to work out — I’ll give amounts and can rewrite the recipe for you to review."
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
          extra += `<ul class="coach-suggestions">${sugg.map((s) => `<li>${coachTextHtml(s)}</li>`).join("")}</ul>`;
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
      return `<div class="coach-msg ${m.role === "user" ? "user" : "ai"}">${coachTextHtml(m.content)}${extra}</div>`;
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
      body: { mode: coachMode, recipe: serializeRecipeForCoach(it), messages: coachMessages, context: buildCoachContext(it) }
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
      coachStatus.textContent = aiErrorText(data, error);
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
    // The coach is never sent the source (serializeRecipeForCoach), so its
    // revised_recipe.source is a blank or a guess — keep the original link.
    rfSource.value = it.source || "";
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

  // ---------- AI drink pairing ----------
  // Pick a kitchen recipe -> choose cocktail/wine/beer -> 2-3 options -> pick
  // one. A cocktail option may point at an EXISTING bar recipe (free to
  // view, no further call) or an INVENTED idea (needs a second, capped call
  // to develop into a full saveable recipe). Wine/beer options are pure
  // recommendations — never savable — so the one options call is the whole
  // interaction and is what counts against the cap.
  let pairRecipeId = null;
  let pairKind = null;        // "cocktail" | "wine" | "beer" | null
  let pairOptions = [];       // 2-3 options awaiting a pick, from the last "options" call
  let pairPickedStyle = null; // the picked wine/beer option, shown in place of the card list
  let pairLastPayload = null; // {recipe, dietPrefs} captured once per panel-open, reused by "develop"
  let pairToken = 0;          // guards stale/cancelled responses
  const PAIR_TIMEOUT_MS = 75_000;
  const PAIR_TIMEOUT = Symbol("pair-timeout");

  // Trim the kitchen recipe to what the pairing prompt actually needs —
  // mirrors recipe-coach's "inject existing data" idiom, no app-only fields.
  function pairRecipeSubset(it) {
    return {
      name: it.name, subtitle: it.subtitle, section: it.section, tags: it.tags,
      ingredients: it.ingredients, method: it.method, notes: it.notes
    };
  }

  function renderPairKindButtons() {
    [["cocktail", pairKindCocktailBtn], ["wine", pairKindWineBtn], ["beer", pairKindBeerBtn]].forEach(([k, btn]) => {
      const on = pairKind === k;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-selected", String(on));
    });
  }

  function openPairPanel(id) {
    const it = byId[id];
    if (!it) return;
    pairRecipeId = id;
    pairKind = null;
    pairOptions = [];
    pairPickedStyle = null;
    pairLastPayload = { recipe: pairRecipeSubset(it), dietPrefs };
    pairToken++;
    pairRecipeName.textContent = `· ${it.name}`;
    pairStatus.textContent = "";
    pairLoading.hidden = true;
    renderPairKindButtons();
    pairOptionsEl.innerHTML = `<p class="coach-empty">Pick a drink type above.</p>`;
    pairPanel.hidden = false;
  }
  function closePairPanel() {
    pairToken++; // abandon any in-flight response
    pairPanel.hidden = true;
  }

  function choosePairKind(kind) {
    pairKind = kind;
    pairPickedStyle = null;
    renderPairKindButtons();
    runPairOptions();
  }

  // Candidate bar recipes for the cocktail branch — the user's own saved
  // cocktails, each cross-checked against inventory (inventoryHaveNeed),
  // sorted so fully-in-stock recipes surface first if the list gets capped.
  function buildBarCandidates() {
    return DATA.cocktails
      .map((it) => {
        const hn = inventoryHaveNeed(it.ingredients);
        return {
          id: it.id,
          name: it.name,
          tags: it.tags,
          ingredientsSummary: it.ingredients.map((i) => i.item).filter(Boolean).join(", "),
          missing: hn ? hn.need : []
        };
      })
      .sort((a, b) => a.missing.length - b.missing.length)
      .slice(0, 25);
  }

  // The user's in-stock bar ingredients (spirits, liqueurs, mixers) — the raw
  // inventory behind the "from your bar" cocktail option. Bar rows carry the
  // meaningful name in `category` (mirrors inventoryHaveNeed). soda water,
  // bitters, and citrus are ASSUMED on hand server-side, so they needn't be
  // listed. Empty result => no bar option, just meal pairings.
  function buildBarInventory() {
    const seen = new Set();
    const out = [];
    inventory.forEach((i) => {
      if (i.section !== "bar" || i.status !== "in") return;
      const name = (i.category || i.name || "").trim();
      const key = name.toLowerCase();
      if (!name || seen.has(key)) return;
      seen.add(key);
      out.push(name);
    });
    return out.slice(0, 60);
  }

  function pairInvoke(body) {
    const invokePromise = supabaseClient.functions.invoke("pair-drink", { body }).catch((error) => ({ error }));
    const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve(PAIR_TIMEOUT), PAIR_TIMEOUT_MS));
    return Promise.race([invokePromise, timeoutPromise]);
  }

  async function runPairOptions() {
    if (!pairKind || !pairLastPayload) return;
    const token = ++pairToken;
    pairStatus.textContent = "";
    pairOptionsEl.innerHTML = "";
    pairLoading.hidden = false;
    const body = { kind: pairKind, mode: "options", recipe: pairLastPayload.recipe, dietPrefs: pairLastPayload.dietPrefs };
    if (pairKind === "cocktail") {
      body.barRecipes = buildBarCandidates();
      body.barInventory = buildBarInventory();
    }
    const result = await pairInvoke(body);
    if (token !== pairToken || pairPanel.hidden) return; // stale / cancelled
    pairLoading.hidden = true;
    if (result === PAIR_TIMEOUT) { pairStatus.textContent = "That's taking too long — check your connection and try again."; return; }
    const { data, error } = result;
    if (error || data?.error) { pairStatus.textContent = aiErrorText(data, error); return; }
    pairOptions = Array.isArray(data.options) ? data.options : [];
    // Bar-anchored option first, meal pairings after — deterministic order
    // regardless of how the model returned them (keeps indices aligned with
    // the rendered buttons + pick handler).
    if (pairKind === "cocktail") pairOptions.sort((a, b) => (b.basis === "bar") - (a.basis === "bar"));
    if (!pairOptions.length) { pairStatus.textContent = "Couldn’t come up with pairings — try again."; return; }
    renderPairOptions();
  }

  function renderPairOptions() {
    if (pairKind === "cocktail") {
      const candidates = buildBarCandidates(); // for the stock-tag lookup
      pairOptionsEl.innerHTML = pairOptions.map((o, i) => {
        const cand = o.matched_existing_id ? candidates.find((c) => c.id === o.matched_existing_id) : null;
        let tag;
        if (o.basis === "bar") {
          // The one drink built from what's on hand right now.
          tag = `<span class="pair-stock-tag is-in-stock">🍸 from your bar</span>`;
        } else if (o.matched_existing_id) {
          tag = cand && cand.missing.length
            ? `<span class="pair-stock-tag">🛒 need: ${esc(cand.missing.join(", "))}</span>`
            : `<span class="pair-stock-tag is-in-stock">✓ in your bar</span>`;
        } else {
          tag = `<span class="pair-stock-tag">✨ new idea</span>`;
        }
        return `<button type="button" class="pair-option" data-pair-option="${i}">
          <span class="gen-concept-title">${esc(o.title)}</span>
          ${tag}
          <span class="gen-concept-blurb">${esc(o.blurb)}</span>
        </button>`;
      }).join("");
    } else {
      pairOptionsEl.innerHTML = pairOptions.map((o, i) =>
        `<button type="button" class="pair-option" data-pair-option="${i}">
          <span class="gen-concept-title">${esc(o.recommendation)}</span>
          <span class="pair-characteristics">${esc(o.characteristics)}</span>
          <span class="gen-concept-blurb">${esc(o.blurb)}</span>
        </button>`
      ).join("");
    }
  }

  // Switch to whichever tab/section a recipe lives in, clear anything that
  // could be hiding it (filters, search, favorites/shared scope), expand its
  // detail row, and scroll to it — used when a cocktail pairing matches an
  // existing bar recipe (no AI call needed, just navigate to it).
  function openExistingRecipe(id) {
    const it = byId[id];
    if (!it) return;
    section = it.section === "bar" ? "cocktails" : "recipes";
    if (viewMode === "bottles" || (viewMode === "mealplan" && section === "cocktails")) setViewMode("recipes");
    document.querySelectorAll(".tab").forEach((b) => {
      const on = b.dataset.section === section;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-selected", String(on));
    });
    document.body.classList.toggle("section-cocktails", section === "cocktails");
    activeTags.clear();
    searchTerm = "";
    searchEl.value = "";
    favoritesOnly = false;
    toggleFavoritesBtn.setAttribute("aria-pressed", "false");
    sharedOnly = false;
    toggleSharedBtn.setAttribute("aria-pressed", "false");
    syncScope();
    openItems.add(id);
    refreshViews();
    const li = document.querySelector(`.item[data-id="${CSS.escape(id)}"]`);
    if (li) li.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  async function pickPairOption(i) {
    const opt = pairOptions[i];
    if (!opt) return;

    if (pairKind !== "cocktail") {
      // Wine/beer: no further call — show the picked option's full detail.
      pairPickedStyle = opt;
      renderPairStyleResult();
      return;
    }

    if (opt.matched_existing_id) {
      // Existing bar recipe — free, no API call.
      const targetId = opt.matched_existing_id;
      closePairPanel();
      openExistingRecipe(targetId);
      return;
    }

    // Invented concept — capped "develop" call.
    const token = ++pairToken;
    pairStatus.textContent = "";
    pairLoading.hidden = false;
    pairOptionsEl.innerHTML = "";
    const fromBar = opt.basis === "bar";
    const result = await pairInvoke({
      kind: "cocktail", mode: "develop",
      concept: { title: opt.title, blurb: opt.blurb },
      fromBar,
      barInventory: fromBar ? buildBarInventory() : undefined,
      recipe: pairLastPayload.recipe, dietPrefs: pairLastPayload.dietPrefs
    });
    if (token !== pairToken || pairPanel.hidden) return; // stale / cancelled
    pairLoading.hidden = true;
    if (result === PAIR_TIMEOUT) { pairStatus.textContent = "That's taking too long — check your connection and try again."; renderPairOptions(); return; }
    const { data, error } = result;
    if (error || data?.error) { pairStatus.textContent = aiErrorText(data, error); renderPairOptions(); return; }
    closePairPanel();
    openRecipeForm(null);
    fillRecipeFormFromExtraction(data.recipe);
    renderInventoryCheck(data.recipe);
    recipeFormStatus.textContent = "AI paired this — review before saving.";
  }

  function renderPairStyleResult() {
    const opt = pairPickedStyle;
    pairOptionsEl.innerHTML = `
      <div class="pair-result">
        <p class="gen-concept-title">${esc(opt.recommendation)}</p>
        <p class="pair-characteristics">${esc(opt.characteristics)}</p>
        <p class="gen-concept-blurb">${esc(opt.blurb)}</p>
        <div class="pair-result-actions">
          <button type="button" class="ghost-btn small" id="pair-back-btn">← Back to options</button>
          <button type="button" class="ghost-btn small" id="pair-add-grocery-btn">🛒 Add to grocery list</button>
        </div>
      </div>`;
  }

  pairKindCocktailBtn.addEventListener("click", () => choosePairKind("cocktail"));
  pairKindWineBtn.addEventListener("click", () => choosePairKind("wine"));
  pairKindBeerBtn.addEventListener("click", () => choosePairKind("beer"));
  pairOptionsEl.addEventListener("click", (e) => {
    const optBtn = e.target.closest("[data-pair-option]");
    if (optBtn) { pickPairOption(Number(optBtn.dataset.pairOption)); return; }
    if (e.target.closest("#pair-back-btn")) { pairPickedStyle = null; renderPairOptions(); return; }
    if (e.target.closest("#pair-add-grocery-btn")) {
      if (pairPickedStyle) addManualGroceryItem(pairPickedStyle.recommendation);
      return;
    }
  });
  $("#close-pair").addEventListener("click", closePairPanel);
  pairPanel.addEventListener("click", (e) => {
    if (e.target === pairPanel) closePairPanel();
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
      if ((viewMode === "bottles" && section !== "cocktails") || (viewMode === "mealplan" && section === "cocktails")) setViewMode("recipes");
      refreshViews();
    });
  });

  // Search — debounce the re-render so a fast typist doesn't rebuild the whole
  // list on every keystroke (the filter + innerHTML swap is the cost).
  let searchDebounce = null;
  searchEl.addEventListener("input", () => {
    searchTerm = searchEl.value;
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(renderList, 130);
  });

  // Filter panel toggle
  toggleFiltersBtn.addEventListener("click", () => {
    const open = tagFiltersEl.hidden;
    tagFiltersEl.hidden = !open;
    toggleFiltersBtn.setAttribute("aria-expanded", open);
  });
  sortSelect.addEventListener("change", () => {
    sortMode = sortSelect.value;
    saveLocal("sortMode", sortMode);
    renderList();
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
  function resetScope() {
    favoritesOnly = false;
    sharedOnly = false;
    toggleFavoritesBtn.setAttribute("aria-pressed", "false");
    toggleSharedBtn.setAttribute("aria-pressed", "false");
    syncScope();
  }
  function handleTagClick(e) {
    // The scope chip in the active-filters row carries .tag-chip too, so it has
    // to be matched before the tag branch (which would otherwise read an
    // undefined data-tag and add it to the filter set).
    if (e.target.closest("[data-scope-off]")) {
      resetScope();
      refreshViews();
      return;
    }
    const chip = e.target.closest(".tag-chip");
    if (chip && chip.dataset.tag) {
      const t = chip.dataset.tag;
      activeTags.has(t) ? activeTags.delete(t) : activeTags.add(t);
      refreshViews();
      return;
    }
    if (e.target.id === "clear-tags") {
      activeTags.clear();
      resetScope();
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

    if (e.target.closest(".list-btn, .detail-grocery-btn")) {
      setBasketMembership(id, !basket.has(id));
      return;
    }

    // The servings stepper in the open recipe scales the amounts shown AND the
    // grocery list, through setRecipeServings.
    const stepBtn = e.target.closest(".detail-serv-btn");
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

    if (e.target.closest(".pair-btn")) {
      openPairPanel(id);
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

    if (e.target.closest(".plan-night-btn")) {
      openPlanNightSheet(id);
      return;
    }

    const unitBtn = e.target.closest(".unit-toggle-btn");
    if (unitBtn) {
      unitSystem = unitBtn.dataset.unit;
      saveLocal("unitSystem", unitSystem); // survives a reload now
      // It's a global setting, so every OPEN detail repaints \u2014 but only the
      // open ones, which is usually exactly one.
      [...openItems].forEach(rerenderRow);
      return;
    }

    if (e.target.closest(".item-head")) {
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
    hideCookDone();
    cookPanel.hidden = false;
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
    if (cookDone) hideCookDone();
    const total = cookSteps.length;
    const step = cookSteps[cookIdx];
    const prefix = step.group ? `${step.group} · ` : "";
    cookStepNum.textContent = `${prefix}Step ${cookIdx + 1} of ${total}`;
    cookStepText.textContent = step.text;
    renderCookStepIngredients(step);
    renderStepTimers(step);
    cookProgressBar.style.width = `${((cookIdx + 1) / total) * 100}%`;
    cookPrevBtn.disabled = cookIdx === 0;
    const onLast = cookIdx === total - 1;
    cookNextBtn.textContent = onLast ? "Done ✓" : "Next →";
    // Tapping the body doesn't advance off the last step any more, so stop
    // telling people it does.
    const tapHint = cookPanel.querySelector(".cook-tap-hint");
    if (tapHint) tapHint.hidden = onLast;
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
      const amtStr = ing.scaled == null ? "" : fmtAmount(ing.scaled) + (ing.unit ? " " + displayUnit(ing.unit) : "");
      return `<span class="cook-step-ing">${esc([amtStr, displayGroceryName(ing.item)].filter(Boolean).join(" "))}</span>`;
    }).join("");
  }

  // ---------- Cook step timers ----------
  // {endsAt, label, intervalId, paused, remaining} — survives step changes,
  // cleared on open/close. While paused, `intervalId` is null and `remaining`
  // (seconds left) is authoritative instead of `endsAt`.
  let cookTimer = null;
  // A quantity is a number ("10", "1.5"), a fraction ("1/2"), a mixed number
  // ("1 1/2"), or a vulgar fraction ("½", "1½"). The lookbehind stops a match
  // starting mid-number, so "1/2 hour" can't be read as "2 hour".
  const VULGAR_FRACTIONS = { "¼": 0.25, "½": 0.5, "¾": 0.75, "⅓": 1 / 3, "⅔": 2 / 3 };
  const DURATION_RE = /(?<![\d./])(\d+(?:\.\d+)?)?\s*(?:(\d+)\s*\/\s*(\d+)|([¼½¾⅓⅔]))?\s*(hours?|hrs?|minutes?|mins?|seconds?|secs?)\b/gi;
  function parseDurations(text) {
    const out = [];
    let m;
    DURATION_RE.lastIndex = 0;
    while ((m = DURATION_RE.exec(text))) {
      const whole = m[1] ? parseFloat(m[1]) : 0;
      const frac = m[2] && Number(m[3]) ? Number(m[2]) / Number(m[3]) : m[4] ? VULGAR_FRACTIONS[m[4]] : 0;
      const value = whole + frac;
      if (!value) continue; // "a few minutes" — no number, no timer
      const unit = m[5].toLowerCase();
      const seconds = unit.startsWith("h") ? value * 3600 : unit.startsWith("m") ? value * 60 : value;
      out.push({ seconds: Math.round(seconds), label: m[0].trim() });
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

  // Reaching the end is now a place you arrive at, not the exit. Advancing off
  // the last step used to close cook mode outright — and because the whole step
  // body is tap-to-advance, a tap meant to re-read step 9 of 9 dropped you back
  // into the list with the wake lock released and nothing to show for it.
  let cookDone = false;
  function showCookDone() {
    cookDone = true;
    cookPanel.classList.add("is-done");
    cookBody.hidden = true;
    cookIngredients.hidden = true;
    cookIngToggle.setAttribute("aria-expanded", "false");
    cookDoneEl.hidden = false;
    const n = cookSteps.length;
    cookDoneSub.textContent = cookItem
      ? `${cookItem.name} \u2014 all ${n} step${n === 1 ? "" : "s"}.`
      : `All ${n} steps.`;
    cookProgressBar.style.width = "100%";
    const btn = $("#cook-done-close");
    if (btn) btn.focus({ preventScroll: true });
  }
  function hideCookDone() {
    cookDone = false;
    cookPanel.classList.remove("is-done");
    cookDoneEl.hidden = true;
    cookBody.hidden = false;
  }
  function cookNext() {
    if (cookIdx >= cookSteps.length - 1) {
      showCookDone();
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
      // Same rule as the tap: a left-swipe on the last step doesn't finish.
      if (dx < 0) { if (cookIdx < cookSteps.length - 1) cookNext(); } else cookPrev();
    }
  }, { passive: true });

  // Tap the step body to advance (suppress if a swipe just fired). On the LAST
  // step the tap does nothing: finishing has to be the explicit "Done ✓", so
  // re-reading the final step can't throw you out of cook mode.
  cookBody.addEventListener("click", () => {
    if (cookSwiped) { cookSwiped = false; return; }
    if (cookIdx >= cookSteps.length - 1) return;
    cookNext();
  });
  cookNextBtn.addEventListener("click", cookNext);
  $("#cook-done-back").addEventListener("click", () => { hideCookDone(); renderCookStep(); });
  $("#cook-done-close").addEventListener("click", closeCookMode);
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
    if (e.key === "ArrowRight") {
      e.preventDefault();
      if (cookIdx < cookSteps.length - 1) cookNext();
    }
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
    renderGroceryPanel(); // whatever's already in memory — no blank flash
    groceryPanel.hidden = false;
    // Refetch on open so a change made on another device shows up here.
    loadGroceryList().then(() => { if (!groceryPanel.hidden) renderGroceryPanel(); });
  }
  // The header cart is the one way in (the bottom bar is gone), so it's there
  // even with an empty list.
  $("#open-grocery-top").addEventListener("click", openGroceryPanel);
  $("#close-grocery").addEventListener("click", closeGroceryPanel);
  groceryPanel.addEventListener("click", (e) => {
    if (e.target === groceryPanel) closeGroceryPanel();
  });
  shoppingModeToggle.addEventListener("click", () => setShoppingMode(!shoppingModeOn));

  // Mode tabs: Recipes ↔ Meal plan
  modeRecipesBtn.addEventListener("click", () => setViewMode("recipes"));
  modeMealplanBtn.addEventListener("click", () => setViewMode("mealplan"));
  $("#staged-count").addEventListener("click", () => setViewMode("mealplan"));
  mealPlanView.addEventListener("click", (e) => {
    if (e.target.closest("#mp-make-grocery")) { groceryFromPlan(); return; }
    if (e.target.closest("#mp-send-plan")) { shareMealPlan(); return; }
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
  $("#clear-grocery").addEventListener("click", async () => {
    const n = basket.size + manualGroceryItems.length;
    if (!n) return;
    if (!confirm("Clear your grocery list? This takes off every recipe and added item.")) return;
    if (session) {
      const [{ error: e1 }, { error: e2 }, { error: e3 }] = await Promise.all([
        supabaseClient.from("grocery_basket_items").delete().eq("user_id", session.user.id),
        supabaseClient.from("grocery_manual_items").delete().eq("user_id", session.user.id),
        supabaseClient.from("grocery_checked_items").delete().eq("user_id", session.user.id)
      ]);
      if (e1 || e2 || e3) { toast("Couldn't clear the list — try again.", true); return; }
    }
    basket.clear();
    manualGroceryItems = [];
    checkedGroceryItems.clear();
    renderList();
    renderGroceryCount();
    if (!groceryPanel.hidden) renderGroceryPanel();
  });

  // Grocery panel: manual item add/remove
  groceryContent.addEventListener("submit", async (e) => {
    if (e.target.id !== "grocery-add-manual") return;
    e.preventDefault();
    const input = $("#grocery-manual-input");
    const name = input.value.trim();
    if (!name) return;
    input.value = ""; // clear immediately for a snappy feel, before the round trip
    await addManualGroceryItem(name);
    $("#grocery-manual-input").focus();
  });
  groceryContent.addEventListener("click", (e) => {
    const removeBtn = e.target.closest(".g-manual-remove");
    if (removeBtn) { removeManualGroceryItem(removeBtn.dataset.key); return; }
    // Group the list by aisle (to shop) or by recipe (to see what it's for).
    const viewBtn = e.target.closest("[data-g-view]");
    if (viewBtn) {
      groceryView = viewBtn.dataset.gView === "recipe" ? "recipe" : "aisle";
      saveLocal("groceryView", groceryView);
      renderGroceryPanel();
      return;
    }
    // "Add back" on a pantry-held item — you have it, but want it anyway.
    const keepBtn = e.target.closest("[data-pantry-keep]");
    if (keepBtn) {
      pantryKeep.add(keepBtn.dataset.pantryKeep);
      saveLocal("pantryKeep", [...pantryKeep]);
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
      scheduleGroceryPrefsSave();
      renderGroceryPanel();
      const reopened = groceryContent.querySelector(".g-reorder");
      if (reopened) reopened.open = true;
    }
  });

  // Grocery panel: pantry-staples toggle + per-item check-off
  groceryContent.addEventListener("change", (e) => {
    if (e.target.id === "grocery-skip-staples") {
      skipPantryStaples = e.target.checked;
      scheduleGroceryPrefsSave();
      renderGroceryPanel();
      return;
    }
    if (e.target.classList.contains("g-item-check")) {
      const key = e.target.dataset.key;
      const checked = e.target.checked;
      if (checked) checkedGroceryItems.add(key);
      else checkedGroceryItems.delete(key);
      const li = e.target.closest("li");
      if (li) li.classList.toggle("is-checked", checked);
      renderGroceryProgress();
      syncCheckedItem(key, checked);
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
    downloadBlob(new Blob([groceryText()], { type: "text/plain" }), "grocery-list.txt");
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

  // Quiet disclosure that reveals the secondary exports (Copy / Download .txt).
  const exportMoreToggle = $("#export-more-toggle");
  const exportMorePanel = $("#export-more-panel");
  exportMoreToggle.addEventListener("click", () => {
    const open = exportMorePanel.hidden;
    exportMorePanel.hidden = !open;
    exportMoreToggle.setAttribute("aria-expanded", String(open));
  });

  // ---------- King Soopers (Kroger) ordering UI ----------
  const KROGER_DEBUG = /[?&]debug\b/.test(location.search); // ?debug reveals the match-report download
  const KROGER_PREF_OPTS = [["organic", "Organic"], ["cheapest", "Cheapest"], ["best", "Best match"]];
  const KROGER_MODALITY_OPTS = [["PICKUP", "Pickup"], ["DELIVERY", "Delivery"]];
  const krogerZipInput = $("#kroger-zip");
  const krogerStoreCurrent = $("#kroger-store-current");
  const krogerStoreResults = $("#kroger-store-results");
  const krogerPrefEl = $("#kroger-pref");
  const krogerModalityEl = $("#kroger-modality");
  const krogerPrefsStatus = $("#kroger-prefs-status");
  const krogerPanel = $("#kroger-panel");
  const krogerLoading = $("#kroger-loading");
  const krogerReviewSummary = $("#kroger-review-summary");
  const krogerReviewList = $("#kroger-review-list");
  const krogerReviewStatus = $("#kroger-review-status");

  function krogerChipRow(el, opts, current, attr) {
    el.innerHTML = opts.map(([v, label]) =>
      `<button type="button" class="tag-chip diet-chip${current === v ? " is-on" : ""}" ${attr}="${v}" aria-pressed="${current === v}">${label}</button>`
    ).join("");
  }
  // Render the account-panel King Soopers section from krogerPrefs.
  function renderKrogerPrefs() {
    if (!krogerZipInput) return;
    krogerZipInput.value = krogerPrefs.zip || "";
    krogerStoreCurrent.textContent = krogerPrefs.locationId
      ? `Store: ${krogerPrefs.storeName || krogerPrefs.locationId}`
      : "No store chosen yet.";
    krogerStoreResults.innerHTML = "";
    krogerChipRow(krogerPrefEl, KROGER_PREF_OPTS, krogerPrefs.productPref, "data-kroger-pref");
    krogerChipRow(krogerModalityEl, KROGER_MODALITY_OPTS, krogerPrefs.modality, "data-kroger-modality");
  }
  krogerPrefEl.addEventListener("click", (e) => {
    const b = e.target.closest("[data-kroger-pref]"); if (!b) return;
    krogerPrefs.productPref = b.dataset.krogerPref; renderKrogerPrefs(); saveKrogerPrefs();
  });
  krogerModalityEl.addEventListener("click", (e) => {
    const b = e.target.closest("[data-kroger-modality]"); if (!b) return;
    krogerPrefs.modality = b.dataset.krogerModality; renderKrogerPrefs(); saveKrogerPrefs();
  });
  // Shared store lookup + select, reused by the Account panel AND the first-run
  // inline "Where do you shop?" step in the send flow.
  async function krogerFindStores(zipRaw, statusEl, resultsEl) {
    const zip = String(zipRaw || "").replace(/[^0-9]/g, "").slice(0, 5);
    if (zip.length !== 5) { statusEl.textContent = "Enter a 5-digit ZIP."; return; }
    statusEl.textContent = "Finding stores…";
    resultsEl.innerHTML = "";
    const result = await supabaseClient.functions.invoke("kroger", { body: { mode: "stores", zip } }).catch((error) => ({ error }));
    const { data, error } = result;
    if (error || data?.error) { statusEl.textContent = data?.error || "Couldn’t look up stores."; return; }
    const stores = Array.isArray(data.stores) ? data.stores : [];
    if (!stores.length) { statusEl.textContent = "No stores found near that ZIP."; return; }
    statusEl.textContent = "";
    resultsEl.dataset.zip = zip;
    resultsEl.innerHTML = stores.map((s) =>
      `<button type="button" class="kroger-store-opt" data-store-id="${esc(s.locationId)}" data-store-name="${esc(s.name)}">
         <span class="kroger-store-name">${esc(s.name)}</span>
         <span class="kroger-store-addr">${esc(s.address || "")}</span>
       </button>`
    ).join("");
  }
  function krogerSelectStore(b, resultsEl) {
    krogerPrefs.locationId = b.dataset.storeId;
    krogerPrefs.storeName = b.dataset.storeName;
    krogerPrefs.zip = resultsEl.dataset.zip || krogerPrefs.zip;
    saveKrogerPrefs();
    renderKrogerPrefs();
  }
  $("#kroger-find-store").addEventListener("click", () => krogerFindStores(krogerZipInput.value, krogerPrefsStatus, krogerStoreResults));
  krogerStoreResults.addEventListener("click", (e) => {
    const b = e.target.closest("[data-store-id]"); if (!b) return;
    krogerSelectStore(b, krogerStoreResults);
    toast("King Soopers store saved");
  });

  // First-run inline store step inside the send sheet (no dead-end trip to Account).
  const krogerStoreStep = $("#kroger-store-step");
  const krogerInlineZip = $("#kroger-inline-zip");
  const krogerInlineResults = $("#kroger-inline-results");
  const krogerInlineStatus = $("#kroger-inline-status");
  $("#kroger-inline-find").addEventListener("click", () => krogerFindStores(krogerInlineZip.value, krogerInlineStatus, krogerInlineResults));
  krogerInlineZip.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); krogerFindStores(krogerInlineZip.value, krogerInlineStatus, krogerInlineResults); } });
  krogerInlineResults.addEventListener("click", (e) => {
    const b = e.target.closest("[data-store-id]"); if (!b) return;
    krogerSelectStore(b, krogerInlineResults);
    hideKrogerStoreStep();
    startKrogerSend(); // store now set -> continues straight into the match
  });
  function hideKrogerStoreStep() { krogerStoreStep.hidden = true; }
  function showKrogerStoreStep() {
    krogerStoreStep.hidden = false;
    krogerLoading.hidden = true;
    krogerReviewSummary.hidden = true;
    krogerReviewList.innerHTML = "";
    krogerReviewStatus.textContent = "";
    krogerSendCartBtn.hidden = true; krogerOpenStore.hidden = true; krogerDownloadBtn.hidden = true;
    krogerInlineZip.value = krogerPrefs.zip || "";
    krogerInlineResults.innerHTML = ""; krogerInlineStatus.textContent = "";
    setTimeout(() => krogerInlineZip.focus(), 60);
  }

  function closeKrogerPanel() { krogerPanel.hidden = true; }
  $("#close-kroger").addEventListener("click", closeKrogerPanel);
  krogerPanel.addEventListener("click", (e) => { if (e.target === krogerPanel) closeKrogerPanel(); });

  // Review sheet: matched items get pushed to the cart in one tap (Stage B);
  // unmatched items keep a King Soopers search deep-link (no UPC to add).
  const krogerSearchLink = (item) => `https://www.kingsoopers.com/search?query=${encodeURIComponent(item)}`;
  let krogerLastResults = []; // last search results, source for the cart push
  let krogerItemMeta = new Map(); // key -> { amount, unit, recipes } from the last search
  const krogerExcluded = new Set(); // result keys the user removed / already has in pantry
  // Word-capitalize a grocery name for the review header ("ground beef" ->
  // "Ground Beef"); the store's own product description is left untouched.
  function titleCase(s) {
    return String(s || "").replace(/\b[a-z]/g, (c) => c.toUpperCase());
  }
  const krogerSendCartBtn = $("#kroger-send-cart");
  const krogerOpenStore = $("#kroger-open-store");
  function krogerCartItems() {
    // Dedupe by product: two grocery lines that resolve to the same store item
    // (e.g. "onion" + "medium onion", or Pecorino measured in cups vs lb) are one
    // product — add it once. First still-included row wins.
    const seen = new Set();
    return krogerLastResults
      .filter((r) => r.product && r.product.upc && !krogerExcluded.has(r.key))
      .filter((r) => { if (seen.has(r.product.upc)) return false; seen.add(r.product.upc); return true; })
      .map((r) => ({ upc: r.product.upc, quantity: 1 }));
  }
  function renderKrogerReview(results) {
    krogerLastResults = results;
    const matched = results.filter((r) => r.product).length;
    const sendable = krogerCartItems().length;
    const skipped = results.filter((r) => krogerExcluded.has(r.key)).length;
    krogerReviewSummary.hidden = false;
    krogerReviewSummary.textContent = `Matched ${matched} of ${results.length}.` +
      (skipped ? ` Skipped ${skipped} you keep on hand.` : "") +
      (sendable ? ` Sending ${sendable} to your King Soopers cart — check out in the app.` : ` Nothing to send.`);

    // Partition into three groups. Cart rows are folded by product (UPC): lines
    // that resolve to the same store item become one row with the summed quantity
    // and the union of the recipes they came from. Staple/pantry rows fold by
    // name; user-removed rows join the skipped group. Every fold carries all its
    // source keys so Remove / Add-back act on the whole group.
    const cartGroups = new Map();    // upc -> { primary, keys, rows, recipes:Set }
    const unmatched = [];            // matched? no. still-included.
    const skippedGroups = new Map(); // "reason|name" -> { row, keys }
    const removedEntries = [];       // user-removed rows
    results.forEach((r) => {
      if (krogerExcluded.has(r.key)) {
        if (r.skipReason) {
          const sk = `${r.skipReason}|${normalizeItemName(r.item)}`;
          const g = skippedGroups.get(sk);
          if (g) g.keys.push(r.key); else skippedGroups.set(sk, { row: r, keys: [r.key] });
        } else {
          removedEntries.push({ row: r, keys: [r.key] });
        }
        return;
      }
      if (!r.product) { unmatched.push(r); return; }
      const upc = r.product.upc || r.key;
      let g = cartGroups.get(upc);
      if (!g) { g = { primary: r, keys: [], rows: [], recipes: new Set() }; cartGroups.set(upc, g); }
      g.keys.push(r.key); g.rows.push(r);
      (r.recipes || []).forEach((n) => g.recipes.add(n));
    });

    const sectionHead = (label) => `<div class="kroger-section">${esc(label)}</div>`;
    const cartHtml = (g) => {
      const p = g.primary.product;
      const price = typeof p.price === "number" ? `$${p.price.toFixed(2)}` : "";
      const meta = [p.size, price, p.aisle ? `Aisle ${p.aisle}` : ""].filter(Boolean).join(" · ");
      const qty = purchaseQtyStr(g.rows, g.primary.item);
      const head = (qty ? `(${qty}) ` : "") + titleCase(g.primary.item);
      const n = g.recipes.size;
      const sub = n ? `for ${n} recipe${n === 1 ? "" : "s"}` : "";
      return `<div class="kroger-row">
        <div class="kroger-row-main">
          <span class="kroger-row-item">${esc(head)}</span>
          ${sub ? `<span class="kroger-row-recipes">${esc(sub)}</span>` : ""}
          <span class="kroger-row-match">${esc(p.description || "")}${meta ? ` — ${esc(meta)}` : ""}</span>
        </div>
        <span class="kroger-row-tag">✓ in cart</span>
        <button type="button" class="kroger-row-x" data-kroger-remove="${esc(g.keys.join(" "))}" aria-label="Remove ${esc(g.primary.item)}">✕</button>
      </div>`;
    };
    const unmatchedHtml = (r) => `<div class="kroger-row is-unmatched">
        <div class="kroger-row-main">
          <span class="kroger-row-item">${esc(titleCase(r.item))}</span>
          <span class="kroger-row-match">No match — search the store</span>
        </div>
        <a class="ghost-btn small" href="${esc(krogerSearchLink(r.item))}" target="_blank" rel="noopener noreferrer">Search</a>
      </div>`;
    const skippedHtml = (entry) => {
      const r = entry.row;
      const reason = r.skipReason === "staple" ? "staple — keep on hand"
        : r.skipReason === "pantry" ? "already in your pantry" : "removed";
      return `<div class="kroger-row is-excluded">
        <div class="kroger-row-main">
          <span class="kroger-row-item">${esc(r.item)}</span>
          <span class="kroger-row-match">${esc(reason)}</span>
        </div>
        <button type="button" class="ghost-btn small" data-kroger-restore="${esc(entry.keys.join(" "))}">Add back</button>
      </div>`;
    };

    const byItem = (a, b) => (a.primary ? a.primary.item : a.item || a.row.item)
      .localeCompare(b.primary ? b.primary.item : b.item || b.row.item);
    const parts = [];
    const cartArr = [...cartGroups.values()].sort(byItem);
    if (cartArr.length) { parts.push(sectionHead("Going to your cart")); cartArr.forEach((g) => parts.push(cartHtml(g))); }
    const unArr = unmatched.slice().sort((a, b) => a.item.localeCompare(b.item));
    if (unArr.length) { parts.push(sectionHead("Couldn’t match — search the store")); unArr.forEach((r) => parts.push(unmatchedHtml(r))); }
    const skipArr = [...skippedGroups.values(), ...removedEntries].sort((a, b) => a.row.item.localeCompare(b.row.item));
    if (skipArr.length) { parts.push(sectionHead("Already stocked / skipped")); skipArr.forEach((e) => parts.push(skippedHtml(e))); }
    krogerReviewList.innerHTML = parts.join("");

    krogerSendCartBtn.hidden = sendable === 0;
    krogerSendCartBtn.textContent = `🛒 Add ${sendable} item${sendable === 1 ? "" : "s"} to cart`;
    krogerSendCartBtn.disabled = false;
    krogerOpenStore.hidden = true;
    // The match report is a debugging artifact — hidden from the cook by default,
    // revealed only with ?debug in the URL (the krogerMatchReport() logic stays).
    krogerDownloadBtn.hidden = !(KROGER_DEBUG && results.length);
  }
  // Remove an item before sending (or add a removed/pantry item back). Buttons
  // carry every source key in a folded group (space-separated) so one click acts
  // on the whole merged product.
  krogerReviewList.addEventListener("click", (e) => {
    const rm = e.target.closest("[data-kroger-remove]");
    const rs = e.target.closest("[data-kroger-restore]");
    if (rm) { rm.dataset.krogerRemove.split(" ").forEach((k) => krogerExcluded.add(k)); renderKrogerReview(krogerLastResults); }
    else if (rs) { rs.dataset.krogerRestore.split(" ").forEach((k) => krogerExcluded.delete(k)); renderKrogerReview(krogerLastResults); }
  });

  // A plain-text match report — the grocery line, the term actually searched,
  // and what Kroger matched (with size/price/upc/aisle) plus status. Download it
  // to share for tuning the ingredient→product matching.
  const krogerDownloadBtn = $("#kroger-download-matches");
  function krogerMatchReport() {
    const store = krogerPrefs.storeName || krogerPrefs.locationId || "(no store set)";
    const out = [
      "King Soopers match report",
      `Store: ${store}   ·   Preference: ${krogerPrefs.productPref}   ·   ${new Date().toLocaleString()}`,
      "".padEnd(60, "-")
    ];
    krogerLastResults.forEach((r) => {
      const p = r.product;
      const status = krogerExcluded.has(r.key)
          ? (r.skipReason === "staple" ? "SKIPPED (staple)" : r.skipReason === "pantry" ? "SKIPPED (in pantry)" : "REMOVED")
        : !p ? "NO MATCH"
        : "IN CART";
      const searched = r.term && r.term !== String(r.item).toLowerCase() ? `  [searched: "${r.term}"]` : "";
      out.push(`[${status}] "${r.item}"${searched}`);
      if (p) {
        const price = typeof p.price === "number" ? `$${p.price.toFixed(2)}` : "";
        const meta = [p.size, price, p.aisle ? `aisle ${p.aisle}` : "", p.upc ? `upc ${p.upc}` : ""].filter(Boolean).join(" · ");
        out.push(`      -> ${p.description || "(no description)"}${meta ? `  (${meta})` : ""}`);
      }
    });
    return out.join("\n");
  }
  krogerDownloadBtn.addEventListener("click", () => {
    downloadBlob(new Blob([krogerMatchReport()], { type: "text/plain" }), "king-soopers-match-report.txt");
  });

  // ---- Stage B: per-user OAuth ("Connect King Soopers") + one-tap cart push ----
  // PKCE: a high-entropy verifier stays in sessionStorage; its SHA-256 challenge
  // goes to Kroger. The verifier + a CSRF state + the pending cart survive the
  // redirect so we can finish the exchange and auto-send after the user returns.
  const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  function randToken(n = 48) {
    const a = new Uint8Array(n); crypto.getRandomValues(a);
    return b64url(a.buffer);
  }
  async function pkceChallenge(verifier) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    return b64url(digest);
  }
  async function startKrogerConnect(pendingItems) {
    const verifier = randToken(48);
    const state = randToken(16);
    try {
      sessionStorage.setItem("kr_verifier", verifier);
      sessionStorage.setItem("kr_state", state);
      sessionStorage.setItem("kr_pending", JSON.stringify(pendingItems || []));
    } catch { /* private mode — connect can still proceed, just no auto-resume */ }
    const challenge = await pkceChallenge(verifier);
    const result = await supabaseClient.functions.invoke("kroger", {
      body: { mode: "auth-url", code_challenge: challenge, state }
    }).catch((error) => ({ error }));
    const { data, error } = result;
    if (error || data?.error || !data?.url) {
      krogerReviewStatus.textContent = data?.error || "Couldn’t start the King Soopers login — try again.";
      return;
    }
    window.location.assign(data.url); // hand off to Kroger's consent screen
  }
  // Runs on load when we come back with ?code=…&state=…: verify state, exchange
  // the code for tokens, clean the URL, then resume any pending cart send.
  async function handleKrogerOAuthReturn() {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const state = params.get("state");
    let verifier = null, savedState = null, pending = [];
    try {
      verifier = sessionStorage.getItem("kr_verifier");
      savedState = sessionStorage.getItem("kr_state");
      pending = JSON.parse(sessionStorage.getItem("kr_pending") || "[]");
    } catch { /* ignore */ }
    // Always strip the OAuth params from the URL regardless of outcome.
    history.replaceState(null, "", window.location.pathname);
    if (!code || !state || !verifier || state !== savedState) return; // not ours / stale
    try { sessionStorage.removeItem("kr_verifier"); sessionStorage.removeItem("kr_state"); sessionStorage.removeItem("kr_pending"); } catch {}
    const result = await supabaseClient.functions.invoke("kroger", {
      body: { mode: "connect", code, code_verifier: verifier }
    }).catch((error) => ({ error }));
    const { data, error } = result;
    if (error || data?.error) { toast(data?.error || "King Soopers connection failed — try again."); return; }
    toast("King Soopers connected");
    if (Array.isArray(pending) && pending.length) {
      krogerPanel.hidden = false;
      krogerReviewStatus.textContent = "Connected — sending your list…";
      await sendKrogerCart(pending);
    }
  }
  // PUT the matched items into the user's real cart. On "not_connected" it kicks
  // off the OAuth flow, stashing these items to auto-send on return.
  async function sendKrogerCart(items) {
    if (!items || !items.length) { krogerReviewStatus.textContent = "No matched items to send."; return; }
    krogerSendCartBtn.disabled = true;
    krogerReviewStatus.textContent = "Sending to your King Soopers cart…";
    const result = await supabaseClient.functions.invoke("kroger", {
      body: { mode: "cart", items, modality: krogerPrefs.modality }
    }).catch((error) => ({ error }));
    const { data, error } = result;
    if (data?.error === "not_connected") {
      krogerReviewStatus.textContent = "Connect your King Soopers account to finish…";
      await startKrogerConnect(items);
      return;
    }
    if (error || data?.error) { krogerReviewStatus.textContent = data?.error || "Couldn’t add to your cart — try again."; krogerSendCartBtn.disabled = false; return; }
    krogerSendCartBtn.hidden = true;
    krogerOpenStore.hidden = false;
    krogerReviewStatus.textContent = `✓ ${data.added || items.length} item${(data.added || items.length) === 1 ? "" : "s"} added to your King Soopers cart. Open the app to review and check out.`;
  }
  krogerSendCartBtn.addEventListener("click", () => sendKrogerCart(krogerCartItems()));
  // Open the send sheet. With no store set, show the inline "Where do you shop?"
  // step first (picking a store re-enters here and continues); otherwise match.
  async function startKrogerSend() {
    if (!session) { toast("Sign in to send your list."); return; }
    const stillNeeded = allGroceryItems().filter((it) => !checkedGroceryItems.has(it.key));
    // Keep amount/unit/recipes client-side (keyed by item key) to show quantity +
    // "for N recipes" in the review; the function only needs key + item to search.
    krogerItemMeta = new Map(stillNeeded.map((it) => [it.key, { amount: it.amount, unit: it.unit, recipes: it.recipes || [] }]));
    const items = stillNeeded.map((it) => ({ key: it.key, item: it.item, amount: it.amount, unit: it.unit }));
    if (!items.length) { toast("Your grocery list is empty."); return; }
    groceryPanel.hidden = true;
    krogerPanel.hidden = false;
    if (!krogerPrefs.locationId) { showKrogerStoreStep(); return; }
    hideKrogerStoreStep();
    await runKrogerMatch(items);
  }
  async function runKrogerMatch(items) {
    const krLoadMsg = krogerLoading.querySelector("p");
    if (krLoadMsg) krLoadMsg.textContent = items.length > 40
      ? `Matching ${items.length} items to King Soopers… a large list can take a minute.`
      : "Matching your list to King Soopers…";
    krogerLoading.hidden = false;
    krogerReviewSummary.hidden = true;
    krogerReviewList.innerHTML = "";
    krogerReviewStatus.textContent = "";
    // Safety net so a very large list can't leave the spinner hanging forever.
    const KR_TIMEOUT = Symbol("kr-search-timeout");
    const krInvoke = supabaseClient.functions.invoke("kroger", {
      body: { mode: "search", items, locationId: krogerPrefs.locationId, productPref: krogerPrefs.productPref }
    }).catch((error) => ({ error }));
    const result = await Promise.race([krInvoke, new Promise((res) => setTimeout(() => res(KR_TIMEOUT), 150_000))]);
    krogerLoading.hidden = true;
    if (result === KR_TIMEOUT) { krogerReviewStatus.textContent = "That took too long — try fewer recipes at once, or re-run (any matches found are cached)."; return; }
    const { data, error } = result;
    if (error || data?.error) { krogerReviewStatus.textContent = data?.error || "Couldn’t reach King Soopers — try again."; return; }
    // Fresh review: reset removals and default-exclude staples (salt/pepper/oil)
    // and anything already in the pantry — don't order what you keep on hand.
    // Each is one tap to add back.
    const searchResults = Array.isArray(data.results) ? data.results : [];
    krogerExcluded.clear();
    const stockKeys = inventory.length ? inStockKeys() : null;
    searchResults.forEach((r) => {
      const meta = krogerItemMeta.get(r.key) || {};
      r.amount = meta.amount; r.unit = meta.unit; r.recipes = meta.recipes || [];
      r.skipReason = krogerSkipReason(r.item, stockKeys); // "staple" | "pantry" | null
      if (r.skipReason) krogerExcluded.add(r.key);
    });
    renderKrogerReview(searchResults);
  }
  $("#send-to-kingsoopers").addEventListener("click", startKrogerSend);

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
    downloadBlob(new Blob([exportRecipesJSON()], { type: "application/json" }), backupFilename());
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

  // ---------- Sheets: focus, scroll lock, Escape ----------
  // Every sheet here is shown by flipping its `hidden` attribute, from about a
  // dozen different call sites. Rather than thread focus handling through all of
  // them (and miss the next one), watch the attribute: whatever flips it, the
  // sheet gets the same treatment. That means these panels now
  //   - move focus inside themselves, so Tab stops walking the recipe list that
  //     is still sitting behind an aria-modal="true" dialog,
  //   - hand focus back to whatever opened them,
  //   - and lock the page behind them, which only cook mode used to do.
  const SHEET_CLOSERS = new Map();
  const openSheets = [];                 // innermost last
  const sheetOpener = new WeakMap();     // sheet -> element to restore focus to

  function registerSheet(el, closer) {
    if (!el) return;
    SHEET_CLOSERS.set(el, closer || (() => { el.hidden = true; }));
  }
  function closeTopSheet() {
    const top = openSheets[openSheets.length - 1];
    if (!top) return false;
    (SHEET_CLOSERS.get(top) || (() => { top.hidden = true; }))();
    return true;
  }
  // Reference-counted, so closing an inner sheet doesn't unlock the page while
  // an outer one is still open.
  function syncBodyScrollLock() {
    document.body.style.overflow = openSheets.length ? "hidden" : "";
  }
  function onSheetOpened(el) {
    if (openSheets.includes(el)) return;
    sheetOpener.set(el, document.activeElement);
    openSheets.push(el);
    syncBodyScrollLock();
    // Several panels already focus a field of their own right after opening
    // (the AI text box, the coach reply box, the ZIP lookup). This observer
    // fires as a microtask, i.e. after that — so only take focus if nothing in
    // the sheet has it yet.
    if (!el.contains(document.activeElement)) {
      const first = el.querySelector('[aria-label^="Close"], .cook-close-btn')
        || el.querySelector("button, [href], input, select, textarea");
      if (first) first.focus({ preventScroll: true });
    }
  }
  function onSheetClosed(el) {
    const i = openSheets.indexOf(el);
    if (i === -1) return;
    openSheets.splice(i, 1);
    syncBodyScrollLock();
    const opener = sheetOpener.get(el);
    sheetOpener.delete(el);
    // Only pull focus back if it's still inside the sheet we just closed —
    // otherwise we'd yank it away from wherever the user has since moved.
    if (opener && document.body.contains(opener) &&
        (document.activeElement === document.body || el.contains(document.activeElement))) {
      opener.focus({ preventScroll: true });
    }
  }

  registerSheet(groceryPanel, closeGroceryPanel);
  registerSheet(backupPanel);
  registerSheet(guidePanel);
  registerSheet(accountPanel);
  registerSheet(placeSheet, closePlaceSheet);
  registerSheet(recipeFormPanel, () => closeRecipeForm());
  registerSheet(aiImportPanel, closeAiImport);
  registerSheet(coachPanel, closeCoachPanel);
  registerSheet(inventoryPanel);
  registerSheet(generatePanel, closeGeneratePanel);
  registerSheet(promptPanel, closePromptPanel);
  registerSheet(cookPanel, closeCookMode);
  // These two were simply missing from the old Escape handler: Escape in the
  // Pair-a-drink sheet did nothing, and in the King Soopers review sheet it
  // closed the grocery panel *underneath* and left the sheet up.
  registerSheet(pairPanel, closePairPanel);
  registerSheet(krogerPanel, closeKrogerPanel);
  registerSheet(bottlePanel, closeBottlePanel);
  registerSheet(btAddPanel, () => closeBtAdd(null));

  const sheetObserver = new MutationObserver((records) => {
    records.forEach((r) => {
      const el = r.target;
      if (el.hidden) onSheetClosed(el); else onSheetOpened(el);
    });
  });
  SHEET_CLOSERS.forEach((_, el) => {
    sheetObserver.observe(el, { attributes: true, attributeFilter: ["hidden"] });
    if (!el.hidden) onSheetOpened(el);
  });

  // One Escape, one sheet — innermost first. The old handler ran every branch
  // without returning, so a stacked pair (the King Soopers sheet over the
  // grocery list) collapsed both on a single keypress. Cook mode keeps its own
  // handler for the arrow keys and calls stopImmediatePropagation, so it never
  // reaches this one.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!addMenu.hidden) { closeAddMenu(); return; }
    if (!detailMoreMenu.hidden) { closeDetailMoreMenu(); return; }
    closeTopSheet();
  });

  // role="tab" announces "tab 1 of 2" and promises arrow-key navigation; none of
  // these tablists had a key handler, so the promise was empty. One listener
  // covers all of them (Kitchen/Bar, Recipes/Meal plan, Pantry/Bar, the coach's
  // two modes, the three drink kinds).
  document.querySelectorAll('[role="tablist"]').forEach((list) => {
    list.addEventListener("keydown", (e) => {
      const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
      const step = keys[e.key];
      const tabs = [...list.querySelectorAll('[role="tab"]')].filter((t) => !t.disabled && t.offsetParent !== null);
      if (!step || tabs.length < 2) return;
      const i = tabs.indexOf(document.activeElement);
      if (i === -1) return;
      e.preventDefault();
      // Focus only — the tab is activated with Enter or Space. Automatic
      // activation would be fine for Kitchen/Bar, but the drink-kind tabs each
      // fire an AI call, and arrowing past one shouldn't spend anything.
      tabs[(i + step + tabs.length) % tabs.length].focus();
    });
  });

  // Keep --header-h in step with the sticky header, which the search row sticks
  // underneath. The header wraps to two rows on a phone, so this isn't a
  // constant we can hard-code.
  const siteHeaderEl = document.querySelector(".site-header");
  function measureHeader() {
    if (!siteHeaderEl) return;
    document.documentElement.style.setProperty("--header-h", `${siteHeaderEl.offsetHeight}px`);
  }
  if (window.ResizeObserver && siteHeaderEl) new ResizeObserver(measureHeader).observe(siteHeaderEl);
  window.addEventListener("resize", measureHeader);
  measureHeader();

  // Retry from the failed-load state.
  emptyEl.addEventListener("click", (e) => {
    if (!e.target.closest("#empty-retry")) return;
    dataState = "loading";
    renderList();
    loadData();
  });

  // ---------- Init ----------
  const appVersionEl = $("#app-version");
  if (appVersionEl) {
    appVersionEl.querySelector(".app-version-num").textContent = `v${APP_VERSION}`;
    appVersionEl.title = `The House Index, version ${APP_VERSION}`;
    appVersionEl.hidden = false;
  }
  syncScope();
  renderTagFilters();
  renderList();
  renderGroceryCount();
  updateMealplanBadge(); // also decides whether the Meal plan tab is shown
  initAuth();
})();
