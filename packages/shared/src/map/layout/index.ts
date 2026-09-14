// Pure map layout: roads, scatter, prop catalog, POI authoring helpers, validation and the overview map. No engine imports.
export * from "./geometry";
export * from "./props";
export * from "./roads";
export * from "./buildings";
export * from "./scatter";
export * from "./placement";
export * from "./mapLayout";
export * from "./collision";
export * from "./validate";
export { renderMapOverviewSvg, type OverviewOptions } from "./overview";
export { buildMapWorld, loadMapWorld, serveMapWorld, type MapWorld, type MapWorldMessage, type MapWorldOptions, type MapWorldRequest, type MapWorldStage } from "./mapWorld";
