// components/ui/OnboardingTour.tsx — Spotlight-style onboarding tour
//
// Self-contained component. No external dependencies.
// Highlights UI elements one at a time with a dark overlay + spotlight cutout.

import { useState, useEffect, useCallback, useRef } from "react";
import { useI18n, type TranslationKey } from "../../lib/i18n";

// ─── Types ────────────────────────────────────────────────

interface TourStep {
  target: string; // CSS selector for the element to highlight
  title: TranslationKey;
  description: TranslationKey;
  placement: "top" | "bottom" | "left" | "right" | "center";
}

interface OnboardingTourProps {
  onClose: () => void;
}

// ─── Steps ────────────────────────────────────────────────

const TOUR_STEPS: TourStep[] = [
  {
    target: ".welcome",
    title: "tour.welcome.title",
    description: "tour.welcome.description",
    placement: "center",
  },
  {
    target: ".sidebar-section",
    title: "tour.profiles.title",
    description: "tour.profiles.description",
    placement: "right",
  },
  {
    target: ".sidebar-action-btn-primary",
    title: "tour.newProfile.title",
    description: "tour.newProfile.description",
    placement: "bottom",
  },
  {
    target: ".sidebar-actions-row",
    title: "tour.importExport.title",
    description: "tour.importExport.description",
    placement: "bottom",
  },
  {
    target: ".sidebar-search",
    title: "tour.search.title",
    description: "tour.search.description",
    placement: "right",
  },
  {
    target: ".app-content",
    title: "tour.workspace.title",
    description: "tour.workspace.description",
    placement: "left",
  },
  {
    target: ".statusbar",
    title: "tour.statusBar.title",
    description: "tour.statusBar.description",
    placement: "top",
  },
];

const STORAGE_KEY = "nexterm-onboarding-completed";
const SPOTLIGHT_PADDING = 8;
const TOOLTIP_GAP = 12;

// ─── Component ────────────────────────────────────────────

