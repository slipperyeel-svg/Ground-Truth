/**
 * Terrain analysis engine — public interface.
 * Pure TypeScript, no browser or framework dependencies (except tiles-browser),
 * so it can be reused in a native app or on a server.
 */
export * from './grid';
export * from './slope';
export * from './tpi';
export * from './viewshed';
export * from './crest';
export * from './classify';
export * from './elevation';
export * from './analyse';
export * as synthetic from './synthetic';
