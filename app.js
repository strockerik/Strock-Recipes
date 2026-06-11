/* The House Index — app logic (vanilla JS, no build step) */
(function () {
  "use strict";

  // ---------- State ----------
  let section = "recipes"; // "recipes" | "cocktails"
  let searchTerm = "";
  let activeTags = new Set();
  const openItems = new Set(); // ids of expanded items
  // grocery: id -> { servings }
  const basket = new Map();

  const DATA = { recipes: [], cocktails: [] };
  let byId = {};

  // ---------- Supabase ----------
  const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  let session = null;

  // ---------- Elements ----------
  const $ = (sel) => document.querySelector(sel);
  const listEl = $("#item-list");
  const searchEl = $("#search");
  const tagFiltersEl = $("#tag-filters");
  const toggleFiltersBtn = $("#toggle-filters");
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
  const authStatusEl = $("#auth-status");
  const accountArea = $("#account-area");
  const accountEmailEl = $("#account-email");
  const signOutBtn = $("#sign-out");

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
      method: row.method || [],
      specs: row.specs,
      notes: row.notes
    };
  }

  async function loadData() {
    const { data, error } = await supabaseClient
      .from("recipes")
      .select("*")
      .order("name");

    if (error) {
      toast("Couldn’t load your recipes — try refreshing");
      return;
    }

    const items = (data || []).map(mapRecipe);
    DATA.recipes = items.filter((it) => it.section === "kitchen");
    DATA.cocktails = items.filter((it) => it.section === "bar");
    byId = {};
    items.forEach((it) => (byId[it.id] = it));

    activeTags.clear();
    openItems.clear();
    basket.clear();
    renderTagFilters();
    renderActiveFilters();
    renderList();
    renderGroceryBar();
  }

  function clearData() {
    DATA.recipes = [];
    DATA.cocktails = [];
    byId = {};
    activeTags.clear();
    openItems.clear();
    basket.clear();
    renderTagFilters();
    renderActiveFilters();
    renderList();
    renderGroceryBar();
  }

  // ---------- Auth ----------
  function updateAuthUI() {
    authGate.hidden = !!session;
    accountArea.hidden = !session;
    if (session) accountEmailEl.textContent = session.user.email;
  }

  async function initAuth() {
    const { data } = await supabaseClient.auth.getSession();
    session = data.session;
    updateAuthUI();
    if (session) await loadData();

    supabaseClient.auth.onAuthStateChange((_event, newSession) => {
      const wasSignedIn = !!session;
      session = newSession;
      updateAuthUI();
      if (session) {
        if (window.location.hash) history.replaceState(null, "", window.location.pathname + window.location.search);
        loadData();
      } else if (wasSignedIn) {
        clearData();
      }
    });
  }

  authForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = authEmailEl.value.trim();
    if (!email) return;
    authStatusEl.textContent = "Sending magic link…";
    const { error } = await supabaseClient.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin + window.location.pathname }
    });
    authStatusEl.textContent = error
      ? `Error: ${error.message}`
      : `Check ${email} for a sign-in link.`;
  });

  signOutBtn.addEventListener("click", () => supabaseClient.auth.signOut());

  // ---------- Filtering ----------
  function currentItems() {
    const items = DATA[section];
    const q = searchTerm.trim().toLowerCase();
    return items.filter((it) => {
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
    DATA[section].forEach((it) => it.tags.forEach((t) => (counts[t] = (counts[t] || 0) + 1)));
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

    listEl.innerHTML = items.map((it) => {
      const picked = basket.has(it.id);
      const servings = picked ? basket.get(it.id).servings : it.baseServings;
      const open = openItems.has(it.id);
      return `
      <li class="item${open ? " is-open" : ""}" data-id="${esc(it.id)}">
        <div class="item-row">
          <input type="checkbox" class="pick" ${picked ? "checked" : ""}
                 aria-label="Add ${esc(it.name)} to grocery list">
          <button class="item-head" aria-expanded="${open}">
            <span class="item-name">${esc(it.name)}</span>
            ${it.subtitle ? `<span class="item-sub">${esc(it.subtitle)}</span>` : ""}
            <span class="item-tags">${it.tags.map((t) => `<span class="mini-tag">${esc(t)}</span>`).join("")}</span>
          </button>
          ${picked ? `
          <span class="serv-control" aria-label="Servings for grocery list">
            <button class="serv-btn" data-step="-1" aria-label="Decrease servings">\u2212</button>
            <span class="serv-num">${servings}</span>
            <button class="serv-btn" data-step="1" aria-label="Increase servings">+</button>
            <span class="serv-label">${esc(it.servingsLabel)}</span>
          </span>` : ""}
          <span class="chevron" aria-hidden="true">\u25B6</span>
        </div>
        ${open ? renderDetail(it, servings) : ""}
      </li>`;
    }).join("");
  }

  function renderDetail(it, servings) {
    const ings = scaledIngredients(it, servings);
    const scaledNote = servings !== it.baseServings
      ? ` \u00B7 scaled to ${servings} ${esc(it.servingsLabel)}`
      : ` \u00B7 makes ${it.baseServings} ${esc(it.servingsLabel)}`;
    const specRows = it.specs
      ? Object.entries(it.specs).filter(([, v]) => v)
          .map(([k, v]) => `<span><b>${esc(k[0].toUpperCase() + k.slice(1))}:</b> ${esc(v)}</span>`).join("")
      : "";
    return `
    <div class="item-detail">
      <p class="detail-meta">Source: ${esc(it.source || "\u2014")}${scaledNote}</p>
      <div class="detail-grid">
        <div>
          <h3 class="detail-h">Ingredients</h3>
          <ul class="ing-list">
            ${ings.map((ing) => {
              const l = ingLine(ing, true);
              return `<li><span class="ing-amt">${esc(l.amtStr)}</span><span>${esc(l.item)}</span></li>`;
            }).join("")}
          </ul>
          ${specRows ? `<div class="spec-table">${specRows}</div>` : ""}
        </div>
        <div>
          <h3 class="detail-h">Method</h3>
          <ol class="step-list">${it.method.map((s) => `<li>${esc(s)}</li>`).join("")}</ol>
          ${it.notes ? `<p class="detail-notes">${esc(it.notes)}</p>` : ""}
        </div>
      </div>
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
    return [...basket.entries()].map(([id, { servings }]) => {
      const it = byId[id];
      return {
        name: it.name,
        servings,
        label: it.servingsLabel,
        lines: scaledIngredients(it, servings).map((ing) => ingLine(ing, true))
      };
    });
  }

  function renderGroceryPanel() {
    groceryContent.innerHTML = groceryGroups().map((g) => `
      <div class="g-recipe">
        <p class="g-recipe-name">${esc(g.name)}</p>
        <p class="g-recipe-serv">${g.servings} ${esc(g.label)}</p>
        <ul class="g-items">
          ${g.lines.map((l) => `<li><span class="ing-amt">${esc(l.amtStr)}</span><span>${esc(l.item)}</span></li>`).join("")}
        </ul>
      </div>`).join("");
  }

  function groceryText() {
    const date = new Date().toLocaleDateString();
    let out = `Grocery list \u2014 ${date}\n`;
    groceryGroups().forEach((g) => {
      out += `\n${g.name} (${g.servings} ${g.label})\n`;
      g.lines.forEach((l) => {
        out += `\u2610 ${l.amtStr === "\u2014" ? "" : l.amtStr + " "}${l.item}\n`;
      });
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
      renderTagFilters();
      renderActiveFilters();
      renderList();
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

  // Tag chips (filter panel + active-filter row)
  function handleTagClick(e) {
    const chip = e.target.closest(".tag-chip");
    if (chip) {
      const t = chip.dataset.tag;
      activeTags.has(t) ? activeTags.delete(t) : activeTags.add(t);
      renderTagFilters();
      renderActiveFilters();
      renderList();
      return;
    }
    if (e.target.id === "clear-tags") {
      activeTags.clear();
      renderTagFilters();
      renderActiveFilters();
      renderList();
    }
  }
  tagFiltersEl.addEventListener("click", handleTagClick);
  activeFiltersEl.addEventListener("click", handleTagClick);

  // List interactions (expand, pick, servings) — event delegation
  listEl.addEventListener("click", (e) => {
    const li = e.target.closest(".item");
    if (!li) return;
    const id = li.dataset.id;

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

    if (e.target.closest(".item-head") || e.target.classList.contains("chevron")) {
      openItems.has(id) ? openItems.delete(id) : openItems.add(id);
      renderList();
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
    renderList();
    renderGroceryBar();
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

  // Escape closes the grocery panel
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !groceryPanel.hidden) groceryPanel.hidden = true;
  });

  // ---------- Init ----------
  renderTagFilters();
  renderList();
  renderGroceryBar();
  initAuth();
})();
