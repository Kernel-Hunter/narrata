/** True only in the extension's test build (`pnpm build:ext:test`), which keeps the hooks for automated checks. */
declare const __NARRATA_TEST__: boolean;

declare module 'signalsmith-stretch' {
  export interface StretchSchedule {
    outputTime?: number;
    output?: number;
    active?: boolean;
    input?: number;
    rate?: number;
    semitones?: number;
    tonalityHz?: number;
    formantSemitones?: number;
    formantCompensation?: boolean;
    formantBaseHz?: number;
    loopStart?: number;
    loopEnd?: number;
  }
  export interface StretchNode extends AudioWorkletNode {
    inputTime: number;
    schedule(change: StretchSchedule): Promise<unknown>;
    start(when?: number): Promise<unknown>;
    stop(when?: number): Promise<unknown>;
    addBuffers(buffers: Float32Array[]): Promise<number>;
    dropBuffers(toSeconds?: number): Promise<{ start: number; end: number }>;
    latency(): Promise<number>;
    configure(config: { blockMs?: number; intervalMs?: number; splitComputation?: boolean; preset?: 'default' | 'cheaper' }): Promise<unknown>;
    setUpdateInterval(seconds: number, callback?: (inputTime: number) => void): Promise<unknown>;
  }
  export default function SignalsmithStretch(ctx: BaseAudioContext, options?: AudioWorkletNodeOptions): Promise<StretchNode>;
}
