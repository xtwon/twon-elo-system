// ====== CONFIG ======
const SHEET_URL =
  "https://docs.google.com/spreadsheets/d/e/2PACX-1vS1EvZ123peUPNKv9VpF88IOZv26D2klj8ptAOe0HGcVcvFJT6-UxyMbLHxYijurM63axdLM6UiPGCs/pub?output=csv";
const DRIVE_LINKS_URL = "drive_links.json"; // local static file

// Placement config
const PLACEMENT_COUNT = 5;
const PLACEMENT_MIN = 5.5;
const PLACEMENT_MAX = 6.5;
const PLACEMENT_SKIPS = 2;

// Post-placement matchmaking
const MATCHMAKING_BAND = 0.33;

// Rating adjustment
const BASE_GAIN = 0.05;
const BASE_LOSS = 0.05;
const BONUS_SCALE = 0.30;

// Skip cooldown post-placements
const SKIP_COOLDOWN = 3;

// ====== STATE ======
let driveLinks = {};
let mapPool = [];
let currentMap = null;
let inPlacement = false;
let placement = null;

function loadState() {
  const raw = localStorage.getItem("twon_player_state");
  if (raw) return JSON.parse(raw);
  return {
    has_rating: false,
    rating: null,
    post_skip_counter: SKIP_COOLDOWN,
  };
}

function saveState() {
  localStorage.setItem("twon_player_state", JSON.stringify(state));
}

let state = loadState();

// ====== UTIL ======
function rand(min, max) {
  return Math.random() * (max - min) + min;
}

function diffToSymbol(value) {
  const ranges = [
    [5.0, 5.5, "10th"],
    [5.51, 5.75, "α-"],
    [5.76, 6.0, "α"],
    [6.01, 6.25, "β-"],
    [6.26, 6.5, "β"],
    [6.51, 6.75, "β+"],
    [6.76, 6.99, "γ-"],
    [7.0, 7.25, "γ"],
    [7.26, 7.5, "γ+"],
    [7.51, 7.75, "δ--"],
    [7.76, 7.99, "δ-"],
    [8.0, 8.25, "δ"],
    [8.26, 8.5, "δ+"],
    [8.51, 8.75, "ε--"],
    [8.76, 8.99, "ε-"],
    [9.0, 9.25, "ε"],
    [9.26, 9.5, "ε+"],
    [9.51, 9.75, "ζ--"],
    [9.76, 9.99, "ζ-"],
    [10.0, 10.25, "ζ"],
    [10.26, 10.5, "ζ+"],
    [10.51, 10.75, "η--"],
    [10.76, 10.99, "η-"],
    [11.0, 11.25, "η"],
    [11.26, 11.5, "η+"],
  ];

  for (const [lo, hi, sym] of ranges) {
    if (value >= lo && value <= hi) return sym;
  }
  return "?";
}

function resolveRealUrl(pool, candidate) {
  if (candidate.url && candidate.url.toLowerCase().startsWith("http"))
    return candidate.url;

  const same = pool.filter(
    (m) => m.map_name === candidate.map_name && m.mapper === candidate.mapper
  );

  for (const m of same) {
    if (m.url && m.url.startsWith("https://osu.ppy.sh/beatmapsets/"))
      return m.url;
  }
  return candidate.url || "#";
}

function updateRating(currentRating, playedDiff, sRanked) {
  const delta = playedDiff - currentRating;
  const scale = Math.min(1.0, Math.abs(delta) / MATCHMAKING_BAND);
  const bonusMult = 1.0 + BONUS_SCALE * scale;

  let newRating;
  if (sRanked) {
    newRating = currentRating + BASE_GAIN * bonusMult;
  } else {
    const belowMult =
      playedDiff < currentRating ? 1.0 + BONUS_SCALE * scale : 1.0;
    newRating = currentRating - BASE_LOSS * belowMult;
  }

  return Math.max(0.0, +newRating.toFixed(2));
}

