import { getCachedDiscoveryIndex, setCachedDiscoveryIndex } from "../cache.js";
import { fetchDiscoveryIndex, DiscoveryArea } from "../ha-client.js";
import { isError, errFromCaught } from "../errors.js";
import { config } from "../config.js";

export const LIST_AREAS_TOOL = {
  name: "ha_history_list_areas",
  description:
    `Lists the areas (rooms and locations) defined in ${config.haName}.\n` +
    `Use when the user wants to explore areas or when you need the exact area name for ha_history_list_devices.\n` +
    `Narrow by name with search. Returns area names to reuse with area="<name>" in ha_history_list_devices, which also surfaces ready entity_ids.`,
  inputSchema: {
    type: "object",
    properties: {
      search: {
        type: "string",
        description:
          `Optional search term matched against area names (case-insensitive substring match).\n` +
          `E.g. "kitchen", "outdoor", "bedroom". Leave empty to list all areas.`,
      },
      max_results: {
        type: "number",
        description: `Maximum number of results to return. Default: all areas.`,
      },
    },
    required: [],
    additionalProperties: false,
  },
};

/**
 * Score an area against an optional search term.
 * Returns a numeric score — higher is better.
 */
export function scoreArea(area: DiscoveryArea, search: string | undefined): number {
  if (!search) return 0;
  const lc = search.toLowerCase();
  const name = area.name.toLowerCase();
  if (name === lc) return 3;          // exact match
  if (name.startsWith(lc)) return 2;  // prefix match
  if (name.includes(lc)) return 1;    // substring match
  return -1;                          // no match
}

export async function handleListAreas(
  args: Record<string, unknown>
): Promise<string> {
  try {
    const search = typeof args["search"] === "string" ? args["search"].trim() : undefined;
    const rawMax = args["max_results"];
    if (rawMax !== undefined && (typeof rawMax !== "number" || !Number.isFinite(rawMax) || rawMax <= 0)) {
      return (
        `ERROR: Invalid max_results ${JSON.stringify(rawMax)} — the call was NOT executed. ` +
        `Pass a positive number, or omit it to list all areas.`
      );
    }
    const maxResults = rawMax as number | undefined;

    let index = getCachedDiscoveryIndex();
    if (!index) {
      const result = await fetchDiscoveryIndex();
      if (isError(result)) return result.text;
      setCachedDiscoveryIndex(result);
      index = result;
    }

    let areas = index.areas;

    if (search) {
      const scored = areas
        .map(a => ({ area: a, score: scoreArea(a, search) }))
        .filter(({ score }) => score >= 0);
      scored.sort((a, b) => b.score - a.score);
      areas = scored.map(s => s.area);
    } else {
      areas = [...areas].sort((a, b) => a.name.localeCompare(b.name));
    }

    if (maxResults !== undefined && maxResults > 0) {
      areas = areas.slice(0, maxResults);
    }

    if (areas.length === 0) {
      const hint = search ? ` matching "${search}"` : "";
      return (
        `No areas found${hint} in ${config.haName}.\n` +
        `Tips: leave search empty to list all defined areas. Area names are set inside Home Assistant.`
      );
    }

    const lines: string[] = [
      `${areas.length} area${areas.length === 1 ? "" : "s"} found in ${config.haName}` +
        (search ? ` (search=${search})` : "") +
        ":\n",
    ];
    for (const area of areas) {
      lines.push(`  ${area.name}`);
    }
    lines.push(
      `\nNext step: call ha_history_list_devices with area="<name>" to see devices and ready entity_ids in that area.`
    );

    return lines.join("\n");
  } catch (err) {
    return errFromCaught(err, "ha_history_list_areas").text;
  }
}
