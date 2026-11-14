/** Messages between the page and the analysis worker. */
import type { ElevationMeta, Point } from '../terrain/grid';
import type { ProblemText } from '../tactics/problem';
import type { GroundClassification } from '../terrain/classify';
import type { ContourLine } from '../terrain/contours';

export type DemoTerrain = 'ridge' | 'cone' | 'valley' | 'flat';

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
    }
  | {
      /** Read the features of the loaded ground and set a tactical problem on it. */
      type: 'problem';
      id: number;
      /** Testing only (?unchecked=1): allow problems whose stands could not be checked for public access. */
      allowUnchecked?: boolean;
    };

export interface LoadedGround {
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
  | { type: 'error'; id: number; message: string };
