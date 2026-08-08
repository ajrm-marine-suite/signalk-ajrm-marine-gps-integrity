/**
 * Implements the WMM responsibilities of the AJRM Marine Navigation Integrity Signal K server.
 */

"use strict";

const geomagnetism = require("geomagnetism");

const MODEL_UNCERTAINTY_RAD = (0.5 * Math.PI) / 180;
const POSITION_CELL_DEGREES = 0.01;

function createWmmCalculator() {
  const models = new Map();
  const values = new Map();

  return function calculateWmm(position, timestamp) {
    if (!validPosition(position)) return null;
    const date = validDate(timestamp) || new Date();
    const day = date.toISOString().slice(0, 10);
    let model = models.get(day);
    if (!model) {
      model = geomagnetism.model(date, { allowOutOfBoundsModel: true });
      models.set(day, model);
    }

    const latitudeCell = Math.round(position.latitude / POSITION_CELL_DEGREES);
    const longitudeCell = Math.round(position.longitude / POSITION_CELL_DEGREES);
    const cacheKey = `${day}:${latitudeCell}:${longitudeCell}`;
    let radians = values.get(cacheKey);
    if (!Number.isFinite(radians)) {
      const point = model.point([position.latitude, position.longitude]);
      radians = normalizeSignedRadians((point.decl * Math.PI) / 180);
      values.set(cacheKey, radians);
    }

    return {
      value: radians,
      model: String(model.name || "WMM-2025").replace("-", " "),
      epochDate: day,
      uncertaintyRad: MODEL_UNCERTAINTY_RAD,
    };
  };
}

function validPosition(value) {
  return Boolean(
    value
      && Number.isFinite(value.latitude)
      && Number.isFinite(value.longitude)
      && value.latitude >= -90
      && value.latitude <= 90
      && value.longitude >= -180
      && value.longitude <= 180,
  );
}

function validDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function normalizeSignedRadians(value) {
  if (!Number.isFinite(value)) return null;
  let result = value % (2 * Math.PI);
  if (result > Math.PI) result -= 2 * Math.PI;
  if (result < -Math.PI) result += 2 * Math.PI;
  return result;
}

module.exports = {
  MODEL_UNCERTAINTY_RAD,
  createWmmCalculator,
  normalizeSignedRadians,
  validPosition,
};