export function OnboardingTour({ onClose }: OnboardingTourProps) {
  const { t } = useI18n();
  const [currentStep, setCurrentStep] = useState(0);
  const [targetRect, setTargetRect] = useState<DOMRect | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  const step = TOUR_STEPS[currentStep];
  const isWelcome = step?.placement === "center";
  const isLastStep = currentStep === TOUR_STEPS.length - 1;

  // ── Calculate target position ───────────────────────────

  const updateTargetRect = useCallback(() => {
    const currentStepDef = TOUR_STEPS[currentStep];
    if (!currentStepDef || currentStepDef.placement === "center") {
      setTargetRect(null);
      return;
    }
    const el = document.querySelector(currentStepDef.target);
    if (el) {
      setTargetRect(el.getBoundingClientRect());
    } else {
      setTargetRect(null);
    }
  }, [currentStep]);

  useEffect(() => {
    updateTargetRect();
  }, [updateTargetRect]);

  useEffect(() => {
    window.addEventListener("resize", updateTargetRect);
    return () => window.removeEventListener("resize", updateTargetRect);
  }, [updateTargetRect]);

  // ── Keyboard navigation ─────────────────────────────────

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        handleClose();
      } else if (e.key === "ArrowRight" || e.key === "Enter") {
        handleNext();
      } else if (e.key === "ArrowLeft") {
        handleBack();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  // ── Navigation handlers ─────────────────────────────────

  function handleNext() {
    if (isLastStep) {
      handleClose();
    } else {
      setCurrentStep((s) => s + 1);
    }
  }

  function handleBack() {
    if (currentStep > 0) {
      setCurrentStep((s) => s - 1);
    }
  }

  function handleClose() {
    localStorage.setItem(STORAGE_KEY, "true");
    onClose();
  }

  // ── Tooltip positioning ─────────────────────────────────

  function getTooltipStyle(): React.CSSProperties {
    if (!targetRect || !step || step.placement === "center") return {};

    const style: React.CSSProperties = { position: "fixed" };

    switch (step.placement) {
      case "right":
        style.left = targetRect.right + SPOTLIGHT_PADDING + TOOLTIP_GAP;
        style.top = targetRect.top + targetRect.height / 2;
        style.transform = "translateY(-50%)";
        break;
      case "left":
        style.right =
          window.innerWidth - targetRect.left + SPOTLIGHT_PADDING + TOOLTIP_GAP;
        style.top = targetRect.top + targetRect.height / 2;
        style.transform = "translateY(-50%)";
        break;
      case "bottom":
        style.top = targetRect.bottom + SPOTLIGHT_PADDING + TOOLTIP_GAP;
        style.left = targetRect.left + targetRect.width / 2;
        style.transform = "translateX(-50%)";
        break;
      case "top":
        style.bottom =
          window.innerHeight - targetRect.top + SPOTLIGHT_PADDING + TOOLTIP_GAP;
        style.left = targetRect.left + targetRect.width / 2;
        style.transform = "translateX(-50%)";
        break;
    }

    return style;
  }

  if (!step) return null;

  // ── Welcome step (centered modal) ──────────────────────

  if (isWelcome) {
    return (
      <div className="tour-welcome">
        <div className="tour-welcome-card">
          <div className="tour-welcome-title">{t(step.title)}</div>
          <div className="tour-welcome-description">{t(step.description)}</div>
          <div className="tour-welcome-actions">
            <button className="tour-tooltip-btn" onClick={handleClose}>
              {t("tour.skip")}
            </button>
            <button
              className="tour-tooltip-btn tour-tooltip-btn-primary"
              onClick={handleNext}
            >
              {t("tour.next")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Spotlight step ─────────────────────────────────────

  return (
    <>
      {/* Clickable overlay to skip */}
      <div className="tour-overlay" onClick={handleClose} />

      {/* Spotlight cutout */}
      {targetRect && (
        <div
          className="tour-spotlight"
          style={{
            top: targetRect.top - SPOTLIGHT_PADDING,
            left: targetRect.left - SPOTLIGHT_PADDING,
            width: targetRect.width + SPOTLIGHT_PADDING * 2,
            height: targetRect.height + SPOTLIGHT_PADDING * 2,
          }}
        />
      )}

      {/* Tooltip */}
      <div
        ref={tooltipRef}
        className="tour-tooltip"
        style={getTooltipStyle()}
      >
        {/* Arrow */}
        <div
          className={`tour-tooltip-arrow tour-tooltip-arrow-${getArrowPosition(step.placement)}`}
        />
        <div className="tour-tooltip-title">{t(step.title)}</div>
        <div className="tour-tooltip-description">{t(step.description)}</div>
        <div className="tour-tooltip-footer">
          <span className="tour-tooltip-steps">
            {t("tour.stepOf", {
              current: currentStep + 1,
              total: TOUR_STEPS.length,
            })}
          </span>
          <div className="tour-tooltip-actions">
            {currentStep > 0 && (
              <button className="tour-tooltip-btn" onClick={handleBack}>
                {t("tour.back")}
              </button>
            )}
            <button
              className="tour-tooltip-btn tour-tooltip-btn-primary"
              onClick={handleNext}
            >
              {isLastStep ? t("tour.done") : t("tour.next")}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// ── Helpers ───────────────────────────────────────────────

/** Returns the arrow CSS class suffix based on tooltip placement.
 *  The arrow points TOWARD the target, so it's on the opposite side. */
function getArrowPosition(
  placement: TourStep["placement"],
): "top" | "bottom" | "left" | "right" {
  switch (placement) {
    case "right":
      return "right"; // arrow on left side of tooltip, pointing left
    case "left":
      return "left"; // arrow on right side of tooltip, pointing right
    case "bottom":
      return "bottom"; // arrow on top of tooltip, pointing up
    case "top":
      return "top"; // arrow on bottom of tooltip, pointing down
    default:
      return "bottom";
  }
}
