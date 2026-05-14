// Three-dot pulsing loader — ported 1:1 from the web at
// components/chat/message-bubble.tsx::DotsLoader.
//
// Three 4×4 white circles, each pulses scale 0.6→1→0.6 with opacity
// 0.4→1→0.4. Delays staggered 0s / 0.2s / 0.4s on a 1.4s loop.
// Used wherever the desktop wants "AI is processing" inline next
// to the computer avatar.

export function DotsLoader() {
  return (
    <span style={{ display: "inline-flex", gap: 2, alignItems: "center" }}>
      <span style={dot} />
      <span style={{ ...dot, animationDelay: "0.2s" }} />
      <span style={{ ...dot, animationDelay: "0.4s" }} />
      <style>{`
        @keyframes dotPulse {
          0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; }
          40%           { transform: scale(1);   opacity: 1; }
        }
      `}</style>
    </span>
  );
}

const dot: React.CSSProperties = {
  width: 4,
  height: 4,
  borderRadius: "50%",
  background: "rgba(255,255,255,0.5)",
  display: "inline-block",
  animation: "dotPulse 1.4s ease-in-out infinite",
};
