/* The House Index — app logic (vanilla JS, no build step) */
(function () {
  "use strict";

  // ---------- State ----------
  let section = "recipes"; // "recipes" | "cocktails"
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
  let skipPantryStaples = false;
  const checkedGroceryItems = new Set(); // grocery: combined-item keys checked off

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
  const authGate = $("#auth-gate");
  const authForm = $("#auth-form");
  const authEmailEl = $("#auth-email");
  const authPasswordEl = $("#auth-password");
  const authSignUpBtn = $("#auth-signup");
  const authForgotBtn = $("#auth-forgot");
  const authStatusEl = $("#auth-status");
  const accountArea = $("#account-area");
  const accountEmailEl = $("#account-email");
  const accountBtn = $("#account-btn");
  const signOutBtn = $("#sign-out");
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
  const cookPanel = $("#cook-panel");
  const cookTitle = $("#cook-title");
  const cookCloseBtn = $("#cook-close");
  const cookProgressBar = $("#cook-progress-bar");
  const cookBody = $("#cook-body");
  const cookStepNum = $("#cook-step-num");
  const cookStepText = $("#cook-step-text");
  const cookIngredients = $("#cook-ingredients");
  const cookPrevBtn = $("#cook-prev");
  const cookNextBtn = $("#cook-next");
  const cookIngToggle = $("#cook-ing-toggle");

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

  function ingLine(ing, useScaled) {
    const amt = useScaled ? ing.scaled : ing.amount;
    const amtStr = amt == null ? "\u2014" : fmtAmount(amt) + (ing.unit ? " " + ing.unit : "");
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

  // Convert a combined canonical quantity to what's sold at a US grocery store.
  function shoppableQuantity(amount, family, unit) {
    if (amount == null) return { amount: null, unit };
    if (family === "weight") {
      if (amount < MIN_SHOPPABLE_GRAMS) return { amount, unit: "g" };
      const oz = amount / G_PER_OZ;
      return oz >= 16 ? { amount: oz / 16, unit: "lb" } : { amount: oz, unit: "oz" };
    }
    if (family === "volume") {
      const cups = amount / ML_PER_CUP;
      if (cups >= 0.2) return { amount: cups, unit: "cup" };
      const tbsp = amount / ML_PER_TBSP;
      return tbsp >= 1 ? { amount: tbsp, unit: "tbsp" } : { amount: amount / ML_PER_TSP, unit: "tsp" };
    }
    return { amount, unit };
  }

  // Always-on-hand items that don't belong on a shopping list. One precompiled
  // alternation (rather than building 6 RegExps per ingredient per render).
  const PANTRY_STAPLE_TERMS = ["salt", "pepper", "oil", "water", "sugar", "butter"];
  const PANTRY_STAPLE_RE = new RegExp(`\\b(?:${PANTRY_STAPLE_TERMS.join("|")})\\b`, "i");
  function isPantryStaple(nameLower) {
    return PANTRY_STAPLE_RE.test(nameLower);
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
    { name: "Produce", terms: ["onion", "onions", "garlic", "tomato", "tomatoes", "potato", "potatoes", "carrot", "carrots", "celery", "lettuce", "romaine", "spinach", "kale", "arugula", "chard", "broccoli", "cauliflower", "cucumber", "cucumbers", "zucchini", "squash", "pumpkin", "butternut", "mushroom", "mushrooms", "cremini", "portobello", "shiitake", "bell pepper", "bell peppers", "jalapeno", "jalapeño", "serrano", "poblano", "lemon", "lemons", "lime", "limes", "orange", "oranges", "apple", "apples", "banana", "bananas", "berry", "berries", "strawberry", "strawberries", "blueberry", "blueberries", "raspberry", "raspberries", "grape", "grapes", "avocado", "avocados", "ginger", "cilantro", "parsley", "basil", "mint", "thyme", "rosemary", "sage", "dill", "scallion", "scallions", "green onion", "green onions", "shallot", "shallots", "leek", "leeks", "corn", "cabbage", "eggplant", "asparagus", "green bean", "green beans", "snap pea", "snap peas", "peas", "sweet potato", "sweet potatoes", "yam", "beet", "beets", "radish", "turnip", "parsnip", "fennel", "herbs", "pineapple", "mango", "peach", "peaches", "pear", "pears", "cherry", "cherries", "cranberry", "cranberries", "melon", "watermelon", "sprouts", "bok choy"] },
    { name: "Meat & Seafood", terms: ["chicken", "beef", "pork", "bacon", "sausage", "sausages", "ham", "turkey", "lamb", "steak", "steaks", "mince", "ground beef", "ground turkey", "ground pork", "ground chicken", "ground meat", "salmon", "tuna", "shrimp", "prawn", "prawns", "fish", "cod", "tilapia", "halibut", "crab", "lobster", "scallop", "scallops", "chorizo", "prosciutto", "pancetta", "ribs", "brisket", "veal", "duck", "meatball", "meatballs", "filet", "fillet", "tenderloin", "sirloin", "ribeye", "chuck roast", "wings", "drumstick", "drumsticks", "thigh", "thighs", "chicken breast", "pepperoni", "salami", "bratwurst", "hot dog", "hot dogs"] },
    { name: "Dairy & Eggs", terms: ["milk", "cheese", "cheddar", "mozzarella", "parmesan", "parmigiano", "feta", "ricotta", "gouda", "swiss cheese", "provolone", "monterey jack", "pepper jack", "cream cheese", "sour cream", "heavy cream", "whipping cream", "half and half", "yogurt", "yoghurt", "egg", "eggs", "margarine", "buttermilk", "cottage cheese", "mascarpone", "creme fraiche", "almond milk", "oat milk", "soy milk", "cream"] },
    { name: "Dry Goods & Baking", terms: ["flour", "sugar", "brown sugar", "powdered sugar", "confectioners", "rice", "pasta", "spaghetti", "penne", "macaroni", "fettuccine", "linguine", "noodle", "noodles", "oat", "oats", "oatmeal", "quinoa", "lentil", "lentils", "couscous", "barley", "cornmeal", "cornstarch", "corn starch", "baking powder", "baking soda", "yeast", "cocoa", "vanilla", "almond extract", "chocolate chip", "chocolate chips", "chocolate", "nut", "nuts", "almond", "almonds", "walnut", "walnuts", "pecan", "pecans", "cashew", "cashews", "peanut", "peanuts", "raisin", "raisins", "honey", "maple syrup", "syrup", "molasses", "breadcrumb", "breadcrumbs", "panko", "cereal", "granola", "cracker", "crackers", "gelatin", "shortening", "split pea", "polenta", "grits", "sesame seed", "sesame seeds", "chia", "flax", "sunflower seed", "shredded coconut", "coconut flake", "marshmallow", "marshmallows", "sprinkles", "cake mix", "pancake mix", "baking mix"] },
    { name: "Condiments, Sauces & Spices", terms: ["salt", "pepper", "peppercorn", "soy sauce", "worcestershire", "fish sauce", "oyster sauce", "hoisin", "sriracha", "hot sauce", "tabasco", "ketchup", "catsup", "mustard", "mayo", "mayonnaise", "vinegar", "oil", "olive oil", "vegetable oil", "canola", "sesame oil", "cooking spray", "dressing", "ranch", "bbq sauce", "barbecue sauce", "teriyaki", "gravy", "pesto", "tahini", "miso", "gochujang", "sambal", "harissa", "horseradish", "spice", "spices", "cumin", "paprika", "cinnamon", "nutmeg", "oregano", "garlic powder", "onion powder", "chili powder", "cayenne", "turmeric", "curry", "coriander", "cardamom", "clove", "cloves", "allspice", "bay leaf", "bay leaves", "red pepper flake", "red pepper flakes", "italian seasoning", "seasoning", "garam masala", "extract", "mustard seed", "sea salt", "kosher salt", "taco seasoning", "sauce"] },
    { name: "Beverages", terms: ["wine", "beer", "ale", "lager", "cider", "soda", "cola", "tonic", "club soda", "sparkling water", "seltzer", "coffee", "espresso", "tea", "rum", "vodka", "gin", "tequila", "whiskey", "whisky", "bourbon", "brandy", "vermouth", "liqueur", "triple sec", "champagne", "prosecco", "sake", "lemonade"] }
  ];
  const GROCERY_CATEGORY_RE = GROCERY_CATEGORY_RULES.map((c) => ({
    name: c.name,
    re: new RegExp(`\\b(?:${c.terms.join("|")})\\b`, "i")
  }));
  const OTHER_CATEGORY = "Other";
  // Store-walk order for display (independent of the match-priority order
  // above); empty sections are skipped, "Other" is always last.
  const GROCERY_CATEGORY_ORDER = ["Produce", "Bakery", "Meat & Seafood", "Dairy & Eggs", "Frozen", "Canned & Jarred", "Dry Goods & Baking", "Condiments, Sauces & Spices", "Beverages", OTHER_CATEGORY];

  function categorizeGrocery(nameLower) {
    for (const c of GROCERY_CATEGORY_RE) {
      if (c.re.test(nameLower)) return c.name;
    }
    return OTHER_CATEGORY;
  }

  // Group a flat combined-grocery list into store sections, in walk order,
  // skipping any section with no items.
  function groceryByCategory(items) {
    const buckets = new Map();
    items.forEach((it) => {
      const cat = categorizeGrocery(it.item.toLowerCase());
      if (!buckets.has(cat)) buckets.set(cat, []);
      buckets.get(cat).push(it);
    });
    return GROCERY_CATEGORY_ORDER
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
    favoritesOnly = false;
    toggleFavoritesBtn.setAttribute("aria-pressed", "false");
    sharedOnly = false;
    toggleSharedBtn.setAttribute("aria-pressed", "false");
    refreshViews();
  }

  // ---------- Auth ----------
  function updateAuthUI() {
    authGate.hidden = !!session;
    accountArea.hidden = !session;
    if (session) accountEmailEl.textContent = session.user.email;
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
        if (userChanged || event !== "TOKEN_REFRESHED") setTimeout(loadData, 0);
      } else if (wasSignedIn) {
        loadedUserId = null;
        setTimeout(clearData, 0);
      }
      // Arrived via a "Forgot password?" reset link — let them set a new one.
      if (event === "PASSWORD_RECOVERY") setTimeout(promptForNewPassword, 0);
    });
  }

  async function promptForNewPassword() {
    const password = prompt("Set a new password (at least 8 characters):");
    if (!password) return;
    const { error } = await supabaseClient.auth.updateUser({ password });
    toast(error ? `Error: ${error.message}` : "Password updated.");
  }

  // Sign in (form submit / Enter key / primary button)
  authForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = authEmailEl.value.trim();
    const password = authPasswordEl.value;
    if (!email || !password) return;
    authStatusEl.textContent = "Signing in…";
    const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if (error) authStatusEl.textContent = `Error: ${error.message}`;
    // On success, onAuthStateChange takes over (hides the gate, loads data).
  });

  // Create a new account
  authSignUpBtn.addEventListener("click", async () => {
    const email = authEmailEl.value.trim();
    const password = authPasswordEl.value;
    if (!email || !password) {
      authStatusEl.textContent = "Enter an email and password first.";
      return;
    }
    if (password.length < 8) {
      authStatusEl.textContent = "Password must be at least 8 characters.";
      return;
    }
    authStatusEl.textContent = "Creating account…";
    const { data, error } = await supabaseClient.auth.signUp({ email, password });
    if (error) {
      authStatusEl.textContent = `Error: ${error.message}`;
    } else if (data.session) {
      authStatusEl.textContent = "Account created!"; // confirmation off → signed in now
    } else {
      authStatusEl.textContent = `Account created — check ${email} to confirm, then sign in.`;
    }
  });

  // Forgot / set password — emails a link that returns here in recovery mode
  authForgotBtn.addEventListener("click", async () => {
    const email = authEmailEl.value.trim();
    if (!email) {
      authStatusEl.textContent = "Enter your email above first.";
      return;
    }
    authStatusEl.textContent = "Sending reset link…";
    const { error } = await supabaseClient.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin + window.location.pathname
    });
    authStatusEl.textContent = error
      ? `Error: ${error.message}`
      : `Check ${email} for a link to set your password.`;
  });

  accountBtn.addEventListener("click", promptForNewPassword);

  signOutBtn.addEventListener("click", () => supabaseClient.auth.signOut());

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

  function renderList() {
    const items = currentItems();
    resultCountEl.textContent =
      `${items.length} ${section === "recipes" ? "recipe" : "cocktail"}${items.length === 1 ? "" : "s"}`;
    emptyEl.hidden = items.length > 0;
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
      const servings = picked ? basket.get(it.id).servings : it.baseServings;
      const open = openItems.has(it.id);
      const mine = it.userId === session?.user?.id;
      return `
      <li class="item${open ? " is-open" : ""}" data-id="${esc(it.id)}">
        <div class="item-row">
          <input type="checkbox" class="pick" ${picked ? "checked" : ""}
                 aria-label="Add ${esc(it.name)} to grocery list">
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
    const scaledNote = servings !== it.baseServings
      ? ` \u00B7 scaled to ${servings} ${esc(it.servingsLabel)}`
      : ` \u00B7 makes ${it.baseServings} ${esc(it.servingsLabel)}`;
    const specRows = it.specs
      ? Object.entries(it.specs).filter(([, v]) => v)
          .map(([k, v]) => `<span><b>${esc(k[0].toUpperCase() + k.slice(1))}:</b> ${esc(v)}</span>`).join("")
      : "";
    const ownerNote = !mine ? ` \u00B7 Shared by ${esc(profileNames[it.userId] || "someone")}` : "";
    return `
    <div class="item-detail">
      <p class="detail-meta">Source: ${esc(it.source || "\u2014")}${scaledNote}${ownerNote}</p>
      <div class="detail-grid">
        <div>
          <h3 class="detail-h">Ingredients</h3>
          ${groupRuns(ings).map((run) => `
            ${run.group ? `<h4 class="sub-group">${esc(run.group)}</h4>` : ""}
            <ul class="ing-list">
              ${run.items.map((ing) => {
                const l = ingLine(ing, true);
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
      <div class="detail-actions">
        ${it.method && it.method.length ? `<button class="solid-btn small cook-btn" data-id="${esc(it.id)}">▶ Cook</button>` : ""}
        ${mine ? `
        <button class="ghost-btn small edit-recipe" data-id="${esc(it.id)}">Edit</button>
        <button class="ghost-btn small delete-recipe-btn" data-id="${esc(it.id)}">Delete</button>
        <button class="ghost-btn small share-toggle-btn${openShareIds.has(it.id) ? " is-on" : ""}" data-id="${esc(it.id)}">${shareButtonLabel(it)}</button>` : `
        <button class="ghost-btn small copy-to-book-btn" data-id="${esc(it.id)}">📋 Copy to my book</button>`}
      </div>
      ${mine && openShareIds.has(it.id) ? renderSharePanel(it) : ""}
    </div>`;
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
    const n = basket.size;
    groceryBar.hidden = n === 0;
    if (n === 0) groceryPanel.hidden = true;
    grocerySummary.textContent = `${n} recipe${n === 1 ? "" : "s"} in your grocery list`;
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
        const nameKey = ing.item.trim().toLowerCase();
        if (skipPantryStaples && isPantryStaple(nameKey)) return;
        const { amount, family, unit } = canonicalQuantity(ing.scaled, ing.unit);
        const key = `${nameKey}__${family || unit || ""}`;
        const existing = map.get(key);
        if (existing) {
          if (amount != null) existing.amount = (existing.amount || 0) + amount;
        } else {
          map.set(key, { key, item: ing.item.trim(), family, unit, amount });
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

  function renderGroceryPanel() {
    const sections = groceryByCategory(combinedGroceryItems());
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
            </li>`;
          }).join("")}`).join("")
      : `<p class="g-empty">Nothing to buy \u2014 try turning off "Skip pantry staples".</p>`;

    groceryContent.innerHTML = `
      <label class="g-staples-toggle">
        <input type="checkbox" id="grocery-skip-staples" ${skipPantryStaples ? "checked" : ""}>
        Skip pantry staples (salt, pepper, oil, water, sugar, butter)
      </label>
      <ul class="g-combined">${itemsHtml}</ul>
      <details class="g-by-recipe">
        <summary>By recipe</summary>
        ${groceryGroups().map((g) => `
          <div class="g-recipe">
            <p class="g-recipe-name">${esc(g.name)}</p>
            <p class="g-recipe-serv">${g.servings} ${esc(g.label)}</p>
            <ul class="g-items">
              ${g.lines.map((l) => `<li><span class="ing-amt">${esc(l.amtStr)}</span><span>${esc(l.item)}</span></li>`).join("")}
            </ul>
          </div>`).join("")}
      </details>`;
  }

  function groceryText() {
    const date = new Date().toLocaleDateString();
    let out = `Grocery list \u2014 ${date}\n\n`;
    groceryByCategory(combinedGroceryItems()).forEach((sec) => {
      out += `${sec.category.toUpperCase()}\n`;
      sec.items.forEach((it) => {
        const box = checkedGroceryItems.has(it.key) ? "\u2611" : "\u2610";
        const amtStr = it.amount == null ? "" : fmtAmount(it.amount) + (it.unit ? " " + it.unit : "") + " ";
        out += `${box} ${amtStr}${it.item}\n`;
      });
      out += `\n`;
    });
    out += `Recipes:\n`;
    groceryGroups().forEach((g) => {
      out += `\u2022 ${g.name} (${g.servings} ${g.label})\n`;
    });
    return out;
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
    return `
      <div class="rf-ing-row">
        <input type="number" step="any" class="rf-ing-amount" placeholder="amt" value="${esc(amount)}">
        <input type="text" class="rf-ing-unit" placeholder="unit" value="${esc(unit)}">
        <input type="text" class="rf-ing-item" placeholder="ingredient" value="${esc(item)}" required>
        <button type="button" class="rf-row-remove" aria-label="Remove ingredient">×</button>
      </div>`;
  }

  function stepRow(text) {
    return `
      <div class="rf-step-row">
        <textarea class="rf-step-text" rows="2" placeholder="Step…">${esc(text || "")}</textarea>
        <button type="button" class="rf-row-remove" aria-label="Remove step">×</button>
      </div>`;
  }

  // A section divider in the form: every ingredient/step row below it belongs to
  // this section until the next divider. Leaving the field blank = ungrouped.
  function sectionHeadingRow(label) {
    return `
      <div class="rf-section-row">
        <input type="text" class="rf-section-input" placeholder="Section (e.g. Dough)" value="${esc(label || "")}">
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
    updateTagGroupsVisibility();
    recipeFormPanel.hidden = false;
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
  rfIngredients.addEventListener("click", (e) => {
    if (e.target.classList.contains("rf-row-remove")) e.target.closest(".rf-ing-row, .rf-section-row").remove();
  });
  rfMethod.addEventListener("click", (e) => {
    if (e.target.classList.contains("rf-row-remove")) e.target.closest(".rf-step-row, .rf-section-row").remove();
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

  async function copyToMyBook(item) {
    if (!session) { toast("You've been signed out — sign in again."); return; }
    const name = item.name;
    const dupe = Object.values(byId).find(
      (it) => it.userId === session.user.id && it.name.trim().toLowerCase() === name.trim().toLowerCase()
    );
    if (dupe && !confirm(`A recipe named "${dupe.name}" already exists in your book. Copy this one too?`)) return;

    const row = {
      user_id: session.user.id,
      section: item.section,
      name: item.name,
      subtitle: item.subtitle,
      source: item.source,
      tags: item.tags,
      base_servings: item.baseServings,
      servings_label: item.servingsLabel,
      ingredients: item.ingredients,
      method: item.method,
      specs: item.specs,
      notes: item.notes,
      is_favorite: false
    };
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
    refreshViews(); // pool changed — tag filters + active filters need refresh too
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
      if (e.target.checked) basket.set(id, { servings: byId[id].baseServings });
      else basket.delete(id);
      renderList();
      renderGroceryBar();
      if (!groceryPanel.hidden) renderGroceryPanel();
      return;
    }

    const stepBtn = e.target.closest(".serv-btn");
    if (stepBtn) {
      const entry = basket.get(id);
      entry.servings = Math.max(1, entry.servings + Number(stepBtn.dataset.step));
      renderList();
      renderGroceryBar();
      if (!groceryPanel.hidden) renderGroceryPanel();
      return;
    }

    if (e.target.closest(".cook-btn")) {
      const servings = basket.has(id) ? basket.get(id).servings : byId[id].baseServings;
      openCookMode(byId[id], servings);
      return;
    }

    if (e.target.closest(".edit-recipe")) {
      openRecipeForm(byId[id]);
      return;
    }

    if (e.target.closest(".delete-recipe-btn")) {
      deleteRecipe(byId[id]);
      return;
    }

    if (e.target.closest(".share-toggle-btn")) {
      openShareIds.has(id) ? openShareIds.delete(id) : openShareIds.add(id);
      renderList();
      return;
    }

    const removeBtn = e.target.closest(".share-remove-btn");
    if (removeBtn) {
      unshareRecipe(byId[id], removeBtn.dataset.userId);
      return;
    }

    if (e.target.closest(".copy-to-book-btn")) {
      copyToMyBook(byId[id]);
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
    if (!cookPanel.hidden && document.visibilityState === "visible") requestWakeLock();
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
    cookTitle.textContent = item.name;
    renderCookIngredients();
    cookIngredients.hidden = true;
    cookIngToggle.setAttribute("aria-expanded", "false");
    cookPanel.hidden = false;
    renderCookStep();
    requestWakeLock();
  }

  function renderCookStep() {
    const total = cookSteps.length;
    const step = cookSteps[cookIdx];
    const prefix = step.group ? `${step.group} · ` : "";
    cookStepNum.textContent = `${prefix}Step ${cookIdx + 1} of ${total}`;
    cookStepText.textContent = step.text;
    cookProgressBar.style.width = `${((cookIdx + 1) / total) * 100}%`;
    cookPrevBtn.disabled = cookIdx === 0;
    cookNextBtn.textContent = cookIdx === total - 1 ? "Done ✓" : "Next →";
    cookBody.scrollTop = 0;
  }

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
            return `<li><span class="ing-amt">${esc(l.amtStr)}</span><span>${esc(l.item)}</span></li>`;
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
    releaseWakeLock();
  }

  cookBody.addEventListener("click", cookNext); // tap the step to advance, one-handed
  cookNextBtn.addEventListener("click", cookNext);
  cookPrevBtn.addEventListener("click", cookPrev);
  cookCloseBtn.addEventListener("click", closeCookMode);
  cookIngToggle.addEventListener("click", () => {
    cookIngredients.hidden = !cookIngredients.hidden;
    cookIngToggle.setAttribute("aria-expanded", String(!cookIngredients.hidden));
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
  $("#open-grocery").addEventListener("click", () => {
    renderGroceryPanel();
    groceryPanel.hidden = false;
  });
  $("#close-grocery").addEventListener("click", () => (groceryPanel.hidden = true));
  groceryPanel.addEventListener("click", (e) => {
    if (e.target === groceryPanel) groceryPanel.hidden = true;
  });
  $("#clear-grocery").addEventListener("click", () => {
    basket.clear();
    checkedGroceryItems.clear();
    renderList();
    renderGroceryBar();
  });

  // Grocery panel: pantry-staples toggle + per-item check-off
  groceryContent.addEventListener("change", (e) => {
    if (e.target.id === "grocery-skip-staples") {
      skipPantryStaples = e.target.checked;
      renderGroceryPanel();
      return;
    }
    if (e.target.classList.contains("g-item-check")) {
      const key = e.target.dataset.key;
      if (e.target.checked) checkedGroceryItems.add(key);
      else checkedGroceryItems.delete(key);
      const li = e.target.closest("li");
      if (li) li.classList.toggle("is-checked", e.target.checked);
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

  // Escape closes the grocery panel / recipe form / AI import panel.
  // Cook mode sits on top of everything and has its own Escape handler —
  // don't also close the panels underneath it on the same keypress.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !cookPanel.hidden) return;
    if (!groceryPanel.hidden) groceryPanel.hidden = true;
    if (!recipeFormPanel.hidden) closeRecipeForm();
    if (!aiImportPanel.hidden) closeAiImport();
  });

  // ---------- Init ----------
  renderTagFilters();
  renderList();
  renderGroceryBar();
  initAuth();
})();
