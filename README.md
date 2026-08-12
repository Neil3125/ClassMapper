# ClassMapper

A campus map that knows your class schedule. Shows your next class, walks you there
along real sidewalks, and tells you when to leave.

Built for **Tuskegee University** — 53 campus buildings with real coordinates.

```
Next class: MATH 207 — 10:00 AM
Chappie James Center · Room 118
11 min walk · 818 m       Leave by 9:44 AM
```

---

## Setup

### 1. Get a free Gemini API key (optional, for screenshot import)

Go to **[aistudio.google.com/apikey](https://aistudio.google.com/apikey)** → *Create API key*.

Free tier, **no credit card required**. You only need this if you want to import
your schedule by screenshot — manual entry works without any key.

> This is **not** a Google Maps key. The map here uses OpenStreetMap, which is free
> and needs no key at all. Don't enable Google Cloud billing for this.

### 2. Run it locally

Double-click **`start.bat`**. It starts the server, waits for it to come up, and opens
your browser at <http://localhost:8765>. Live GPS works on `localhost`.

When you're done, double-click **`stop.bat`** to shut the server down.

Running `start.bat` twice won't spawn a second server — it notices one is already
running and just opens the tab.

<details>
<summary>Or start it by hand</summary>

```bash
python serve.py 8765
```

Use `serve.py`, not `python -m http.server` — it sends no-cache headers and the
right MIME types, so you never end up staring at a stale copy after an edit.
</details>

### 3. Put it on your phone

Live location needs HTTPS, so it has to be hosted. GitHub Pages is free:

```bash
git init && git add -A && git commit -m "ClassMapper"
gh repo create ClassMapper --public --source=. --push
```

Then in the repo: **Settings → Pages → Source: deploy from `main`, folder `/ (root)`**.
Your URL appears in about a minute.

On your phone, open that URL → **Share → Add to Home Screen**. It launches fullscreen
like a native app and works offline.

### 4. Add your schedule

Open **Settings ⚙**, paste your Gemini key, then **✎ → Import screenshot**.
Pick a screenshot of your schedule; check what it read on the review screen; save.

Or skip the key entirely and use **✎ → Add class**.

---

## How it works

| Piece | What it uses | Cost |
|---|---|---|
| Map tiles | OpenStreetMap (+ Esri satellite toggle) | Free, no key |
| Building coordinates | OpenStreetMap via Overpass, baked into `data/buildings.json` | Free |
| Walking routes | [FOSSGIS Valhalla](https://valhalla1.openstreetmap.de) pedestrian routing | Free, no key |
| Schedule screenshot reading | Google Gemini, using **your** key | Free tier |

There is no backend. Your schedule, your API key, and your pin corrections live in
`localStorage` on your device and are never uploaded. The only outbound calls are the
screenshot to Gemini when you press import, and coordinate pairs to Valhalla for routing.

Routes are cached permanently by coordinate pair — a building-to-building walk gets
fetched once, ever. If the network is down, the app falls back to a straight-line
estimate and labels it as approximate.

---

## Features

- **Next class card** — course, time, building, room, walk time, and a leave-by time
- **Turn-by-turn directions** along actual campus walkways
- **Full-day route** — chains every class today, with total distance and free gaps.
  Each leg between two classes can be shown or hidden with its checkbox, or tap a
  leg's name to solo just that one — so a busy day doesn't have to be one tangled
  line on the map
- **Open in Google Maps / Apple Maps / Waze** — hand the current route off to whatever
  map app you actually navigate with. Works from the next-class card, from any class
  in your list, and for the whole day (Google Maps only — see below)
- **Leave-by alerts** — browser notification when it's time to walk (app must be open)
- **Offline** — opt-in in Settings; caches the app, buildings, and visited map tiles
- **Pin-drop correction** — tap the map to fix a building's location or add a missing one
- **Backup / restore** — export your schedule as JSON (the API key is never included)

### Opening a route in another map app

Tap **Open in** under the next-class card (or **Open in Maps** next to any class in
your list) to hand that destination to Google Maps, Apple Maps, or Waze. These are
each provider's own deep-link format — they open the app if it's installed and fall
back to the web version if it isn't, on both iOS and Android. No account, no API key,
and ClassMapper doesn't see anything past the tap.

The start point is always left blank, so the map app uses your phone's live GPS —
that's more accurate than anything this page could hand it, and it works even if you
never gave ClassMapper's own browser tab location access.

**Only Google Maps' link format supports multiple stops.** Apple Maps and Waze links
can only carry one destination, so **Today → Open whole day in Google Maps** is
Google-only by design — there's no equivalent for the other two.

### Offline mode is opt-in

Settings → **Work offline**. It's off by default on purpose: a service worker sits
between the page and the server permanently, and if one gets into a bad state it
can keep serving old files. Turn it on once the app is on your phone and working —
that's where offline actually matters.

If the app ever looks broken, stuck on an old version, or won't load, open:

```
<your-url>/reset.html
```

That clears the cache and the service worker. **Your classes, pins and API key are
not touched.**

---

## Building data

`data/buildings.json` holds 53 Tuskegee buildings pulled from OpenStreetMap.
Coordinates are building **centroids**, not entrances — close enough for walk times,
but use pin-drop if a specific one matters.

Regenerate from live OSM data:

```bash
node tools/fetch-buildings.mjs
```

Building names are matched loosely, so `BRIM 205`, `Brimmer`, and
`Andrew F. Brimmer College of Business` all resolve to the same place. Room numbers
are stripped automatically. When a name doesn't match, you pick the building once and
the app remembers that abbreviation for next term.

If a building is missing entirely, add it via **Settings → Add a missing building**.

---

## Tests

```bash
node --test tests/schedule.test.mjs
```

20 tests covering the time logic — day rollover, Friday-to-Monday, classes in progress,
AM/PM parsing, gap calculation, and leave-by arithmetic.

---

## Notes

- **Notifications only fire while the app is open.** Background push would need a
  server, which this app deliberately doesn't have.
- **GitHub Pages sites are publicly reachable.** The code is public; your schedule and
  key are not — they never leave your device.
- **Clearing browser data wipes your schedule.** Use Settings → Export backup first.
- The routing and map services are free public endpoints. Be reasonable with them;
  the route cache already keeps requests to a minimum.

Map data © OpenStreetMap contributors (ODbL). Routing by FOSSGIS. Imagery © Esri.
