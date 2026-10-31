import { applySemanticDelta, SemanticPages } from "./semantic-state";

/** Fixed non-LLM path through paged semantic snapshots and fresh refs. */
export function semanticProgram(): string {
  return `
      const SemanticPages = ${SemanticPages.toString()};
      const applySemanticDelta = ${applySemanticDelta.toString()};
      const frame = page.frameLocator('iframe[title="Semantic queue"]');
      const region = frame.locator('main'), progress = frame.locator('#progress');
      await progress.filter({hasText:'Completed 0 of 12'}).waitFor();
      let pageCount = 0, fragmentCount = 0, deltaChanges = 0, freshChecks = 0;
      async function capture(since) {
        const pages = new SemanticPages(); let cursor;
        do {
          const observed = cursor ? await page.inspect({cursor, budget:4000})
            : await page.inspect(since ? {since, budget:4000} : {budget:4000}, region);
          cursor = pages.append(observed, cursor); pageCount++;
          if (pageCount > 500) throw new Error('Too many semantic pages');
        } while (cursor);
        fragmentCount += pages.fragments;
        return pages.result();
      }
      let observation = await capture();
      if (observation.mode !== 'full') throw new Error('Expected a full baseline');
      let state = observation.items;
      if (!state.some(item => item.line.includes('海🌊'.repeat(2500)))) throw new Error('Long Unicode line was not reconstructed');
      const processed = [];
      for (let index = 1; index <= 12; index++) {
        const next = state.filter(item => item.ref && item.line.includes('- button "Next TASK-'));
        if (next.length !== 1) throw new Error('Expected exactly one Next ref');
        processed.push(next[0].line);
        await page.ref(next[0].ref).click();
        await progress.filter({hasText:index === 12 ? 'Queue complete' : 'Completed ' + index + ' of 12'}).waitFor();
        if (index < 12) {
          const delta = await capture(observation.observationId);
          if (delta.mode !== 'delta') throw new Error('Expected an incremental observation');
          deltaChanges += delta.items.length;
          state = applySemanticDelta(state, delta.items); observation = delta;
          if (index === 6) {
            const fresh = await capture();
            if (fresh.mode !== 'full' || JSON.stringify(state) !== JSON.stringify(fresh.items)) throw new Error('Reconstructed delta differs from a fresh snapshot');
            freshChecks++;
          }
        }
      }
      return { rounds:processed.length, pageCount, fragmentCount, deltaChanges, freshChecks };`;
}
