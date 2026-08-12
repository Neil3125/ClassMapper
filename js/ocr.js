// Schedule screenshot -> structured classes, via the Gemini API using your key.
//
// The building list is sent along with the image and the model is required to
// return one of our building ids, so name resolution ("ENGR BLDG", "Chappie
// James Ctr") happens in the model rather than in brittle string matching.
// Nothing it returns is saved directly — everything lands in a review screen.

import { read, write, remove, KEYS } from './store.js';
import { promptManifest, match } from './buildings.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// Google periodically retires dated model snapshots (gemini-2.0-flash was live
// for months, then started rejecting every request with a 404 telling callers
// to move on — which reads exactly like a bad key if you're not looking at the
// message). Rather than hardcode one name, try a short list in order and
// remember whichever one actually answers, so a single future retirement can't
// silently break imports again.
//
// 'gemini-flash-latest' is Google's own rolling alias — it should always point
// at whatever the current fast model is, so it's tried first. The pinned
// versions below it are fallbacks in case the alias itself is ever missing.
const MODEL_CANDIDATES = ['gemini-flash-latest', 'gemini-2.5-flash', 'gemini-2.0-flash'];

export function getKey() {
  return read(KEYS.API_KEY, '');
}

export function setKey(key) {
  const trimmed = String(key ?? '').trim();
  if (trimmed) write(KEYS.API_KEY, trimmed);
  else remove(KEYS.API_KEY);
}

export function hasKey() {
  return Boolean(getKey());
}

/** Confirms the key works AND that at least one candidate model answers it. */
export async function testKey(key = getKey()) {
  if (!key) throw new Error('No API key saved');

  const listRes = await fetch(`${BASE}?key=${encodeURIComponent(key)}`);
  if (listRes.status === 400 || listRes.status === 401 || listRes.status === 403) {
    throw new Error('That key was rejected. Check you copied all of it from Google AI Studio.');
  }
  if (!listRes.ok) throw new Error(`Google returned ${listRes.status}`);

  // The key is valid, but confirm a model will actually respond to it — this
  // is what catches "your key is fine, Google just retired the model" early,
  // in Settings, instead of mid-import.
  try {
    await generate({ contents: [{ role: 'user', parts: [{ text: 'Reply with the single word: ok' }] }] });
  } catch (err) {
    throw new Error(`Key works, but no Gemini model responded: ${err.message}`);
  }
  return true;
}

export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      resolve({ mimeType: file.type || 'image/png', data: result.slice(result.indexOf(',') + 1) });
    };
    reader.onerror = () => reject(new Error('Could not read that image'));
    reader.readAsDataURL(file);
  });
}

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    classes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'Course code, e.g. "CS 101"' },
          title: { type: 'string', description: 'Course title, empty string if absent' },
          days: {
            type: 'array',
            description: 'Meeting days as single letters: U M T W R F S',
            items: { type: 'string' },
          },
          startTime: { type: 'string', description: '24-hour HH:MM' },
          endTime: { type: 'string', description: '24-hour HH:MM' },
          buildingId: {
            type: 'string',
            description: 'Exact id from the provided building list, or empty string if no confident match',
          },
          buildingRaw: { type: 'string', description: 'Location text exactly as printed on the schedule' },
          room: { type: 'string', description: 'Room number only, empty string if absent' },
        },
        required: ['code', 'days', 'startTime', 'endTime', 'buildingRaw'],
      },
    },
  },
  required: ['classes'],
};

function buildPrompt(buildings) {
  return `You are reading a screenshot of a university class schedule from Tuskegee University.

Extract every class meeting you can see. Rules:

- "days": use single letters — U=Sunday, M=Monday, T=Tuesday, W=Wednesday, R=Thursday, F=Friday, S=Saturday.
  Registrar notation like "MWF" becomes ["M","W","F"]; "TR" or "TTh" becomes ["T","R"].
- "startTime"/"endTime": 24-hour HH:MM. Convert from AM/PM. A schedule showing "9:00-9:50 AM" is 09:00 to 09:50.
- If one course has two separate meeting patterns (e.g. a lecture and a lab at different times or places),
  emit them as two separate entries with the same code.
- "buildingRaw": copy the location text exactly as printed, including any abbreviation.
- "buildingId": match the location to the campus building list below and return its exact id.
  Match on the name OR any of the "aka" values. Abbreviations on schedules are often truncated
  versions of the name — use judgement. If you are not reasonably confident, return an empty
  string rather than guessing; the user will resolve it by hand.
- Ignore rows that are not scheduled meetings: online/asynchronous sections with no time or place,
  headers, totals, credit-hour columns, and advisor or holds information.
- If the image is not a class schedule at all, return an empty classes array.

Campus building list (JSON):
${JSON.stringify(buildings)}`;
}

