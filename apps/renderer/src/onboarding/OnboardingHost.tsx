import { useCallback, useEffect, useState, type ReactNode } from "react";
import { lazyPanel } from "../DeferredPanel";
import { StartupNotice } from "../StartupNotice";
import { closeOnboardingTour, markOnboardingCompleted, openOnboardingTour, shouldAutoOpenOnboarding, useOnboardingTourMode } from "./onboardingState";

const OnboardingTour = lazyPanel(() => import("./OnboardingTour").then(module => ({ default: module.OnboardingTour })));

export function OnboardingHost(): ReactNode {
  const mode = useOnboardingTourMode();
  const [noticeReady, setNoticeReady] = useState(() => !shouldAutoOpenOnboarding());
  useEffect(() => {
    if (shouldAutoOpenOnboarding()) openOnboardingTour("first-run");
  }, []);
  const onClose = useCallback((completed: boolean) => {
    if (completed) markOnboardingCompleted();
    closeOnboardingTour();
    setNoticeReady(true);
  }, []);
  return (
    <>
      {mode !== null ? <OnboardingTour mode={mode} onClose={onClose} /> : null}
      {noticeReady ? <StartupNotice /> : null}
    </>
  );
}
