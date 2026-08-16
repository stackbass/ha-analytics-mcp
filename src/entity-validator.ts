import { getCachedEntityList } from "./cache.js";
import { EnrichedEntity } from "./ha-client.js";

export interface EntityValidation {
  entity: EnrichedEntity;
}

export interface EntitiesValidation {
  entities: EnrichedEntity[];
  unit: string | null;
}

// ---------------------------------------------------------------------------
// Candidate suggestion ladder
// ---------------------------------------------------------------------------

interface Candidate {
  entity: EnrichedEntity;
  score: number;
  matchedOn: string;
}

/**
 * Score how well a known entity matches a not-found entity_id.
 * Ladder: exact object_id > object_id substring > friendly-name substring >
 * word overlap. Returns null below the confidence floor so we never present
 * arbitrary entities as candidates.
 */
function scoreCandidate(entity: EnrichedEntity, requestedId: string): Candidate | null {
  const requested = requestedId.toLowerCase();
  // Object id = the part after the domain ("sensor.kitchen_temp" -> "kitchen_temp").
  // For a dot-less request, treat the whole string as the object id.
  const dot = requested.indexOf(".");
  const requestedObject = dot >= 0 ? requested.slice(dot + 1) : requested;
  if (requestedObject.length < 3) return null;

  const knownId = entity.statistic_id.toLowerCase();
  const knownObject = knownId.slice(knownId.indexOf(".") + 1);
  const knownName = entity.friendly_name.toLowerCase();

  if (knownObject === requestedObject) return { entity, score: 4, matchedOn: "object id" };
  if (knownObject.includes(requestedObject) || requestedObject.includes(knownObject)) {
    return { entity, score: 3, matchedOn: "object id" };
  }
  if (knownName.includes(requestedObject.replace(/_/g, " "))) {
    return { entity, score: 2, matchedOn: "friendly name" };
  }
  const words = requestedObject.split("_").filter((w) => w.length >= 3);
  if (words.length > 0) {
    const hits = words.filter((w) => knownObject.includes(w) || knownName.includes(w));
    if (hits.length >= Math.max(1, Math.ceil(words.length / 2))) {
      return { entity, score: 1, matchedOn: "word overlap" };
    }
  }
  return null;
}

function notFoundError(entityId: string, list: EnrichedEntity[]): string {
  const candidates = list
    .map((e) => scoreCandidate(e, entityId))
    .filter((c): c is Candidate => c !== null)
    .sort((a, b) => b.score - a.score);
  const top = candidates.slice(0, 5);
  const suggestions = top
    .map((c) => `  ${c.entity.statistic_id} (${c.entity.friendly_name}, ${c.entity.area_name ?? "no area"}) — matched on ${c.matchedOn}`)
    .join("\n");
  return (
    `ERROR: Entity "${entityId}" not found in ${list.length} known entities.\n` +
    (top.length > 0
      ? `Candidates (${top.length} of ${candidates.length} matches):\n${suggestions}\n` +
        `If one of these is right, retry with that exact entity_id.\n`
      : "") +
    `Call ha_history_list_entities with search="..." to find the correct entity_id.`
  );
}

function capabilityError(entity: EnrichedEntity, capability: "mean" | "sum"): string | null {
  if (capability === "mean" && !entity.has_mean) {
    return (
      `ERROR: Entity "${entity.statistic_id}" (${entity.friendly_name}) has no mean statistics — ` +
      `it is a cumulative sensor (e.g. energy meter). ` +
      `Use ha_history_get_consumption instead.`
    );
  }
  if (capability === "sum" && !entity.has_sum) {
    return (
      `ERROR: Entity "${entity.statistic_id}" (${entity.friendly_name}) has no sum statistics — ` +
      `it is a measurement sensor (e.g. temperature). ` +
      `Use ha_history_get_sensor_stats instead.`
    );
  }
  return null;
}

const LIST_NOT_LOADED =
  `ERROR: Entity list not yet loaded. The server may still be starting up. ` +
  `Retry the same call in a moment.`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Validates that an entity_id exists and has the expected capability.
 * Returns the enriched entity or an error string.
 */
export function validateEntity(
  entityId: string,
  capability: "mean" | "sum"
): EntityValidation | string {
  const result = validateEntities([entityId], capability);
  if (typeof result === "string") return result;
  return { entity: result.entities[0]! };
}

/**
 * Validates a list of entity_ids for capability and (for multi-entity) same-unit requirement.
 * Returns the enriched entities and their shared unit, or an error string.
 */
export function validateEntities(
  entityIds: string[],
  capability: "mean" | "sum"
): EntitiesValidation | string {
  const list = getCachedEntityList();
  if (!list) return LIST_NOT_LOADED;

  const entities: EnrichedEntity[] = [];
  for (const entityId of entityIds) {
    const entity = list.find((e) => e.statistic_id === entityId);
    if (!entity) return notFoundError(entityId, list);
    const capErr = capabilityError(entity, capability);
    if (capErr) return capErr;
    entities.push(entity);
  }

  // For multi-entity mode, enforce same unit
  if (entities.length > 1) {
    const firstUnit = entities[0]!.unit ?? "";
    const mismatch = entities.filter((e) => (e.unit ?? "") !== firstUnit);
    if (mismatch.length > 0) {
      const unitList = entities
        .map((e) => `  ${e.statistic_id} (${e.friendly_name}): ${e.unit ?? "no unit"}`)
        .join("\n");
      return (
        `ERROR: Mixed units in multi-entity request — all entities must share the same unit.\n` +
        `Requested entities and their units:\n${unitList}\n` +
        `Use separate calls for entities with different units.`
      );
    }
  }

  const unit = entities[0]?.unit ?? null;
  return { entities, unit };
}
