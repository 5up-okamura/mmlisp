// ---------------------------------------------------------------------------
// AI bridge — MMLisp Live's end of the link to the local MMLisp MCP server
// (tools/mcp/mmlisp-mcp.mjs), so an AI client on the user's own subscription
// (Claude Code, Claude Desktop) can read and edit the score in this editor and
// start playback.
//
// The server listens on 127.0.0.1 only. It pushes requests down one
// Server-Sent Events stream ({id, op, args}); the page runs the op and POSTs
// the answer back to /reply. The ops are the page's to define — the bridge
// runs nothing else. Nothing here opens a connection until the user turns the
// bridge on, so a visitor to the site never reaches localhost.
// ---------------------------------------------------------------------------

export const AI_BRIDGE_DEFAULT_PORT = 5190;

/**
 * @param {{ port?: number,
 *           ops: Record<string, (args: object) => any>,
 *           onState?: (state: 'off'|'connecting'|'connected', detail?: string) => void }} opts
 */
export function createAiBridge({ port = AI_BRIDGE_DEFAULT_PORT, ops, onState }) {
  let source = null;
  let state = "off";
  const base = () => `http://127.0.0.1:${port}`;

  function setState(next, detail) {
    if (next === state && !detail) return;
    state = next;
    onState?.(next, detail);
  }

  async function answer(reply) {
    try {
      await fetch(base() + "/reply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(reply),
      });
    } catch {
      /* the server went away mid-request; its own timeout reports it */
    }
  }

  function connect(nextPort = port) {
    close();
    port = nextPort;
    setState("connecting");
    source = new EventSource(base() + "/events");
    source.onopen = () => setState("connected");
    // EventSource retries on its own; only a closed stream is final.
    source.onerror = () => setState(source?.readyState === EventSource.CLOSED ? "off" : "connecting");
    // Another tab took the link: stand down instead of taking it back.
    source.addEventListener("replaced", () => {
      close();
      setState("off", "another MMLisp Live tab took the AI connection");
    });
    source.addEventListener("request", async (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      const { id, op, args } = msg;
      if (!Object.hasOwn(ops, op)) {
        await answer({ id, ok: false, error: `MMLisp Live does not know '${op}' — reload the page for the latest app` });
        return;
      }
      try {
        await answer({ id, ok: true, result: await ops[op](args ?? {}) });
      } catch (e) {
        await answer({ id, ok: false, error: String(e?.message ?? e) });
      }
    });
  }

  function close() {
    source?.close();
    source = null;
  }

  function disconnect() {
    close();
    setState("off");
  }

  return {
    connect,
    disconnect,
    get state() {
      return state;
    },
    get port() {
      return port;
    },
  };
}
