/* eslint-disable */
(function (OMP) {
  'use strict';
  /* ==========================================================================
     OMP Studio — bus.js
     Mock RPC event bus + time-sequenced scenario player.

     The 8 scenarios marked ▶ in the plan (wb:streaming, wb:tool-burst,
     wb:approval-bash, wb:file-writing, wb:preview-hmr, wb:agents-parallel,
     wb:steering, wb:followup, wb:compacting, wb:disconnected) need to emit
     events over time rather than instantly rendering a frozen state.

     This bus provides:
     - emit(type, payload) — fire an event now
     - schedule(ms, type, payload) — fire after a delay
     - play(script) — run a sequence of { at: ms, type, payload } events
     - abort() — stop the current playback
     ========================================================================== */

    const { store } = OMP.mod['js/store'];
  class Bus {
    constructor() {
      this._subs = new Map();
      this._nextId = 1;
      this._playing = null;
      this._playTimer = null;
    }

    /* ---- Subscribe ---------------------------------------------------- */
    on(type, fn) {
      const id = this._nextId++;
      this._subs.set(id, { type, fn });
      return () => this._subs.delete(id);
    }

    /* ---- Emit --------------------------------------------------------- */
    emit(type, payload = {}) {
      this._subs.forEach(({ type: subType, fn }) => {
        if (subType === '*' || subType === type) {
          fn(type, payload);
        }
      });
    }

    /* ---- Schedule ----------------------------------------------------- */
    schedule(ms, type, payload) {
      return setTimeout(() => this.emit(type, payload), ms);
    }

    /* ---- Play a scripted sequence -------------------------------------
       script: [ { at: 0, type: 'turn.start' },
                 { at: 500, type: 'thinking.delta', text: '...' },
                 { at: 1200, type: 'tool.call', tool: 'Read', ... },
                 ... ]
       -------------------------------------------------------------------- */
    play(script) {
      this.abort();
      this._playing = script;

      const start = performance.now();
      let completed = 0;

      const tick = () => {
        if (!this._playing) return;

        const elapsed = performance.now() - start;
        while (completed < script.length) {
          const event = script[completed];
          if (event.at > elapsed) break;

          this.emit(event.type, event.payload || {});
          completed++;
        }

        if (completed < script.length) {
          this._playTimer = requestAnimationFrame(tick);
        } else {
          this._playing = null;
          this._playTimer = null;
          this.emit('playback.complete');
        }
      };

      tick();
    }

    abort() {
      if (this._playTimer) {
        cancelAnimationFrame(this._playTimer);
        this._playTimer = null;
      }
      this._playing = null;
    }

    isPlaying() {
      return this._playing !== null;
    }
  }

  const bus = new Bus();

  /* ---- Mock RPC handlers -----------------------------------------------
     Components subscribe to these to update their UI.
     Real implementation: these would come from the actual OMP CLI via RPC.
     ---------------------------------------------------------------------- */

  // Turn lifecycle
  bus.on('turn.start', ({ turnId }) => {
    store.set({ runState: 'running', currentTurn: turnId });
  });

  bus.on('turn.complete', ({ turnId }) => {
    store.set({ runState: 'idle' });
  });

  bus.on('turn.abort', () => {
    store.set({ runState: 'idle' });
  });

  // Thinking stream
  bus.on('thinking.start', () => {
    // timeline component will render a Thinking card
  });

  bus.on('thinking.delta', ({ text }) => {
    // timeline appends streamed text
  });

  bus.on('thinking.complete', ({ tokCount, durationMs }) => {
    // timeline finalizes the Thinking card
  });

  // Tool calls
  bus.on('tool.call', ({ id, tool, target, params }) => {
    // timeline adds a tool card in 'running' state
  });

  bus.on('tool.complete', ({ id, output, durationMs }) => {
    // timeline updates the tool card to 'completed'
  });

  bus.on('tool.fail', ({ id, error }) => {
    // timeline updates the tool card to 'failed'
  });

  // Approvals
  bus.on('approval.request', ({ id, tool, command, risk, impact }) => {
    store.set({ runState: 'awaiting-approval' });
    // timeline adds an approval card
  });

  bus.on('approval.granted', ({ id }) => {
    store.set({ runState: 'running' });
  });

  bus.on('approval.denied', ({ id }) => {
    store.set({ runState: 'idle' });
  });

  // Ask user
  bus.on('askuser.request', ({ id, question, options }) => {
    store.set({ runState: 'awaiting-user' });
  });

  bus.on('askuser.response', ({ id, answer }) => {
    store.set({ runState: 'running' });
  });

  // Files
  bus.on('file.reading', ({ path }) => {
    // file tree adds a reading indicator
  });

  bus.on('file.writing', ({ path }) => {
    // file tree adds a writing pulse
  });

  bus.on('file.changed', ({ path, changeType, additions, deletions }) => {
    // changes list updates, file tree marks the file
  });

  // Preview
  bus.on('preview.starting', () => {
    store.set({ previewState: 'starting' });
  });

  bus.on('preview.running', ({ url }) => {
    store.set({ previewState: 'running', previewUrl: url });
  });

  bus.on('preview.hmr', ({ file }) => {
    store.set({ previewState: 'hmr' });
    bus.schedule(800, 'preview.running', { url: store.get('previewUrl') });
  });

  bus.on('preview.error', ({ error, file, line }) => {
    store.set({ previewState: 'error' });
  });

  // Agent lifecycle
  bus.on('agent.start', ({ id, name, role, parentId }) => {
    // agent hub adds the agent
  });

  bus.on('agent.complete', ({ id }) => {
    // agent hub updates status
  });

  bus.on('agent.fail', ({ id, error }) => {
    // agent hub updates status
  });

  // Compact
  bus.on('compact.start', () => {
    store.set({ compacting: true, runState: 'compacting' });
  });

  bus.on('compact.complete', ({ turnsBefore, turnsAfter, tokensSaved }) => {
    store.set({ compacting: false, runState: 'idle' });
  });

  // OMP connection
  bus.on('omp.reconnecting', () => {
    store.set({ ompStatus: 'reconnecting' });
  });

  bus.on('omp.connected', () => {
    store.set({ ompStatus: 'ready' });
  });

  bus.on('omp.disconnected', ({ reason }) => {
    store.set({ ompStatus: 'disconnected', ompError: reason });
  });

  bus.on('omp.error', ({ error }) => {
    store.set({ ompStatus: 'error', ompError: error });
  });

  /* ---- Helpers for building event scripts ------------------------------ */
  function makeStreamingScript(text, chunkSize = 8, msPerChunk = 80) {
    const events = [{ at: 0, type: 'thinking.start' }];
    let offset = 0;
    let time = 200;

    while (offset < text.length) {
      const chunk = text.slice(offset, offset + chunkSize);
      events.push({ at: time, type: 'thinking.delta', payload: { text: chunk } });
      offset += chunkSize;
      time += msPerChunk;
    }

    events.push({
      at: time + 100,
      type: 'thinking.complete',
      payload: { tokCount: Math.floor(text.length / 3.5), durationMs: time },
    });

    return events;
  }

  function makeToolSequence(tools, startAt = 0) {
    const events = [];
    let time = startAt;

    tools.forEach((t, i) => {
      const id = `tool-${Date.now()}-${i}`;
      events.push({
        at: time,
        type: 'tool.call',
        payload: { id, tool: t.tool, target: t.target, params: t.params },
      });

      time += t.duration || 600;

      if (t.fail) {
        events.push({
          at: time,
          type: 'tool.fail',
          payload: { id, error: t.error || 'Unknown error' },
        });
      } else {
        events.push({
          at: time,
          type: 'tool.complete',
          payload: { id, output: t.output, durationMs: t.duration || 600 },
        });
      }

      time += 100;
    });

    return events;
  }


  OMP.mod['js/bus'] = { makeStreamingScript, makeToolSequence, bus };
})(window.OMP = window.OMP || { mod: {} });
