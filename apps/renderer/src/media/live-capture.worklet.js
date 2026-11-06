/* The audio thread owns the partial frame; drain returns it before acknowledging shutdown. */
class StudioLiveCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Float32Array(320);
    this.offset = 0;
    this.pending = 0;
    this.stopped = false;
    this.port.onmessage = event => {
      if (event.data === "ack") this.pending = Math.max(0, this.pending - 1);
      else if (event.data === "stop") this.stopped = true;
      else if (event.data === "drain") {
        this.stopped = true;
        if (this.offset) this.send(this.samples.slice(0, this.offset));
        this.offset = 0;
        this.port.postMessage({ drained: true });
      }
    };
  }
  send(samples) {
    if (this.pending >= 5) {
      this.port.postMessage({ error: "Audio connection cannot keep up" });
      this.stopped = true;
      return false;
    }
    const bytes = samples.buffer;
    this.port.postMessage({ bytes }, [bytes]);
    this.pending++;
    return true;
  }
  process(inputs) {
    if (this.stopped) return true;
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let value = 0;
      for (const channel of channels) value += channel[i] || 0;
      this.samples[this.offset++] = Math.max(-1, Math.min(1, value / channels.length));
      if (this.offset !== this.samples.length) continue;
      if (!this.send(this.samples)) return true;
      this.samples = new Float32Array(320);
      this.offset = 0;
    }
    return true;
  }
}
registerProcessor("omp-studio-live-capture", StudioLiveCapture);