function pickPostMap(pool, rating) {
  const lo = rating - MATCHMAKING_BAND;
  const hi = rating + MATCHMAKING_BAND;

  let choices = pool.filter(
    (m) => m.real_diff >= lo && m.real_diff <= hi
  );

  if (!choices.length) {
    choices = [...pool]
      .sort(
        (a, b) =>
          Math.abs(a.real_diff - rating) - Math.abs(b.real_diff - rating)
      )
      .slice(0, 20);
  }

  if (!choices.length) return null;

  return choices[Math.floor(Math.random() * choices.length)];
}

function normalizeKey(mapName, mapper) {
  return `${mapName}_${mapper}`.replace(/\s+/g, "_").trim();
}

// ====== PLACEMENT SESSION ======
class PlacementSession {
  constructor(pool) {
    this.pool = pool;
    this.remaining = PLACEMENT_COUNT;
    this.skipsLeft = PLACEMENT_SKIPS;
    this.low = PLACEMENT_MIN;
    this.high = 10.0;
    this.maxSuccess = null;
    this.minFail = null;
    this.anchorPlayed = [];
  }

  nextTargetDiff() {
    if (this.maxSuccess === null && this.minFail === null) {
      return +(rand(PLACEMENT_MIN, PLACEMENT_MAX).toFixed(2));
    }
    const [lastPlayed, lastSuccess] =
      this.anchorPlayed[this.anchorPlayed.length - 1];
    let target;
    if (lastSuccess) {
      if (
        this.anchorPlayed.length > 1 &&
        this.anchorPlayed[this.anchorPlayed.length - 2][1] === false
      ) {
        target = lastPlayed + 0.3;
      } else {
        target = lastPlayed + 0.8;
      }
    } else {
      target = this.maxSuccess ? this.maxSuccess + 0.3 : this.low;
    }
    return +Math.min(target, this.high).toFixed(2);
  }

  pickMapNear(targetDiff, band = 0.1) {
    let step = band;
    while (step <= 0.5) {
      const candidates = this.pool.filter(
        (m) => Math.abs(m.real_diff - targetDiff) <= step
      );
      if (candidates.length) {
        candidates.sort((a, b) => {
          const da = Math.abs(a.real_diff - targetDiff);
          const db = Math.abs(b.real_diff - targetDiff);
          if (da !== db) return da - db;
          return Math.random() - 0.5;
        });
        return candidates[0];
      }
      step += 0.05;
    }
    return null;
  }

  registerResult(playedDiff, sRanked) {
    this.anchorPlayed.push([playedDiff, sRanked]);
    if (sRanked) {
      this.maxSuccess =
        this.maxSuccess !== null
          ? Math.max(this.maxSuccess, playedDiff)
          : playedDiff;
      this.low = Math.max(this.low, playedDiff);
    } else {
      this.minFail =
        this.minFail !== null
          ? Math.min(this.minFail, playedDiff)
          : playedDiff;
      this.high = Math.min(this.high, playedDiff);
    }
    this.remaining -= 1;
  }

  ratingResult() {
    if (this.maxSuccess !== null && this.minFail !== null) {
      return +(((this.maxSuccess + this.minFail) / 2).toFixed(2));
    } else if (this.maxSuccess !== null) {
      return +this.maxSuccess.toFixed(2);
    } else if (this.minFail !== null) {
      return +(this.minFail - 0.2).toFixed(2);
    } else {
      return +(((PLACEMENT_MIN + PLACEMENT_MAX) / 2).toFixed(2));
    }
  }
}

