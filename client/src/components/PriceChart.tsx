import { useMemo, useState } from 'react';
import type { Bar } from '../api';
import { compact, day, num } from '../format';

type Props = { bars: Bar[]; kind: 'candle' | 'line'; showVolume: boolean; label: string };

const W = 720;
const H = 300;
const PAD = { l: 8, r: 64, t: 12, b: 24 };
const VOL_H = 54;

function ticks(lo: number, hi: number, n = 4) {
  const span = hi - lo || Math.abs(hi) || 1;
  const raw = span / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(v);
  return out;
}

/** Candles or a close line over the bars, with an optional volume strip. Pure SVG, no library. */
export function PriceChart({ bars, kind, showVolume, label }: Props) {
  const [hover, setHover] = useState<number | null>(null);
  const g = useMemo(() => {
    const vol = showVolume && bars.some((b) => (b.v ?? 0) > 0);
    const priceBottom = H - PAD.b - (vol ? VOL_H + 8 : 0);
    const lo = Math.min(...bars.map((b) => (kind === 'candle' ? b.l : b.c)));
    const hi = Math.max(...bars.map((b) => (kind === 'candle' ? b.h : b.c)));
    const pad = (hi - lo) * 0.06 || hi * 0.01 || 1;
    const y0 = lo - pad;
    const y1 = hi + pad;
    const plotW = W - PAD.l - PAD.r;
    const step = plotW / Math.max(1, bars.length);
    const x = (i: number) => PAD.l + step * (i + 0.5);
    const y = (v: number) => PAD.t + ((y1 - v) / (y1 - y0)) * (priceBottom - PAD.t);
    const vmax = vol ? Math.max(...bars.map((b) => b.v ?? 0)) : 0;
    const vy = (v: number) => H - PAD.b - (vmax ? (v / vmax) * VOL_H : 0);
    return { vol, priceBottom, y0, y1, step, x, y, vy, plotW };
  }, [bars, kind, showVolume]);

  if (bars.length < 2) return <div className="chart-empty">Not enough data in this range.</div>;

  const body = Math.max(1, Math.min(10, g.step * 0.65));
  const line = bars.map((b, i) => `${i ? 'L' : 'M'}${g.x(i).toFixed(1)},${g.y(b.c).toFixed(1)}`).join('');
  const first = bars[0].c;
  const lastUp = bars[bars.length - 1].c >= first;
  const xLabels = [0, Math.floor((bars.length - 1) / 2), bars.length - 1];
  const hb = hover == null ? null : bars[hover];

  function onMove(e: React.MouseEvent<SVGSVGElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const i = Math.round((px - PAD.l) / g.step - 0.5);
    setHover(i >= 0 && i < bars.length ? i : null);
  }

  return (
    <figure className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        {ticks(g.y0, g.y1).map((v) => (
          <g key={v}>
            <line className="grid" x1={PAD.l} x2={W - PAD.r} y1={g.y(v)} y2={g.y(v)} />
            <text className="axis" x={W - PAD.r + 6} y={g.y(v) + 4}>
              {num(v, v >= 1000 ? 0 : 2)}
            </text>
          </g>
        ))}
        {xLabels.map((i, k) => (
          <text key={k} className="axis" x={g.x(i)} y={H - 6} textAnchor={k === 0 ? 'start' : k === 2 ? 'end' : 'middle'}>
            {day(bars[i].t)}
          </text>
        ))}
        {kind === 'line' ? (
          <path className={`price-line ${lastUp ? 'up' : 'down'}`} d={line} />
        ) : (
          bars.map((b, i) => {
            const up = b.c >= b.o;
            const top = g.y(Math.max(b.o, b.c));
            const h = Math.max(1, Math.abs(g.y(b.o) - g.y(b.c)));
            return (
              <g key={b.t} className={up ? 'candle up' : 'candle down'}>
                <line x1={g.x(i)} x2={g.x(i)} y1={g.y(b.h)} y2={g.y(b.l)} />
                <rect x={g.x(i) - body / 2} y={top} width={body} height={h} />
              </g>
            );
          })
        )}
        {g.vol &&
          bars.map((b, i) => (
            <rect key={`v${b.t}`} className={`vol ${b.c >= b.o ? 'up' : 'down'}`} x={g.x(i) - body / 2} y={g.vy(b.v ?? 0)} width={body} height={H - PAD.b - g.vy(b.v ?? 0)} />
          ))}
        {hb && hover != null && (
          <g className="cross">
            <line x1={g.x(hover)} x2={g.x(hover)} y1={PAD.t} y2={H - PAD.b} />
            <line x1={PAD.l} x2={W - PAD.r} y1={g.y(hb.c)} y2={g.y(hb.c)} />
          </g>
        )}
      </svg>
      <figcaption className="chart-readout">
        {hb ? (
          <>
            <b>{day(hb.t)}</b> O {num(hb.o)} H {num(hb.h)} L {num(hb.l)} C {num(hb.c)}
            {g.vol ? ` V ${compact(hb.v)}` : ''}
          </>
        ) : (
          <span className="muted">Point at the chart to read the values.</span>
        )}
      </figcaption>
    </figure>
  );
}

/** A tiny close-price line for the symbol list. */
export function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return <svg className="spark" viewBox="0 0 80 24" />;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const d = values.map((v, i) => `${i ? 'L' : 'M'}${((i / (values.length - 1)) * 80).toFixed(1)},${(22 - ((v - lo) / (hi - lo || 1)) * 20).toFixed(1)}`).join('');
  const up = values[values.length - 1] >= values[0];
  return (
    <svg className="spark" viewBox="0 0 80 24" aria-hidden="true">
      <path className={up ? 'up' : 'down'} d={d} />
    </svg>
  );
}
