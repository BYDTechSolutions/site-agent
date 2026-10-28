import { SiteAgentError } from '../errors.js';
import type { Availability, ModelAdapter } from '../types.js';

const RANK: Record<Availability, number> = { available: 3, downloading: 2, downloadable: 1, unavailable: 0 };

/**
 * A fallback chain: each step goes to the first model that is `available` right now, for example
 * `firstAvailable(chromeBuiltIn(), proxy({ url }))` uses Chrome's model when it is ready and your
 * endpoint otherwise. A model without `availability()` counts as available. `availability()` of the
 * chain is the best state among its models, and `prepare()` prepares the first model that needs it.
 */
export function firstAvailable(...models: ModelAdapter[]): ModelAdapter {
  if (models.length === 0) throw new TypeError('firstAvailable: pass at least one model.');
  const states = () => Promise.all(models.map(async (m) => (m.availability ? m.availability() : ('available' as const))));
  let lastUsed: string | undefined;
  return {
    name: `first-available(${models.map((m) => m.name).join(',')})`,
    models,
    get lastUsed() {
      return lastUsed;
    },
    async availability() {
      const all = await states();
      return all.reduce<Availability>((best, s) => (RANK[s] > RANK[best] ? s : best), 'unavailable');
    },
    async prepare(options) {
      const all = await states();
      const index = all.findIndex((s) => s === 'downloadable' || s === 'downloading');
      const model = index >= 0 ? models[index] : undefined;
      if (model?.prepare) await model.prepare(options);
    },
    async respond(request) {
      const all = await states();
      const index = all.indexOf('available');
      const model = index >= 0 ? models[index] : undefined;
      if (!model) {
        const waiting = all.some((s) => s === 'downloadable' || s === 'downloading');
        throw new SiteAgentError(
          waiting ? 'model-download-required' : 'model-unavailable',
          waiting ? 'No model is ready yet: the on-device model needs a download.' : 'No model is available in this browser.',
        );
      }
      lastUsed = model.name;
      return model.respond(request);
    },
  };
}
