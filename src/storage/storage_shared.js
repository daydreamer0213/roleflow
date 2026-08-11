function nowIso() {
  return new Date().toISOString();
}

function parseJson(text, fallback) {
  try {
    return JSON.parse(text || "");
  } catch {
    return fallback;
  }
}

const OUTCOME_STATUSES = ["applied", "skipped", "no_reply", "review", "later", "interview", "rejected", "invalid", "salary_mismatch"];

function storageError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function optionalInteger(value, label) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) throw new TypeError(`${label} must be an integer`);
  return parsed;
}

function optionalPositiveInteger(value, label) {
  const parsed = optionalInteger(value, label);
  if (parsed === null) return null;
  if (parsed <= 0) throw new TypeError(`${label} must be a positive integer`);
  return parsed;
}

function nullableText(value, limit = Infinity) {
  const text = String(value || "").trim();
  return text ? text.slice(0, limit) : null;
}

function validDate(value, label) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`${label} must be a valid date`);
  return date;
}

module.exports = { nowIso, parseJson, OUTCOME_STATUSES, storageError, optionalInteger, optionalPositiveInteger, nullableText, validDate };