// ====== UI WIRES ======
const screenMain = document.getElementById("screen-main");
const screenPlay = document.getElementById("screen-play");
const ratingText = document.getElementById("rating-text");
const btnStart = document.getElementById("btn-start");
const btnBack = document.getElementById("btn-back");
const contextEl = document.getElementById("context");
const mapTitleEl = document.getElementById("map-title");
const mapUrlEl = document.getElementById("map-url");
const mapMetaEl = document.getElementById("map-meta");
const mapImgEl = document.getElementById("map-image");
const imageNoteEl = document.getElementById("image-note");
const btnS = document.getElementById("btn-s");
const btnUnder = document.getElementById("btn-under");
const btnSkip = document.getElementById("btn-skip");
const skipInfoEl = document.getElementById("skip-info");

// New feedback buttons
const btnLike = document.getElementById("btn-like");
const btnDislike = document.getElementById("btn-dislike");
const btnReport = document.getElementById("btn-report");


// ====== UI FUNCTIONS ======
function showMain() {
  screenPlay.classList.add("hidden");
  screenMain.classList.remove("hidden");
  if (!state.has_rating) {
    ratingText.textContent = "No rating yet (complete placements)";
  } else {
    ratingText.textContent = `Your rating: ${state.rating}`;
  }
}

function showPlay() {
  screenMain.classList.add("hidden");
  screenPlay.classList.remove("hidden");
  nextOrDraw();
}

// ====== FLOW ======
async function loadMapPool() {
  try {
    const d = await fetch(DRIVE_LINKS_URL);
    driveLinks = await d.json();
  } catch (e) {
    driveLinks = {};
    console.warn("drive_links.json load failed:", e);
  }

  try {
    const resp = await fetch(SHEET_URL);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const csvText = await resp.text();
    const parsed = Papa.parse(csvText, { skipEmptyLines: true });
    console.log("Raw first 10 rows:", parsed.data.slice(0, 10));

    let headerRowIndex = parsed.data.findIndex(
      (row) =>
        row.some((h) => h.toLowerCase().includes("maps")) &&
        row.some((h) => h.toLowerCase().includes("difficulty level"))
    );

    if (headerRowIndex === -1) {
      alert("Could not find header row in CSV.");
      console.error("Headers not found in CSV!");
      return;
    }

    const headers = parsed.data[headerRowIndex].map((h) => h.trim());
    const rows = parsed.data.slice(headerRowIndex + 1);
    console.log("Detected headers:", headers);

    mapPool = rows
      .map((row) => {
        const rowObj = {};
        headers.forEach((h, i) => (rowObj[h] = (row[i] || "").trim()));
        const rd = parseFloat(rowObj["Difficulty Level"] || "");
        if (Number.isNaN(rd)) return null;

        // Mapper fix: always use Column B as fallback
        const mapper = rowObj["Mapper"] || row[1] || "";

        return {
          map_name: rowObj["Maps"],
          mapper: mapper,
          diff_name: (rowObj["Difficulty"] || row[2] || "").trim(),
          url: rowObj["Ø"] || row[3] || "",
          image: rowObj["Background"],
          real_diff: rd
        };
      })
      .filter(Boolean);

    console.log(`Loaded ${mapPool.length} maps`);
  } catch (e) {
    console.error("Failed to fetch/parse map pool:", e);
    alert("Map pool could not be loaded.\n" + e.message);
  }
}

