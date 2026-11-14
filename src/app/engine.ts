/**
 * The page's handle on the analysis worker: each request returns a promise.
 */
import type { DemoTerrain, FeaturesView, LoadedGround, ProblemView, ViewshedResult, WorkerRequest, WorkerResponse } from '../worker/protocol';

/** Omit that works across each member of a union. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; onProgress?: (m: string) => void };

export class Engine {
  private worker = new Worker(new URL('../worker/analysis.worker.ts', import.meta.url), { type: 'module' });
  private nextId = 1;
  private pending = new Map<number, Pending>();

  constructor() {
    this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data;
      const p = this.pending.get(msg.id);
      if (!p) return;
      if (msg.type === 'progress') {
        p.onProgress?.(msg.message);
        return;
      }
      this.pending.delete(msg.id);
      if (msg.type === 'error') p.reject(new Error(msg.message));
      else if (msg.type === 'loaded') p.resolve(msg.ground);
      else if (msg.type === 'viewshed') p.resolve(msg.result);
      else if (msg.type === 'problem') p.resolve(msg.result);
      else if (msg.type === 'features') p.resolve(msg.result);
    };
  }

  private request<T>(req: DistributiveOmit<WorkerRequest, 'id'>, onProgress?: (m: string) => void): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onProgress });
      this.worker.postMessage({ ...req, id });
    });
  }

  load(
    lat: number,
    lon: number,
    opts: { sizeM?: number; cellM?: number; demo?: DemoTerrain } = {},
    onProgress?: (m: string) => void,
  ): Promise<LoadedGround> {
    return this.request<LoadedGround>(
      { type: 'load', lat, lon, sizeM: opts.sizeM ?? 4000, cellM: opts.cellM ?? 10, demo: opts.demo },
      onProgress,
    );
  }

  /** Fetch the map features for the loaded ground and draw them. */
  features(onProgress?: (m: string) => void): Promise<FeaturesView> {
    return this.request<FeaturesView>({ type: 'features' }, onProgress);
  }

  /** Read the map features and set a tactical problem on the loaded ground. */
  problem(onProgress?: (m: string) => void, allowUnchecked = false): Promise<ProblemView> {
    return this.request<ProblemView>({ type: 'problem', allowUnchecked }, onProgress);
  }

  viewshed(
    x: number,
    y: number,
    obsHeightM: number,
    targetHeightM: number,
    maxRangeM: number,
    useObstacles: boolean,
    onProgress?: (m: string) => void,
  ): Promise<ViewshedResult> {
    return this.request<ViewshedResult>({ type: 'viewshed', x, y, obsHeightM, targetHeightM, maxRangeM, useObstacles }, onProgress);
  }
}
