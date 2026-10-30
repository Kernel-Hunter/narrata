// The first-run choice in the extension (mini player and popup): the natural voice or the fast
// one, with a suggestion from the engine's device check. Same rule as the web app (recommendVoice).

import { recommendVoice } from '../../src/core/device';
import type { EngineStatus } from '../../src/engine/protocol';
import { DEFAULT_VOICE, fastVoiceFor, isPiper, voiceById } from '../../src/engine/voices';

const mb = (n: number) => `${Math.round(n / 1e6)} MB`;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&${({ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot' } as Record<string, string>)[c]};`);

/** Nothing has been downloaded yet. */
export function isFirstRun(status: EngineStatus | undefined): boolean {
  return !!status && status.storedBytes === 0;
}

/** Voice ids for each choice, keeping the current voice when it already is of that kind. */
export function choiceVoices(current: string): { natural: string; fast: string } {
  const v = voiceById(current);
  return { natural: isPiper(v) ? DEFAULT_VOICE : v.id, fast: isPiper(v) ? v.id : fastVoiceFor(v).id };
}

/**
 * Buttons carry data-model and data-voice. The recommended one is the primary button.
 */
export function choiceHtml(status: EngineStatus, current: string): string {
  const advice = status.probe ? recommendVoice(status.probe) : null;
  const ids = choiceVoices(current);
  const fast = fastVoiceFor(voiceById(ids.fast));
  const natural = status.kokoro.missingBytes || status.kokoro.bytes;
  const button = (kind: 'natural' | 'fast', label: string) =>
    `<button class="btn${advice && advice.pick !== kind ? ' quiet' : ''}" data-model="auto" data-voice="${ids[kind]}">${label}${advice?.pick === kind ? ' (recommended)' : ''}</button>`;
  return `<p>Narrata reads with a voice that runs on this computer. Pick one to download once from Hugging Face:</p>
<p class="small"><strong>Natural voice</strong>, ${mb(natural)}: best quality, needs a fairly recent computer. <strong>Fast voice</strong>, ${mb(fast.bytes + fast.configBytes)}: works on any computer, sounds less natural.</p>
${advice ? `<p class="small">${esc(advice.reason)}</p>` : ''}
<div class="actions">${button('natural', `Natural voice, ${mb(natural)}`)}${button('fast', `Fast voice, ${mb(fast.bytes + fast.configBytes)}`)}</div>
<p class="small">You can switch voices later. Nothing you read is sent anywhere.</p>`;
}
