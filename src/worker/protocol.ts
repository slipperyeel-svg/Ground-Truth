/** Messages between the page and the analysis worker. */
import type { ElevationMeta } from '../terrain/grid';
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

export type WorkerResponse =
  | { type: 'progress'; id: number; message: string }
  | { type: 'loaded'; id: number; ground: LoadedGround }
  | { type: 'viewshed'; id: number; result: ViewshedResult }
  | { type: 'error'; id: number; message: string };