// ====== FLOW CONTINUED ======
function nextOrDraw() {
  if (inPlacement) {
    if (placement.remaining <= 0) {
      const newRating = placement.ratingResult();
      state.has_rating = true;
      state.rating = newRating;
      state.post_skip_counter = SKIP_COOLDOWN;
      saveState();
      alert(`Placements Complete — your rating is ${newRating}.`);
      inPlacement = false;
      showMain();
      return;
    }

    const target = placement.nextTargetDiff();
    let picked = placement.pickMapNear(target);
    if (!picked && mapPool.length) {
      picked = mapPool
        .slice()
        .sort(
          (a, b) =>
            Math.abs(a.real_diff - target) - Math.abs(b.real_diff - target)
        )[0];
    }

    currentMap = picked;
    drawCurrentMap(
      true,
      `Placements left: ${placement.remaining} | Skips left: ${placement.skipsLeft}`
    );
    btnSkip.disabled = placement.skipsLeft <= 0;
    skipInfoEl.textContent = "";
  } else {
    const rating = state.rating ?? (PLACEMENT_MIN + PLACEMENT_MAX) / 2;
    const picked = pickPostMap(mapPool, rating);
    if (!picked) {
      alert("No maps near your rating.");
      showMain();
      return;
    }

    currentMap = picked;
    drawCurrentMap(
      false,
      `Rating: ${rating} | Map diff: ${picked.real_diff.toFixed(2)}`
    );
    const canSkip =
      (state.post_skip_counter ?? SKIP_COOLDOWN) >= SKIP_COOLDOWN;
    btnSkip.disabled = !canSkip;
    const remain = Math.max(
      0,
      SKIP_COOLDOWN - (state.post_skip_counter ?? 0)
    );
    skipInfoEl.textContent = canSkip
      ? "Skip available"
      : `Skip available after ${remain} more map(s)`;
  }
}

// ====== IMAGE HANDLING ======
function drawCurrentMap(placementMode, extra = "") {
  contextEl.textContent = placementMode ? "Placement Match" : "Ranked Match";
  const m = currentMap;
  const symbol = diffToSymbol(m.real_diff);

  mapTitleEl.textContent = `${m.map_name} — ${m.diff_name} (${m.real_diff.toFixed(
    2
  )} ${symbol}) by ${m.mapper}`;

  m.url = resolveRealUrl(mapPool, m);
  mapUrlEl.textContent = m.url || "(no link)";
  mapUrlEl.href = m.url || "#";
  mapMetaEl.textContent = extra;

  let key = normalizeKey(m.map_name || "", m.mapper || "");
  let link = driveLinks[key];

  // Only fallback to twon if mapper is empty/missing
  if (!link && (!m.mapper || m.mapper.trim() === "")) {
    key = normalizeKey(m.map_name || "", "twon");
    link = driveLinks[key];
  }

  console.log("Looking for image with key:", key);
  imageNoteEl.textContent = "";

  if (link) {
    mapImgEl.src = link;
    mapImgEl.style.display = "block";
  } else if (m.image) {
    mapImgEl.src = m.image;
    mapImgEl.style.display = "block";
  } else {
    mapImgEl.removeAttribute("src");
    mapImgEl.style.display = "none";
    imageNoteEl.textContent = "[No image found]";
  }
}

function resolveMap(sRanked) {
  if (!currentMap) return;
  const playedDiff = currentMap.real_diff;
  if (inPlacement) {
    placement.registerResult(playedDiff, sRanked);
  } else {
    const old = state.rating ?? (PLACEMENT_MIN + PLACEMENT_MAX) / 2;
    const newR = updateRating(old, playedDiff, sRanked);
    state.rating = newR;
    state.post_skip_counter = Math.min(
      SKIP_COOLDOWN,
      (state.post_skip_counter ?? 0) + 1
    );
    saveState();
  }
  nextOrDraw();
}

function skipMap() {
  if (inPlacement) {
    if (placement.skipsLeft <= 0) return;
    placement.skipsLeft -= 1;
    nextOrDraw();
  } else {
    if ((state.post_skip_counter ?? 0) < SKIP_COOLDOWN) return;
    state.post_skip_counter = 0;
    saveState();
    nextOrDraw();
  }
}

btnStart.addEventListener("click", () => {
  if (!mapPool.length) {
    alert("Map pool could not be loaded. Try again.");
    return;
  }
  if (state.has_rating) {
    inPlacement = false;
  } else {
    inPlacement = true;
    placement = new PlacementSession(mapPool);
  }
  showPlay();
});
btnBack.addEventListener("click", () => showMain());
btnS.addEventListener("click", () => resolveMap(true));
btnUnder.addEventListener("click", () => resolveMap(false));
btnSkip.addEventListener("click", skipMap);

