// W-Loader — canonical pixel-scan loader.
//
// 5×4 grid of cells, 10 of them are filled and pulse in a staggered
// top-to-bottom scan. Same geometry as the web's `.wl-loader` in
// `app/globals.css`, but monochrome (white-on-dark) instead of the
// lime brand variant.
//
// Usage:
//   <WLoader />              // default 12px cell
//   <WLoader cell={10} />    // smaller, for tight rows
//   <WLoader cell={16} />    // big, for full-screen empty states

interface WLoaderProps {
  /** Cell size in px (default 12). */
  cell?: number;
  /** Optional opacity for the lit cells (default 0.85). */
  opacity?: number;
}

export function WLoader({ cell = 12, opacity = 0.85 }: WLoaderProps) {
  const blocks = [
    { col: 1, row: 1, delay: "0s" },
    { col: 1, row: 2, delay: "0.16s" },
    { col: 2, row: 3, delay: "0.32s" },
    { col: 2, row: 4, delay: "0.48s" },
    { col: 3, row: 1, delay: "0s" },
    { col: 3, row: 2, delay: "0.16s" },
    { col: 4, row: 3, delay: "0.32s" },
    { col: 4, row: 4, delay: "0.48s" },
    { col: 5, row: 1, delay: "0s" },
    { col: 5, row: 2, delay: "0.16s" },
  ];
  return (
    <div
      role="status"
      aria-label="Loading"
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(5, ${cell}px)`,
        gridTemplateRows: `repeat(4, ${cell}px)`,
        gap: 2,
      }}
    >
      {blocks.map((b, i) => (
        <span
          key={i}
          style={{
            gridColumn: b.col,
            gridRow: b.row,
            width: "100%",
            height: "100%",
            background: `rgba(255, 255, 255, ${opacity})`,
            opacity: 0.25,
            animation: `wLoaderScan 1.6s infinite ease-in-out`,
            animationDelay: b.delay,
          }}
        />
      ))}
      <style>{`
        @keyframes wLoaderScan {
          0%, 55%, 100% { opacity: 0.25; transform: scaleY(1); }
          22%           { opacity: 1;    transform: scaleY(1.1); }
        }
      `}</style>
    </div>
  );
}
