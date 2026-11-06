import { useCallback, useEffect, useRef, useState } from "react";
import { openPcmCapture, type PcmCapture } from "./liveCapture";
import { ensureMicrophoneAccess, microphoneFailureMessage } from "./microphoneAccess";
import { hostErrorMessage } from "../hostError";

export function useMicrophoneTest(zh: boolean, deviceId: string, visible: boolean, demo = false) {
  const [testing, setTesting] = useState(false);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState("");
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const generation = useRef(0);
  const capture = useRef<PcmCapture | undefined>(undefined);
  const abort = useRef<AbortController | undefined>(undefined);
  const stop = useCallback(() => {
    generation.current++;
    abort.current?.abort();
    capture.current?.stop();
    capture.current = undefined;
    setTesting(false);
    setLevel(0);
  }, []);
  const refresh = useCallback(async () => {
    if (demo || !navigator.mediaDevices?.enumerateDevices) return;
    try { setDevices((await navigator.mediaDevices.enumerateDevices()).filter(row => row.kind === "audioinput")); }
    catch (cause) { setError(hostErrorMessage(cause, zh ? "无法读取麦克风设备" : "Could not list microphones")); }
  }, [demo, zh]);
  useEffect(() => {
    if (!visible) stop();
    else void refresh();
    const hide = () => { if (document.hidden) stop(); };
    document.addEventListener("visibilitychange", hide);
    navigator.mediaDevices?.addEventListener?.("devicechange", refresh);
    return () => { stop(); document.removeEventListener("visibilitychange", hide); navigator.mediaDevices?.removeEventListener?.("devicechange", refresh); };
  }, [visible, deviceId, stop, refresh]);
  useEffect(() => {
    if (!testing) return;
    const timer = setTimeout(stop, 10000);
    return () => clearTimeout(timer);
  }, [testing, stop]);
  const start = async () => {
    if (testing || !visible || demo) return;
    const epoch = ++generation.current;
    const controller = new AbortController();
    abort.current = controller;
    setTesting(true); setError("");
    try {
      await ensureMicrophoneAccess(zh);
      controller.signal.throwIfAborted();
      const input = await openPcmCapture({ signal: controller.signal, ...(deviceId ? { deviceId } : {}), onFrame: async () => {}, onLevel: setLevel, onFault: message => { stop(); setError(message); } });
      if (epoch !== generation.current) { input.stop(); return; }
      capture.current = input;
      void refresh();
    } catch (cause) {
      if (epoch === generation.current) { stop(); setError(microphoneFailureMessage(cause, zh) ?? hostErrorMessage(cause, zh ? "麦克风测试失败" : "Microphone test failed")); }
    }
  };
  return { testing, level, error, devices, start, stop, refresh };
}
