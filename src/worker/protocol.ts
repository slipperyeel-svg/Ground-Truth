/** Messages between the page and the analysis worker. */
import type { ElevationMeta, Point } from '../terrain/grid';
import type { ProblemText } from '../tactics/problem';
import type { Intel, Posture } from '../tactics/sectionDefence';
import type { SectionScenarioText } from '../tactics/sectionScenario';
import type { GroundClassification } from '../terrain/classify';
import type { ContourLine } from '../terrain/contours';

export type DemoTerrain = 'ridge' | 'cone' | 'valley' | 'flat';
export type Detail = 'fine' | 'medium' | 'problem' | 'standard';

/** Box size and cell size for each LIDAR detail level. */
export const LIDAR_DETAIL: Record<Exclude<Detail, 'standard'>, { sizeM: number; cellM: number; label: string }> = {
  fine: { sizeM: 2000, cellM: 2, label: 'fine (LIDAR 2 m)' },
  medium: { sizeM: 4000, cellM: 5, label: 'medium (LIDAR 5 m)' },
  problem: { sizeM: 4000, cellM: 10, label: 'LIDAR 10 m' },
};

export type WorkerRequest =
  | {
      type: 'load';
      id: number;
      lat: number;
      lon: number;
      sizeM: number;
      cellM: number;
      /** Use synthetic ground instead of real data (for testing indoors). */
      demo?: DemoTerrain;
      /**
       * Environment Agency LIDAR where it exists (England), else falls back to standard:
       * 'fine' 2 km box at 2 m; 'medium' 4 km at 5 m; 'problem' 4 km at 10 m (what the
       * problem engine is built for). 'standard': ~30 m data, sizeM/cellM as given.
       */
      detail?: Detail;
    }
  | {
      type: 'viewshed';
      id: number;
      /** Local metres from the box centre. */
      x: number;
      y: number;
      obsHeightM: number;
      targetHeightM: number;
      maxRangeM: number;
      /** Let woods, buildings and hedges block sight (fetches map features if needed). */
      useObstacles: boolean;
    }
  | {
      /** Place an enemy section blocking the user's advance from the box centre. */
      type: 'section';
      id: number;
      posture: Posture;
      /** 0–1 to pick among the best few positions for variety; omit for the best. */
      random?: number;
    }
  | {
      /** Ground height at a point (local metres), or null outside the loaded box. */
      type: 'height';
      id: number;
      x: number;
      y: number;
    }
  | {
      /** Fetch the map features for the loaded ground and draw them. */
      type: 'features';
      id: number;
    }
  | {
      /** Read the features of the loaded ground and set a tactical problem on it. */
      type: 'problem';
      id: number;
    };

export interface LoadedGround {
  /** True if the ground came from LIDAR (fine detail). */
  lidar: boolean;
  /** Why fine detail was not used, if it was asked for and is not available. */
  detailNote: string;
  width: number;
  height: number;
  cellM: number;
  meta: ElevationMeta;
  hillshade: Uint8ClampedArray;
  contours: ContourLine[];
  contourIntervalM: number;
  ground: GroundClassification;
  minM: number;
  maxM: number;
}

export interface ViewshedResult {
  mask: Uint8Array;
  observerGroundM: number;
  visibleShare: number; // share of cells in range that are visible
  timeMs: number;
  /** Whether woods, buildings and hedges were included, or why not. */
  obstaclesNote: string;
}

/** The captured map features, drawn as a see-through picture over the box. */
export interface FeaturesView {
  ok: boolean;
  /** What was loaded, or why it failed. */
  note: string;
  /** RGBA picture, width × height of the grid (only if ok). */
  image?: Uint8ClampedArray;
}

/** An enemy section layout and its scenario, ready to show. Positions in local metres. */
export interface SectionView {
  found: boolean;
  log: string[];
  featureNote: string;
  /** The scenario, written for each level of intelligence the user may be given. */
  text?: Record<Intel, SectionScenarioText>;
  /** The DS solution: shown only when the user asks. */
  ds?: {
    position: Point;
    teams: { label: string; point: Point; gun: boolean }[];
    route: Point[];
    alternatives: Point[];
    maskWidth: number;
    maskHeight: number;
    /** 1 = covered by the section's fire. */
    killZone: Uint8Array;
    /** 1 = dead ground within rifle range in front. */
    deadGround: Uint8Array;
  };
  timeMs: number;
}

/** A problem, ready to show. Positions are local metres from the box centre. */
export interface ProblemView {
  found: boolean;
  /** Why each enemy direction passed or failed. */
  log: string[];
  /** What map features were loaded, or why they failed. */
  featureNote: string;
  text?: ProblemText;
  nai?: { centre: Point; radiusM: number };
  route?: Point[];
  /** The DS solution: hidden from the user until they ask. */
  ds?: {
    enemyOps: Point[];
    bestOP?: Point;
    altOP?: Point;
    concealedOP?: Point;
    gunAreas: Point[];
    loc?: Point[];
  };
  timeMs: number;
}

export type WorkerResponse =
  | { type: 'progress'; id: number; message: string }
  | { type: 'loaded'; id: number; ground: LoadedGround }
  | { type: 'viewshed'; id: number; result: ViewshedResult }
  | { type: 'problem'; id: number; result: ProblemView }
  | { type: 'features'; id: number; result: FeaturesView }
  | { type: 'height'; id: number; result: number | null }
  | { type: 'section'; id: number; result: SectionView }
  | { type: 'error'; id: number; message: string };