// ====== FEEDBACK WITH COOLDOWN + GOOGLE SHEETS LOGGING ======
// ====== FEEDBACK WITH COOLDOWN + GOOGLE FORM LOGGING ======
// ====== FEEDBACK WITH COOLDOWN + GOOGLE FORM LOGGING ======
let lastFeedbackTime = 0;

// Use formResponse endpoint, not viewform
const FORM_URL = "https://docs.google.com/forms/d/e/1FAIpQLSdMDtUK06INTDA-ARiPPYDnWFqB6uNDitkJ7MWDC11QcjIgtQ/formResponse";

// Your entry IDs from the prefilled link
const ENTRY_MAPNAME = "entry.222024870";
const ENTRY_MAPPER = "entry.644179412";
const ENTRY_FEEDBACK = "entry.1746047793";

function canSendFeedback() {
  const now = Date.now();
  return now - lastFeedbackTime >= 60 * 1000; // 1 minute
}

function setFeedbackCooldown() {
  btnLike.disabled = true;
  btnDislike.disabled = true;
  setTimeout(() => {
    btnLike.disabled = false;
    btnDislike.disabled = false;
  }, 60 * 1000);
}

// grab the feedback message element from HTML
// grab the feedback message element from HTML
const feedbackMsgEl = document.getElementById("feedback-message");

async function sendFeedback(mapName, mapper, feedback) {
  if (!canSendFeedback()) {
    // ❌ show cooldown message instead of alert
    if (feedbackMsgEl) {
      feedbackMsgEl.style.display = "block";
      feedbackMsgEl.style.color = "orange";
      feedbackMsgEl.textContent = "⏳ You must wait before sending feedback again.";
      setTimeout(() => {
        feedbackMsgEl.style.display = "none";
        feedbackMsgEl.style.color = "limegreen"; // reset color for success
      }, 3000);
    }
    return;
  }

  const formData = new URLSearchParams();
  formData.append(ENTRY_MAPNAME, mapName);
  formData.append(ENTRY_MAPPER, mapper);
  formData.append(ENTRY_FEEDBACK, feedback);

  try {
    await fetch(FORM_URL, {
      method: "POST",
      body: formData,
      mode: "no-cors" // silent submit
    });

    console.log("✅ Feedback logged:", feedback, mapName, "by", mapper);

    // ✅ show success confirmation
    if (feedbackMsgEl) {
      feedbackMsgEl.style.display = "block";
      feedbackMsgEl.style.color = "limegreen";
      feedbackMsgEl.textContent = "Feedback sent! Thank you for improving the map pool!";
      setTimeout(() => {
        feedbackMsgEl.style.display = "none";
      }, 3000);
    }
  } catch (e) {
    console.error("Feedback send failed:", e);
  }

  lastFeedbackTime = Date.now();
  setFeedbackCooldown();
}

btnLike.addEventListener("click", () => {
  if (!currentMap) return;
  sendFeedback(currentMap.map_name, currentMap.mapper, "Like");
});

btnDislike.addEventListener("click", () => {
  if (!currentMap) return;
  sendFeedback(currentMap.map_name, currentMap.mapper, "Dislike");
});

btnReport.addEventListener("click", () => {
  if (!currentMap) return;
  console.log("⚠️ Report issue with:", currentMap.map_name, "by", currentMap.mapper);
  const mapLabel = `${currentMap.map_name} — ${currentMap.mapper}`;
  const formBase = "https://docs.google.com/forms/d/e/1FAIpQLScM4gTLC0wiZsTZU7Uw5i8ZmW888izA6r-6mHDH_Y8jpplwJQ/viewform?usp=pp_url";
  const fullUrl = `${formBase}&entry.1057683109=${encodeURIComponent(mapLabel)}`;
  window.open(fullUrl, "_blank");
});




// ====== BOOT ======
(async function boot() {
  try {
    await loadMapPool();
  } catch (e) {
    console.error("Map pool load error:", e);
  }
  showMain();
})();
