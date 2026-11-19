'use client';

/**
 * Ветви — отрисовка реплики с разметкой эффектов/форматирования (rtfx).
 *
 * Плеер, строки реплик на нодах и подписи исходов рендерят текст через этот
 * компонент: **жирный**, __курсив__, {#hex}цвет{/} и эффекты [[тряска]],
 * {{дрожь}}, //волна//, ::мерцание:: превращаются в спаны с классами rtfx-*.
 * Незакрытые маркеры (печатная машинка срезает текст посреди разметки)
 * считаются действующими до конца показанного текста — маркеры не мигают.
 */

import { Fragment, type CSSProperties } from 'react';

import { parseRtfx, rtfxEffectById } from '@/vetvi/core/rtfx';

/** Буква с индивидуальной фазой анимации (дрожь/волна — perLetter-эффекты). */
function RtfxLetters({ text, css }: { text: string; css: string }) {
  const chars = Array.from(text);
  return (
    <span className={'rtfx-fx ' + css} aria-label={text}>
      {chars.map((ch, i) => (
        <span
          key={i}
          className="rtfx-ch"
          style={{ ['--i' as string]: String(i), ['--a' as string]: String(0.45 + ((ch.codePointAt(0) || 65) % 7) / 10) } as CSSProperties}
          aria-hidden="true"
        >
          {ch === ' ' ? '\u00A0' : ch}
        </span>
      ))}
    </span>
  );
}

export function RtfxView({ text }: { text: string }) {
  const spans = parseRtfx(text);
  return (
    <span className="rtfx">
      {spans.map((s, i) => {
        const e = rtfxEffectById(s.fx);
        const cls = (s.bold ? ' rt-b' : '') + (s.italic ? ' rt-i' : '');
        const style = s.color ? ({ color: s.color } as CSSProperties) : undefined;
        if (!e) {
          return <span key={i} className={cls.trim() || undefined} style={style}>{s.text}</span>;
        }
        if (e.perLetter) {
          return (
            <Fragment key={i}>
              <span className={cls.trim() || undefined} style={style}>
                <RtfxLetters text={s.text} css={e.css} />
              </span>
            </Fragment>
          );
        }
        return (
          <span key={i} className={(cls + ' rtfx-fx ' + e.css).trim()} style={style}>{s.text}</span>
        );
      })}
    </span>
  );
}
