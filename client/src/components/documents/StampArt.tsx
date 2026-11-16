// Stamps and the logo drawn on screen from the same pieces the signed PDF uses (shared/stamps.ts),
// so what you place is what prints. Also used for the small previews in the stamp gallery.
import {
  BRAND_CIRCLES, BRAND_PATHS, BRAND_TEAL, BRAND_VIEW, DARK_TEXT, MUTED_TEXT, logoPrims, stampPrims, type MarkDesign, type Prim, type PrimColor,
} from "@shared/stamps";

const FONT = "Helvetica, Arial, sans-serif";

function Brand({ x, y, size }: { x: number; y: number; size: number }) {
  const k = size / BRAND_VIEW.size;
  return (
    <g transform={`translate(${x} ${y}) scale(${k}) translate(${-BRAND_VIEW.x} ${-BRAND_VIEW.y})`}>
      {BRAND_PATHS.map((p, i) => <path key={i} d={p.d} fill="none" stroke={p.color} strokeWidth={p.width} strokeLinecap="round" strokeLinejoin="round" />)}
      {BRAND_CIRCLES.map((c, i) => <circle key={i} cx={c.cx} cy={c.cy} r={c.r} fill={c.fill ?? "none"} stroke={c.stroke ?? "none"} strokeWidth={c.width} />)}
    </g>
  );
}

const colorOf = (c: PrimColor | undefined, ink: string) => (c === "brand" ? BRAND_TEAL : c === "dark" ? DARK_TEXT : c === "muted" ? MUTED_TEXT : ink);

function Pieces({ prims, ink, see }: { prims: Prim[]; ink: string; see: number }) {
  return (
    <>
      {prims.map((p, i) => {
        if (p.t === "rect") return <rect key={i} x={p.x} y={p.y} width={p.w} height={p.h} rx={p.r} fill="none" stroke={ink} strokeWidth={p.stroke} strokeOpacity={see} />;
        if (p.t === "circle") return <circle key={i} cx={p.cx} cy={p.cy} r={p.r} fill="none" stroke={ink} strokeWidth={p.stroke} strokeOpacity={see} />;
        if (p.t === "line") return <line key={i} x1={p.x1} y1={p.y1} x2={p.x2} y2={p.y2} stroke={ink} strokeWidth={p.stroke} strokeOpacity={see} />;
        if (p.t === "brand") return <Brand key={i} x={p.x} y={p.y} size={p.size} />;
        return (
          <text key={i} x={p.x} y={p.y} fontSize={p.size} fontFamily={FONT} fontWeight={p.bold ? 700 : 400} textAnchor={p.anchor} fill={colorOf(p.color, ink)} fillOpacity={p.color ? 1 : see}
            transform={p.rotate ? `rotate(${p.rotate} ${p.x} ${p.y})` : undefined} style={{ whiteSpace: "pre" }}>
            {p.text}
          </text>
        );
      })}
    </>
  );
}

/** A stamp (`kind` "stamp") or the logo (`kind` "logo"), filling its box. `w` × `h` are the box's size in points. */
export function StampArt({ type, w, h, value, design, ink, className }: {
  type: "stamp" | "logo"; w: number; h: number; value?: string | null; design?: MarkDesign | null; ink: string; className?: string;
}) {
  const prims = type === "logo" ? logoPrims({ w, h, design }) : stampPrims({ w, h, value, design });
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="xMidYMid meet" className={className ?? "h-full w-full overflow-visible"} aria-hidden="true">
      <Pieces prims={prims} ink={ink} see={type === "stamp" ? 0.9 : 1} />
    </svg>
  );
}
