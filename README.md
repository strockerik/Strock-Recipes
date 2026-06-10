# The House Index — Recipes & Cocktails

A clean, single-page site for your personal recipe and cocktail databases. No build step, no dependencies — just static files that GitHub Pages can host for free.

## Files

```
index.html          the page
style.css           styling (light theme)
app.js              search, filters, grocery list logic
data/recipes.js     ← your kitchen recipes (edit this to add recipes)
data/cocktails.js   ← your cocktails (edit this to add cocktails)
```

## Put it on GitHub Pages (one-time, ~5 minutes)

1. Go to github.com → **New repository**. Name it anything (e.g. `house-index`). Set it **Public**. Create it.
2. On the new repo page, click **uploading an existing file**, drag in `index.html`, `style.css`, `app.js`, and the `data` folder (upload `recipes.js` and `cocktails.js` into a folder named `data` — you can drag the whole folder in at once). Commit.
3. Go to the repo's **Settings → Pages**. Under "Build and deployment," set Source to **Deploy from a branch**, branch **main**, folder **/ (root)**. Save.
4. Wait a minute or two. Your site will be live at `https://YOUR-USERNAME.github.io/house-index/`.

Any time you change a file, the site updates automatically within a minute or so of committing.

## Adding a recipe or cocktail

1. Open `data/recipes.js` (or `data/cocktails.js`) — on GitHub you can click the file and hit the pencil icon to edit right in the browser, no download needed.
2. Scroll to the **TEMPLATE** comment at the bottom of the file. Copy the template block, paste it just **above** the template comment, and fill it in.
3. Commit. Done — new tags you use will automatically show up in the filter list.

Tips:
- `id` must be unique within the file (lowercase, dashes, no spaces).
- `amount: null` is for things that don't scale ("salt, to taste", "olive oil — a generous amount").
- Decimal amounts display as fractions on the site (0.5 → ½, 0.25 → ¼).
- Watch the commas: every entry except the last needs a comma after its closing `}` — the template includes a leading comma for this reason.

## Grocery list → Google Keep

Google doesn't offer a public "add to Keep" link, so the site uses the next best things:

- **On your phone:** check the recipes you want, set servings, open the grocery list, and tap **Send to phone / Keep**. Your phone's share sheet opens — choose **Google Keep** and the list lands in a new note (each line has a ☐ checkbox character).
- **On desktop:** tap **Copy list**, then paste into a note at keep.google.com (turn on "Show checkboxes" in the note's menu and Keep converts the lines into real checkboxes).
- There's also a **Download .txt** option if you just want a file.

## Local preview

Just double-click `index.html` — it works straight from your computer, no server needed.

## Add it to your iPhone home screen (works like an app)

1. Open your live GitHub Pages URL in **Safari** (this has to be Safari, not Chrome).
2. Tap the **Share** button (square with the up arrow), then **Add to Home Screen**, then **Add**.
3. You'll get a "Hi" icon on your home screen. Launching from there opens the site full-screen — no Safari address bar — and it behaves like a native app: the Kitchen/Bar tabs, search, filters, servings steppers, and the grocery list all work the same.
4. **Send to phone / Keep** works especially well here: it opens the iOS share sheet directly, and Google Keep appears as a target if you have the Keep app installed.

One thing to know: the grocery list selection lives in the current session, so if you fully close the app, the checked recipes reset. Build your list, send it to Keep, and Keep holds onto it from there.