/** True for a 404 / "model not found or retired" style response, where trying
 *  the next candidate model makes sense. False for anything else (bad key,
 *  rate limit, bad request) where retrying with a different model won't help. */
function isModelUnavailable(status, detail) {
  if (status === 404) return true;
  return /not found|no longer available|deprecated|not supported/i.test(detail ?? '');
}

async function callModel(model, key, body, signal) {
  const res = await fetch(`${BASE}/${model}:generateContent?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.json())?.error?.message ?? '';
    } catch { /* body wasn't JSON */ }
    const err = new Error(detail || `Google returned ${res.status}`);
    err.status = res.status;
    err.detail = detail;
    throw err;
  }
  return res.json();
}

/**
 * Call Gemini, trying each candidate model in order until one actually
 * answers. The model that works is remembered so later imports go straight to
 * it instead of re-discovering it every time.
 */
async function generate(body, signal) {
  const key = getKey();
  if (!key) throw new Error('Add your Gemini API key in Settings first');

  const remembered = read(KEYS.OCR_MODEL, null);
  const order = remembered ? [remembered, ...MODEL_CANDIDATES.filter((m) => m !== remembered)] : MODEL_CANDIDATES;

  let lastErr;
  for (const model of order) {
    try {
      const data = await callModel(model, key, body, signal);
      if (model !== remembered) write(KEYS.OCR_MODEL, model);
      return data;
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      lastErr = err;
      if (err.status === 400 && /API key/i.test(err.detail ?? '')) {
        throw new Error('Your API key was rejected. Re-check it in Settings.');
      }
      if (err.status === 429) throw new Error('Rate limited by Google. Wait a minute and try again.');
      if (!isModelUnavailable(err.status, err.detail)) throw err;
      // Model unavailable/retired: fall through and try the next candidate.
    }
  }
  throw lastErr ?? new Error('No Gemini model responded.');
}

/**
 * Parse a schedule screenshot.
 * Returns { classes: [...draft records], warnings: [...] }
 */
export async function parseScreenshot(file, { signal } = {}) {
  if (!getKey()) throw new Error('Add your Gemini API key in Settings first');

  const image = await fileToBase64(file);
  const manifest = promptManifest();

  const data = await generate(
    {
      contents: [
        {
          role: 'user',
          parts: [
            { text: buildPrompt(manifest) },
            { inline_data: { mime_type: image.mimeType, data: image.data } },
          ],
        },
      ],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
      },
    },
    signal,
  );

  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ?? '';
  if (!text) throw new Error('The model returned nothing readable. Try a clearer screenshot.');

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Could not understand the response. Try again or enter the class manually.');
  }

  return toDrafts(parsed.classes ?? []);
}

const VALID_DAYS = new Set(['U', 'M', 'T', 'W', 'R', 'F', 'S']);

function hhmmToMin(str) {
  const m = String(str ?? '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function toDrafts(rows) {
  const classes = [];
  const warnings = [];

  rows.forEach((row, i) => {
    const startMin = hhmmToMin(row.startTime);
    const endMin = hhmmToMin(row.endTime);
    const label = row.code || `Row ${i + 1}`;

    if (startMin == null || endMin == null) {
      warnings.push(`${label}: couldn't read the meeting time — skipped.`);
      return;
    }
    if (endMin <= startMin) {
      warnings.push(`${label}: end time is not after start time — check it below.`);
    }

    const days = (row.days ?? []).map((d) => String(d).toUpperCase()).filter((d) => VALID_DAYS.has(d));
    if (!days.length) {
      warnings.push(`${label}: no meeting days recognised — skipped.`);
      return;
    }

    // Trust the model's id only if it actually exists; otherwise fall back to
    // our own matcher against the raw text.
    let buildingId = '';
    const claimed = String(row.buildingId ?? '').trim();
    if (claimed && match(claimed).building?.id === claimed) {
      buildingId = claimed;
    } else {
      const fallback = match(row.buildingRaw);
      if (fallback.building && fallback.confidence !== 'fuzzy') buildingId = fallback.building.id;
      else if (fallback.building) buildingId = fallback.building.id;
    }

    classes.push({
      id: crypto.randomUUID(),
      code: String(row.code ?? '').trim(),
      title: String(row.title ?? '').trim(),
      days,
      startMin,
      endMin,
      buildingId,
      buildingRaw: String(row.buildingRaw ?? '').trim(),
      room: String(row.room ?? '').trim(),
    });
  });

  if (!classes.length && !warnings.length) {
    warnings.push("No classes found in that image. Is it a schedule screenshot?");
  }

  return { classes, warnings };
}
