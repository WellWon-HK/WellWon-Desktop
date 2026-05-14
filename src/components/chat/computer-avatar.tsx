// Computer-avatar SVG — ported 1:1 from the web version's
// ComputerAvatarSvg in components/chat/message-bubble.tsx.
// Blinking-eye animation via SMIL <animate> on the path's d attribute,
// reliably cross-browser.

export function ComputerAvatar({
  animating,
  size = 26,
}: {
  animating?: boolean;
  size?: number;
}) {
  const eyeOpen = "V159.091";
  const eyeClosed = "135.636V137.091";
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 500 410"
      fill="none"
      width={size}
      height={size}
      aria-label="Assistant"
      style={{ color: "rgba(255,255,255,0.78)", flexShrink: 0 }}
    >
      <path
        d="M386.363 22.731H113.636C88.5321 22.731 68.1814 43.0816 68.1814 68.1855V250.004C68.1814 275.108 88.5321 295.458 113.636 295.458H386.363C411.467 295.458 431.818 275.108 431.818 250.004V68.1855C431.818 43.0816 411.467 22.731 386.363 22.731Z"
        stroke="currentColor"
        strokeWidth={45.4545}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d={`M204.546 113.636${eyeOpen}`} stroke="currentColor" strokeWidth={45.4545} strokeLinecap="round" strokeLinejoin="round">
        {animating && (
          <animate
            attributeName="d"
            values={`M204.546 113.636${eyeOpen};M204.546 113.636${eyeOpen};M204.546 113.636${eyeClosed};M204.546 113.636${eyeOpen};M204.546 113.636${eyeOpen}`}
            keyTimes="0;0.82;0.9;0.96;1"
            dur="3.2s"
            repeatCount="indefinite"
          />
        )}
      </path>
      <path d={`M295.454 113.636${eyeOpen}`} stroke="currentColor" strokeWidth={45.4545} strokeLinecap="round" strokeLinejoin="round">
        {animating && (
          <animate
            attributeName="d"
            values={`M295.454 113.636${eyeOpen};M295.454 113.636${eyeOpen};M295.454 113.636${eyeClosed};M295.454 113.636${eyeOpen};M295.454 113.636${eyeOpen}`}
            keyTimes="0;0.84;0.92;0.98;1"
            dur="3.2s"
            repeatCount="indefinite"
          />
        )}
      </path>
      <path d="M22.7263 386.371H477.272" stroke="currentColor" strokeWidth={45.4545} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
