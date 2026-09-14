// Bot navigation (docs/bots/design.md §3): pure, deterministic grid build and time-sliced A*. No engine imports.
export { NAV_DEFAULTS, buildNavGrid } from "./buildNavGrid";
export { NAV_QUERY_LIMITS, createNavQuery, GridNavQuery } from "./navQuery";
export { NAV_GRID_VERSION, NavGridData, asNavGridData, type NavBuildStats, type NavPlacement, type NavPrefabLayer } from "./navGrid";
export { deserializeNavGrid, serializeNavGrid } from "./serialize";
export { isValidZoneCenter, navMainComponent, navStats } from "./helpers";
export { mapNavProbes, resolveProbes, type NavProbe, type NavProbeKind, type ProbeResult } from "./mapProbes";
