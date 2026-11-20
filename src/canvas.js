// REST client for the yctimlin mcp_excalidraw canvas 2.1.2 (routes verified in its dist/server.js).
export class CanvasError extends Error {
  constructor(message) { super(message); this.status = 502; }
}

export function createCanvas(baseUrl) {
  async function call(method, route, body) {
    let res;
    try {
      res = await fetch(baseUrl + route, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
    } catch (e) {
      throw new CanvasError(`canvas unreachable at ${baseUrl}: ${e.cause?.code ?? e.message}`);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) throw new CanvasError(`canvas ${method} ${route} failed (${res.status}): ${data.error ?? 'no detail'}`);
    return data;
  }

  return {
    async elements() { return (await call('GET', '/api/elements')).elements ?? []; },
    async files() { return (await call('GET', '/api/files')).files ?? {}; },

    /** PNG bytes of `scene` ({elements, files}), or of the live canvas without one. Headless node renderer; needs no tab. */
    async exportPng(scene) {
      const { data } = await call('POST', '/api/export/image', scene ? { format: 'png', renderer: 'node', ...scene } : { format: 'png' });
      if (typeof data !== 'string' || !data) throw new CanvasError('canvas export returned no image');
      return Buffer.from(data.slice(data.indexOf(',') + 1), 'base64');
    },

    /** Replace the canvas scene with `doc`. Files go one per request: the canvas JSON limit is 10 MB. */
    async load(doc) {
      for (const f of Object.values(doc.files ?? {})) await call('POST', '/api/files', { files: [f] });
      const live = (doc.elements ?? []).filter((e) => !e.isDeleted);
      await call('POST', '/api/elements/batch', { elements: live, replace: true });
    },
  };
}
